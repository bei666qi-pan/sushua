import assert from "node:assert/strict";
import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";
import { Queue, QueueEvents } from "bullmq";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";
import { createBullMqJobDispatcher, redisConnectionFromUrl } from "../src/features/jobs/bullmq-job-dispatcher";
import { createJobModule, type JobSnapshot } from "../src/features/jobs/job-module";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;
const configuredRedisUrl = process.env.TEST_REDIS_URL;
if (!configuredRedisUrl) throw new Error("TEST_REDIS_URL is required");
const redisUrl: string = configuredRedisUrl;
const JOB_COMPLETION_TIMEOUT_MS = 15_000;

function roleUrl(source: string, role: string) {
  const url = new URL(source);
  url.username = role;
  url.password = "integration-only";
  return url.toString();
}

async function main() {
  const workerModule = await import("../src/features/jobs/bullmq-job-worker");
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
    "INSERT INTO workspaces (id, slug, title, visibility, created_by_learner_id) VALUES ($1,'worker-runtime','Worker Runtime','private',$2)",
    [workspaceId, learnerId],
  );
  await admin.query("INSERT INTO workspace_members (workspace_id, learner_id, role) VALUES ($1,$2,'owner')", [workspaceId, learnerId]);

  const webRuntime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl, "sushua_web_test"), maxConnections: 2 });
  const workerRuntime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl, "sushua_worker_test"), maxConnections: 2 });
  const webJobs = createJobModule(webRuntime);
  const workerJobs = createJobModule(workerRuntime);
  const context = { workspaceId, learnerId };
  const submit = async (key: string, maxAttempts = 3) => (await webJobs.submit(context, {
    type: "file.scan",
    resourceId: uuidv7(),
    idempotencyKey: key,
    priority: 0,
    budget: {},
    maxAttempts,
  })).envelope;

  const queueName = `sushua-worker-test-${uuidv7()}`;
  const dispatcher = createBullMqJobDispatcher({ queueName, redisUrl });
  const queueConnection = redisConnectionFromUrl(redisUrl);
  const eventsConnection = redisConnectionFromUrl(redisUrl);
  const queue = new Queue(queueName, { connection: queueConnection });
  const events = new QueueEvents(queueName, { connection: eventsConnection });
  await events.waitUntilReady();

  const retryResource = uuidv7();
  const permanentResource = uuidv7();
  const exhaustedResource = uuidv7();
  const unexpectedResource = uuidv7();
  const activeCancelResource = uuidv7();
  const calls = new Map<string, number>();
  const handled: JobSnapshot[] = [];
  const workerErrors: Error[] = [];
  let resolveActiveStart!: () => void;
  const activeStarted = new Promise<void>((resolve) => { resolveActiveStart = resolve; });
  let activeSignalAborted = false;
  const workerInput = {
    queueName,
    redisUrl,
    jobs: workerJobs,
    leaseSeconds: 1,
    onError: (error: Error) => workerErrors.push(error),
    handlers: {
      "file.scan": async ({ job, reportProgress, signal }: {
        job: JobSnapshot;
        signal: AbortSignal;
        reportProgress(progress: { phase: string; percent: number }, checkpoint?: Record<string, unknown>): Promise<void>;
      }) => {
        handled.push(job);
        calls.set(job.resourceId, (calls.get(job.resourceId) ?? 0) + 1);
        await reportProgress({ phase: "file_scan", percent: 50 }, { scanPhase: "streaming" });
        if (job.resourceId === activeCancelResource) {
          resolveActiveStart();
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              activeSignalAborted = true;
              reject(signal.reason instanceof Error ? signal.reason : new Error("job_aborted"));
            }, { once: true });
          });
        }
        if (job.resourceId === retryResource && calls.get(job.resourceId) === 1) {
          throw new workerModule.JobExecutionError("clamav_unavailable", { retryable: true, retryAfterMs: 100 });
        }
        if (job.resourceId === permanentResource) {
          throw new workerModule.JobExecutionError("malware_detected", { retryable: false });
        }
        if (job.resourceId === exhaustedResource) {
          throw new workerModule.JobExecutionError("scanner_timeout", { retryable: true, retryAfterMs: 100 });
        }
        if (job.resourceId === unexpectedResource) {
          throw new Error("private handler detail");
        }
        return { checkpoint: { scan: "clean" } };
      },
    },
  };
  let worker: ReturnType<typeof workerModule.createBullMqJobWorker> | undefined;

  try {
    console.log("BullMQ Worker Runtime");
    const authoritative = await submit("runtime:authoritative");
    await dispatcher.dispatch(authoritative);
    const authoritativeQueueJob = await queue.getJob(authoritative.id);
    assert.ok(authoritativeQueueJob);
    await authoritativeQueueJob.updateData({
      ...authoritative,
      workspaceId: uuidv7(),
      resourceId: uuidv7(),
    });
    worker = workerModule.createBullMqJobWorker(workerInput);
    await worker.waitUntilReady();
    const authoritativeResult = await authoritativeQueueJob.waitUntilFinished(events, JOB_COMPLETION_TIMEOUT_MS);
    assert.deepEqual(authoritativeResult, { state: "succeeded" });
    assert.equal(handled[0]?.workspaceId, workspaceId);
    assert.equal(handled[0]?.resourceId, authoritative.resourceId);
    const authoritativePersisted = await webJobs.read({ learnerId }, authoritative.id);
    assert.equal(authoritativePersisted?.state, "succeeded");
    assert.deepEqual(authoritativePersisted?.checkpoint, { scan: "clean" });
    console.log("  ✓ Redis payload 被篡改时仍只按 Job ID 读取 PostgreSQL 权威租户与资源");

    await authoritativeQueueJob.remove();
    await dispatcher.dispatch(authoritative);
    const replayQueueJob = await queue.getJob(authoritative.id);
    assert.ok(replayQueueJob);
    assert.deepEqual(await replayQueueJob.waitUntilFinished(events, JOB_COMPLETION_TIMEOUT_MS), { state: "succeeded" });
    assert.equal(calls.get(authoritative.resourceId), 1);
    console.log("  ✓ PostgreSQL 已成功时 Redis 重投直接收敛，不重复执行 handler");

    const delayed = await submit("runtime:not-due");
    await admin.query("UPDATE jobs SET run_after=clock_timestamp() + interval '400 milliseconds' WHERE id=$1", [delayed.id]);
    await dispatcher.dispatch(delayed);
    const delayedQueueJob = await queue.getJob(delayed.id);
    assert.ok(delayedQueueJob);
    assert.deepEqual(await delayedQueueJob.waitUntilFinished(events, JOB_COMPLETION_TIMEOUT_MS), { state: "succeeded" });
    assert.equal(calls.get(delayed.resourceId), 1);
    console.log("  ✓ 未到 run_after 的 Redis Job 延后执行而不是提前或丢弃");

    const busy = await submit("runtime:busy");
    await workerJobs.claim(busy.id, 1);
    await dispatcher.dispatch(busy);
    const busyQueueJob = await queue.getJob(busy.id);
    assert.ok(busyQueueJob);
    assert.deepEqual(await busyQueueJob.waitUntilFinished(events, JOB_COMPLETION_TIMEOUT_MS), { state: "succeeded" });
    assert.equal(calls.get(busy.resourceId), 1);
    assert.equal((await webJobs.read({ learnerId }, busy.id))?.attempt, 2);
    console.log("  ✓ 活跃租约先延后，租约到期后恢复且只执行一次 handler");

    const retryable = await submit("runtime:retryable");
    await admin.query("UPDATE jobs SET resource_id=$2 WHERE id=$1", [retryable.id, retryResource]);
    await dispatcher.dispatch(retryable);
    const retryableQueueJob = await queue.getJob(retryable.id);
    assert.ok(retryableQueueJob);
    assert.deepEqual(await retryableQueueJob.waitUntilFinished(events, JOB_COMPLETION_TIMEOUT_MS), { state: "succeeded" });
    const retriedPersisted = await webJobs.read({ learnerId }, retryable.id);
    assert.equal(retriedPersisted?.attempt, 2);
    assert.equal(retriedPersisted?.state, "succeeded");
    assert.equal(calls.get(retryResource), 2);
    console.log("  ✓ 明确可重试错误同步推进 PostgreSQL retry 与 BullMQ delayed 后再次成功");

    const permanent = await submit("runtime:permanent");
    await admin.query("UPDATE jobs SET resource_id=$2 WHERE id=$1", [permanent.id, permanentResource]);
    await dispatcher.dispatch(permanent);
    const permanentQueueJob = await queue.getJob(permanent.id);
    assert.ok(permanentQueueJob);
    await assert.rejects(
      () => permanentQueueJob.waitUntilFinished(events, JOB_COMPLETION_TIMEOUT_MS),
      /malware_detected/,
    );
    assert.equal((await webJobs.read({ learnerId }, permanent.id))?.state, "failed");
    console.log("  ✓ 永久错误不盲目重试，PostgreSQL 与 BullMQ 都明确失败");

    const exhausted = await submit("runtime:exhausted", 1);
    await admin.query("UPDATE jobs SET resource_id=$2 WHERE id=$1", [exhausted.id, exhaustedResource]);
    await dispatcher.dispatch(exhausted);
    const exhaustedQueueJob = await queue.getJob(exhausted.id);
    assert.ok(exhaustedQueueJob);
    await assert.rejects(
      () => exhaustedQueueJob.waitUntilFinished(events, JOB_COMPLETION_TIMEOUT_MS),
      /scanner_timeout/,
    );
    const exhaustedPersisted = await webJobs.read({ learnerId }, exhausted.id);
    assert.equal(exhaustedPersisted?.state, "dead_lettered");
    assert.equal(exhaustedPersisted?.errorCode, "scanner_timeout");
    console.log("  ✓ 达到 maxAttempts 的可重试错误进入 dead_lettered");

    const unexpected = await submit("runtime:unexpected", 1);
    await admin.query("UPDATE jobs SET resource_id=$2 WHERE id=$1", [unexpected.id, unexpectedResource]);
    await dispatcher.dispatch(unexpected);
    const unexpectedQueueJob = await queue.getJob(unexpected.id);
    assert.ok(unexpectedQueueJob);
    await assert.rejects(
      () => unexpectedQueueJob.waitUntilFinished(events, JOB_COMPLETION_TIMEOUT_MS),
      /job_handler_failed/,
    );
    const unexpectedPersisted = await webJobs.read({ learnerId }, unexpected.id);
    assert.equal(unexpectedPersisted?.state, "dead_lettered");
    assert.equal(unexpectedPersisted?.errorCode, "job_handler_failed");
    assert.notEqual(unexpectedPersisted?.errorCode, "private handler detail");
    console.log("  ✓ 未知 handler 异常以安全码重试/死信，不泄露私密错误文本或遗留 running");

    const cancelled = await submit("runtime:cancelled");
    await webJobs.requestCancel({ learnerId }, cancelled.id, "user_requested");
    await dispatcher.dispatch(cancelled);
    const cancelledQueueJob = await queue.getJob(cancelled.id);
    assert.ok(cancelledQueueJob);
    assert.deepEqual(
      await cancelledQueueJob.waitUntilFinished(events, JOB_COMPLETION_TIMEOUT_MS),
      { state: "cancelled" },
    );
    assert.equal((await webJobs.read({ learnerId }, cancelled.id))?.state, "cancelled");
    assert.equal(calls.get(cancelled.resourceId), undefined);
    assert.deepEqual(workerErrors, []);
    console.log("  ✓ 取消 Job 不进入 handler，Worker 无未处理基础设施错误");

    const activeCancelled = await submit("runtime:active-cancel");
    await admin.query("UPDATE jobs SET resource_id=$2 WHERE id=$1", [activeCancelled.id, activeCancelResource]);
    await dispatcher.dispatch(activeCancelled);
    const activeCancelledQueueJob = await queue.getJob(activeCancelled.id);
    assert.ok(activeCancelledQueueJob);
    await activeStarted;
    await webJobs.requestCancel({ learnerId }, activeCancelled.id, "user_requested");
    assert.deepEqual(
      await activeCancelledQueueJob.waitUntilFinished(events, JOB_COMPLETION_TIMEOUT_MS),
      { state: "cancelled" },
    );
    assert.equal(activeSignalAborted, true);
    assert.equal((await webJobs.read({ learnerId }, activeCancelled.id))?.state, "cancelled");
    console.log("  ✓ 执行中取消由数据库心跳观察并主动中止 handler 的 AbortSignal");
  } finally {
    await worker?.close();
    await queue.obliterate({ force: true }).catch(() => undefined);
    await events.close();
    await queue.close();
    await eventsConnection.quit().catch(() => undefined);
    await queueConnection.quit().catch(() => undefined);
    await dispatcher.close();
    await webRuntime.close();
    await workerRuntime.close();
    await admin.end();
  }
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
