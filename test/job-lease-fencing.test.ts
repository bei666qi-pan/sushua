import assert from "node:assert/strict";
import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";
import { createJobModule } from "../src/features/jobs/job-module";

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
  await admin.query("GRANT EXECUTE ON FUNCTION claim_job_v2(uuid, integer) TO sushua_worker_test");
  await admin.query("GRANT EXECUTE ON FUNCTION heartbeat_job_v1(uuid, integer, integer) TO sushua_worker_test");
  await admin.query("GRANT EXECUTE ON FUNCTION transition_job_v2(uuid, integer, text, jsonb, jsonb, text, timestamptz) TO sushua_worker_test");

  const learnerId = uuidv7();
  const workspaceId = uuidv7();
  await admin.query("INSERT INTO learners (id) VALUES ($1)", [learnerId]);
  await admin.query(
    "INSERT INTO workspaces (id, slug, title, visibility, created_by_learner_id) VALUES ($1,'lease-fencing','Lease Fencing','private',$2)",
    [workspaceId, learnerId],
  );
  await admin.query("INSERT INTO workspace_members (workspace_id, learner_id, role) VALUES ($1,$2,'owner')", [workspaceId, learnerId]);

  const webRuntime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl, "sushua_web_test"), maxConnections: 2 });
  const workerRuntime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl, "sushua_worker_test"), maxConnections: 2 });
  const webJobs = createJobModule(webRuntime, { newId: uuidv7 });
  // A poisoned application clock proves that claim/heartbeat timestamps come from PostgreSQL.
  const workerJobs = createJobModule(workerRuntime, { now: () => new Date("2099-01-01T00:00:00.000Z"), newId: uuidv7 });
  const created = await webJobs.submit({ learnerId, workspaceId }, {
    type: "file.scan",
    resourceId: uuidv7(),
    idempotencyKey: "lease:fenced",
    priority: 0,
    budget: {},
    maxAttempts: 3,
  });

  console.log("数据库时钟租约与 attempt fencing");
  const beforeClaim = Date.now();
  const first = await workerJobs.claim(created.envelope.id, 30);
  const afterClaim = Date.now();
  assert.equal(first.status, "claimed");
  assert.equal(first.job.attempt, 1);
  assert.ok(first.job.timeoutAt);
  assert.ok(Date.parse(first.job.timeoutAt) >= beforeClaim + 29_000);
  assert.ok(Date.parse(first.job.timeoutAt) <= afterClaim + 31_000);
  console.log("  ✓ 应用时钟被污染时，领取租约仍使用 PostgreSQL 时钟");

  const heartbeat = await workerJobs.heartbeat(first.job.id, first.job.attempt, 60);
  assert.equal(heartbeat.status, "active");
  assert.equal(heartbeat.job.attempt, 1);
  assert.ok(heartbeat.job.timeoutAt);
  assert.ok(Date.parse(heartbeat.job.timeoutAt) >= Date.now() + 59_000);
  console.log("  ✓ 当前 attempt 可续租并取得权威状态");

  await admin.query("UPDATE jobs SET timeout_at=clock_timestamp() - interval '1 second' WHERE id=$1", [first.job.id]);
  await assert.rejects(
    () => workerJobs.apply(first.job.id, first.job.attempt, {
      type: "progress",
      progress: { phase: "expired", percent: 40 },
    }),
    /job_lease_expired/,
  );
  const second = await workerJobs.claim(first.job.id, 30);
  assert.equal(second.status, "claimed");
  assert.equal(second.job.attempt, 2);
  const staleHeartbeat = await workerJobs.heartbeat(first.job.id, 1, 60);
  assert.equal(staleHeartbeat.status, "lease_lost");
  await assert.rejects(
    () => workerJobs.apply(first.job.id, 1, {
      type: "progress",
      progress: { phase: "stale", percent: 50 },
    }),
    /stale_job_attempt/,
  );
  const progressed = await workerJobs.apply(second.job.id, second.job.attempt, {
    type: "progress",
    progress: { phase: "current", percent: 50 },
  });
  assert.equal(progressed.progress.phase, "current");
  assert.equal(progressed.attempt, 2);
  console.log("  ✓ 过期 Worker 的心跳和状态写入被 attempt fencing 拒绝");

  await webJobs.requestCancel({ learnerId }, second.job.id, "user_requested");
  const cancelledHeartbeat = await workerJobs.heartbeat(second.job.id, second.job.attempt, 60);
  assert.equal(cancelledHeartbeat.status, "cancel_requested");
  const cancelled = await workerJobs.apply(second.job.id, second.job.attempt, { type: "succeed" });
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.timeoutAt, undefined);
  console.log("  ✓ 取消与完成竞态中取消优先，当前 attempt 原子收敛 cancelled");

  await webRuntime.close();
  await workerRuntime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
