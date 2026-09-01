import assert from "node:assert/strict";
import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";
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
  const jobsModule = await import("../src/features/jobs/job-module");
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
  await admin.query("GRANT SELECT ON jobs, workspace_members TO sushua_web_test");
  await admin.query("GRANT EXECUTE ON FUNCTION submit_job_v1(uuid, uuid, text, uuid, text, text, integer, jsonb, integer, uuid, uuid, timestamptz) TO sushua_web_test");
  await admin.query("GRANT EXECUTE ON FUNCTION request_job_cancel(uuid, text) TO sushua_web_test");
  await admin.query("GRANT EXECUTE ON FUNCTION transition_job_v1(uuid, text, jsonb, jsonb, text, timestamptz, timestamptz) TO sushua_worker_test");

  const learnerId = uuidv7();
  const workspaceId = uuidv7();
  await admin.query("INSERT INTO learners (id) VALUES ($1)", [learnerId]);
  await admin.query(
    "INSERT INTO workspaces (id, slug, title, visibility, created_by_learner_id) VALUES ($1,'worker-claim','Worker Claim','private',$2)",
    [workspaceId, learnerId],
  );
  await admin.query(
    "INSERT INTO workspace_members (workspace_id, learner_id, role) VALUES ($1,$2,'owner')",
    [workspaceId, learnerId],
  );

  const webRuntime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl, "sushua_web_test"), maxConnections: 2 });
  const workerRuntime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl, "sushua_worker_test"), maxConnections: 2 });
  const context = { workspaceId, learnerId };
  const baseTime = new Date("2026-09-01T00:00:00.000Z");
  const webJobs = jobsModule.createJobModule(webRuntime, { now: () => baseTime, newId: uuidv7 });
  const workerAt = (iso: string) => jobsModule.createJobModule(workerRuntime, {
    now: () => new Date(iso),
    newId: uuidv7,
  });
  const submit = (key: string, maxAttempts = 3) => webJobs.submit(context, {
    type: "file.scan",
    resourceId: uuidv7(),
    idempotencyKey: key,
    priority: 0,
    budget: {},
    maxAttempts,
  });

  console.log("Worker Job Claim");
  const delayed = await submit("scan:delayed");
  await admin.query("UPDATE jobs SET run_after=$2 WHERE id=$1", [delayed.envelope.id, new Date("2026-09-01T00:05:00.000Z")]);
  const unprivilegedWorker = workerAt("2026-09-01T00:00:00.000Z");
  await assert.rejects(() => unprivilegedWorker.claim(delayed.envelope.id, 300), /permission denied/);
  console.log("  ✓ Worker 未显式授权时不能领取 Job");

  await admin.query("GRANT EXECUTE ON FUNCTION claim_job_v1(uuid, integer, timestamptz) TO sushua_worker_test");
  const notDue = await workerAt("2026-09-01T00:00:00.000Z").claim(delayed.envelope.id, 300);
  assert.equal(notDue.status, "not_due");
  assert.equal(notDue.job.state, "queued");
  assert.equal(notDue.job.attempt, 0);
  assert.equal(notDue.job.runAfter, "2026-09-01T00:05:00.000Z");
  console.log("  ✓ run_after 未到时不提前领取");

  const claimed = await workerAt("2026-09-01T00:05:00.000Z").claim(delayed.envelope.id, 300);
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.job.state, "running");
  assert.equal(claimed.job.attempt, 1);
  assert.equal(claimed.job.timeoutAt, "2026-09-01T00:10:00.000Z");
  assert.equal(claimed.job.workspaceId, workspaceId);
  assert.equal(claimed.job.resourceId, delayed.envelope.resourceId);
  const busy = await workerAt("2026-09-01T00:06:00.000Z").claim(delayed.envelope.id, 300);
  assert.equal(busy.status, "busy");
  assert.equal(busy.job.attempt, 1);
  console.log("  ✓ 领取只按持久 Job ID 返回权威租户/资源，活跃租约拒绝并发执行");

  const recovered = await workerAt("2026-09-01T00:10:00.000Z").claim(delayed.envelope.id, 300);
  assert.equal(recovered.status, "claimed");
  assert.equal(recovered.job.attempt, 2);
  assert.equal(recovered.job.timeoutAt, "2026-09-01T00:15:00.000Z");
  console.log("  ✓ Worker 崩溃留下的过期 running Job 可被重新领取");

  const exhausted = await submit("scan:exhausted", 1);
  await workerAt("2026-09-01T00:00:00.000Z").claim(exhausted.envelope.id, 60);
  const exhaustedResult = await workerAt("2026-09-01T00:01:00.000Z").claim(exhausted.envelope.id, 60);
  assert.equal(exhaustedResult.status, "ignored");
  assert.equal(exhaustedResult.job.state, "dead_lettered");
  assert.equal(exhaustedResult.job.errorCode, "job_lease_exhausted");
  console.log("  ✓ 过期租约超过最大尝试后进入 dead_lettered，不伪造重试");

  const cancelled = await submit("scan:cancelled");
  await webJobs.requestCancel({ learnerId }, cancelled.envelope.id, "user_requested");
  const cancellationClock = await admin.query<{ event_at: Date }>("SELECT clock_timestamp() AS event_at");
  const cancellationEventAt = cancellationClock.rows[0]?.event_at;
  assert.ok(cancellationEventAt);
  const cancelledResult = await workerAt(cancellationEventAt.toISOString()).claim(cancelled.envelope.id, 300);
  assert.equal(cancelledResult.status, "ignored");
  assert.equal(cancelledResult.job.state, "cancelled");
  assert.equal(cancelledResult.job.attempt, 0);
  assert.equal((await workerAt(new Date(cancellationEventAt.getTime() + 1_000).toISOString())
    .claim(cancelled.envelope.id, 300)).status, "ignored");
  console.log("  ✓ 取消请求在领取 seam 内收敛，终态重放幂等忽略");

  await assert.rejects(
    () => workerAt("2026-09-01T00:00:00.000Z").claim(uuidv7(), 300),
    /job_not_found/,
  );
  await assert.rejects(
    () => workerAt("2026-09-01T00:00:00.000Z").claim(delayed.envelope.id, 0),
    /invalid_job_lease/,
  );
  console.log("  ✓ 不存在 Job 与非法租约失败关闭");

  await webRuntime.close();
  await workerRuntime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
