import assert from "node:assert/strict";
import { Pool } from "pg";
import { v7 as uuidv7, version as uuidVersion } from "uuid";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;

function roleUrl(source: string, role: string) {
  const url = new URL(source);
  url.username = role;
  url.password = "integration-only";
  return url.toString();
}

async function main() {
  const jobsModule = await import("../src/features/jobs/job-module").catch(() => null);
  assert.ok(jobsModule, "persistent Job Module must exist");
  assert.equal(typeof jobsModule.createJobModule, "function");

  const admin = new Pool({ connectionString: databaseUrl, max: 3 });
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await admin.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(admin);
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_web_test') THEN
      CREATE ROLE sushua_web_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_worker_test') THEN
      CREATE ROLE sushua_worker_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END $$`);
  await admin.query("GRANT USAGE ON SCHEMA public TO sushua_web_test, sushua_worker_test");

  const learnerA = uuidv7();
  const learnerB = uuidv7();
  const learnerViewer = uuidv7();
  const workspaceA = uuidv7();
  const workspaceB = uuidv7();
  await admin.query("INSERT INTO learners (id) VALUES ($1), ($2), ($3)", [learnerA, learnerB, learnerViewer]);
  await admin.query(
    `INSERT INTO workspaces (id, slug, title, visibility, created_by_learner_id) VALUES
       ($1, 'job-space-a', '任务空间 A', 'private', $2),
       ($3, 'job-space-b', '任务空间 B', 'private', $4)`,
    [workspaceA, learnerA, workspaceB, learnerB],
  );
  await admin.query(
    `INSERT INTO workspace_members (workspace_id, learner_id, role) VALUES
       ($1, $2, 'owner'), ($3, $4, 'owner'), ($1, $5, 'viewer')`,
    [workspaceA, learnerA, workspaceB, learnerB, learnerViewer],
  );

  const webRuntime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl, "sushua_web_test"), maxConnections: 2 });
  const workerRuntime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl, "sushua_worker_test"), maxConnections: 2 });
  const now = () => new Date("2026-08-31T18:00:00.000Z");
  const webJobs = jobsModule.createJobModule(webRuntime, { now, newId: uuidv7 });
  const workerJobs = jobsModule.createJobModule(workerRuntime, { now, newId: uuidv7 });
  const contextA = { learnerId: learnerA, workspaceId: workspaceA };
  const request = {
    type: "document.parse" as const,
    resourceId: uuidv7(),
    idempotencyKey: "parse:version-1",
    priority: 2,
    budget: { maxCostFen: 100, maxTokens: 5000 },
    maxAttempts: 3,
  };

  console.log("持久 Job Module");
  await assert.rejects(() => webJobs.submit(contextA, request), /permission denied/);
  console.log("  ✓ Web 未获显式函数权限时不能创建 Job");

  await admin.query("GRANT SELECT ON jobs, workspace_members TO sushua_web_test");
  await admin.query("GRANT EXECUTE ON FUNCTION submit_job_v1(uuid, uuid, text, uuid, text, text, integer, jsonb, integer, uuid, uuid, timestamptz) TO sushua_web_test");
  await admin.query("GRANT EXECUTE ON FUNCTION request_job_cancel(uuid, text) TO sushua_web_test");
  await admin.query("GRANT EXECUTE ON FUNCTION transition_job_v1(uuid, text, jsonb, jsonb, text, timestamptz, timestamptz) TO sushua_worker_test");

  const created = await webJobs.submit(contextA, request);
  assert.equal(created.status, "created");
  assert.equal(uuidVersion(created.envelope.id), 7);
  assert.deepEqual(created.envelope, {
    schemaVersion: 1,
    id: created.envelope.id,
    type: "document.parse",
    workspaceId: workspaceA,
    learnerId: learnerA,
    resourceId: request.resourceId,
    idempotencyKey: request.idempotencyKey,
    traceId: created.envelope.traceId,
    requestedAt: "2026-08-31T18:00:00.000Z",
    priority: 2,
    budget: { maxCostFen: 100, maxTokens: 5000 },
  });
  const replayed = await webJobs.submit(contextA, request);
  assert.equal(replayed.status, "replayed");
  assert.equal(replayed.envelope.id, created.envelope.id);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM jobs")).rows[0]?.count, 1);
  await assert.rejects(
    () => webJobs.submit(contextA, { ...request, resourceId: uuidv7() }),
    /job_idempotency_conflict/,
  );
  console.log("  ✓ submit 生成 UUIDv7 Envelope；相同请求重放同一 Job，不同正文冲突");

  const visibleA = await webJobs.read({ learnerId: learnerA }, created.envelope.id);
  assert.equal(visibleA?.state, "queued");
  assert.equal(await webJobs.read({ learnerId: learnerB }, created.envelope.id), undefined);
  console.log("  ✓ Job 只依据服务端 Learner 身份与持久记录受 RLS 隔离");

  const started = await workerJobs.apply(created.envelope.id, { type: "start" });
  assert.equal(started.state, "running");
  assert.equal(started.attempt, 1);
  await assert.rejects(
    () => workerRuntime.withTenant({ learnerId: uuidv7() }, ({ query }) => query(
      "SELECT transition_job_v1($1,'progress',$2,NULL,NULL,NULL,$3)",
      [created.envelope.id, {
        phase: "extract",
        percent: 5,
        updatedAt: "2026-08-31T18:00:00.000Z",
        sourceText: "private content",
      }, new Date("2026-08-31T18:00:00.000Z")],
    )),
    /invalid_job_progress/,
  );
  const staleWorkerJobs = jobsModule.createJobModule(workerRuntime, {
    now: () => new Date("2026-08-31T17:59:00.000Z"),
    newId: uuidv7,
  });
  await assert.rejects(
    () => staleWorkerJobs.apply(created.envelope.id, {
      type: "progress",
      progress: { phase: "extract", percent: 10, current: 1, total: 10 },
    }),
    /stale_job_event/,
  );
  const progressed = await workerJobs.apply(created.envelope.id, {
    type: "progress",
    progress: { phase: "extract", percent: 40, current: 4, total: 10, messageCode: "document_extracting" },
    checkpoint: { page: 4 },
  });
  assert.deepEqual(progressed.progress, {
    phase: "extract",
    percent: 40,
    current: 4,
    total: 10,
    messageCode: "document_extracting",
    updatedAt: "2026-08-31T18:00:00.000Z",
  });
  assert.deepEqual(progressed.checkpoint, { page: 4 });
  const retried = await workerJobs.apply(created.envelope.id, {
    type: "retry",
    errorCode: "document_service_unavailable",
    runAfter: new Date("2026-08-31T18:01:00.000Z"),
  });
  assert.equal(retried.state, "queued");
  assert.equal((await workerJobs.apply(created.envelope.id, { type: "start" })).attempt, 2);
  const succeeded = await workerJobs.apply(created.envelope.id, { type: "succeed", checkpoint: { page: 10 } });
  assert.equal(succeeded.state, "succeeded");
  assert.deepEqual(succeeded.checkpoint, { page: 10 });
  await assert.rejects(() => workerJobs.apply(created.envelope.id, { type: "start" }), /invalid_job_transition/);
  console.log("  ✓ Worker 从持久 Job 读取租户并执行 start/progress/retry/succeed 状态机");

  const cancellable = await webJobs.submit(contextA, { ...request, idempotencyKey: "parse:cancel", resourceId: uuidv7() });
  const cancelRequested = await webJobs.requestCancel({ learnerId: learnerA }, cancellable.envelope.id, "user_requested");
  assert.equal(cancelRequested.state, "cancel_requested");
  assert.equal((await webJobs.requestCancel({ learnerId: learnerA }, cancellable.envelope.id, "user_requested")).state, "cancel_requested");
  await assert.rejects(() => webJobs.requestCancel({ learnerId: learnerB }, cancellable.envelope.id, "not_owner"), /job_not_found/);
  await assert.rejects(() => webJobs.requestCancel({ learnerId: learnerViewer }, cancellable.envelope.id, "viewer_requested"), /job_not_found/);
  const liveWorkerJobs = jobsModule.createJobModule(workerRuntime, { now: () => new Date(), newId: uuidv7 });
  const cancelled = await liveWorkerJobs.apply(cancellable.envelope.id, { type: "cancel" });
  assert.equal(cancelled.state, "cancelled");
  console.log("  ✓ 取消请求幂等，跨租户拒绝，Worker 协作确认后进入 cancelled");

  const exhausted = await webJobs.submit(contextA, { ...request, idempotencyKey: "parse:exhausted", resourceId: uuidv7(), maxAttempts: 1 });
  await workerJobs.apply(exhausted.envelope.id, { type: "start" });
  await assert.rejects(
    () => workerJobs.apply(exhausted.envelope.id, { type: "retry", errorCode: "temporary", runAfter: now() }),
    /job_attempts_exhausted/,
  );
  assert.equal((await workerJobs.apply(exhausted.envelope.id, { type: "dead_letter", errorCode: "attempts_exhausted" })).state, "dead_lettered");
  console.log("  ✓ 超过 maxAttempts 不伪造重试，可显式进入 dead_lettered");

  await webRuntime.close();
  await workerRuntime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
