import assert from "node:assert/strict";
import { v7 as uuidv7 } from "uuid";

const configuredRedisUrl = process.env.TEST_REDIS_URL;
if (!configuredRedisUrl) throw new Error("TEST_REDIS_URL is required");
const redisUrl: string = configuredRedisUrl;

async function main() {
  const dispatcherModule = await import("../src/features/jobs/bullmq-job-dispatcher").catch(() => null);
  assert.ok(dispatcherModule, "BullMQ Job Dispatcher must exist");
  const bullmq = await import("bullmq").catch(() => null);
  assert.ok(bullmq, "BullMQ runtime dependency must exist");

  const queueName = `sushua-test-${uuidv7()}`;
  const dispatcher = dispatcherModule.createBullMqJobDispatcher({ queueName, redisUrl });
  const inspectorConnection = dispatcherModule.redisConnectionFromUrl(redisUrl);
  const inspector = new bullmq.Queue(queueName, {
    connection: inspectorConnection,
  });
  const envelope = {
    schemaVersion: 1 as const,
    id: uuidv7(),
    type: "file.scan" as const,
    workspaceId: uuidv7(),
    learnerId: uuidv7(),
    resourceId: uuidv7(),
    idempotencyKey: "file.scan:asset-001",
    traceId: uuidv7(),
    requestedAt: "2026-09-01T15:00:00.000Z",
    priority: 0,
    budget: {},
  };

  try {
    console.log("BullMQ Job Dispatcher");
    await dispatcher.dispatch(envelope);
    await dispatcher.dispatch(envelope);
    const job = await inspector.getJob(envelope.id);
    assert.ok(job);
    assert.equal(job.id, envelope.id);
    assert.equal(job.name, "file.scan");
    assert.deepEqual(job.data, envelope);
    const counts = await inspector.getJobCounts("wait", "prioritized", "active", "completed", "failed", "delayed");
    assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), 1);
    console.log("  ✓ 同一持久 Job Envelope 重放只产生一个 Redis Job，payload 不含原文");
  } finally {
    await inspector.obliterate({ force: true }).catch(() => undefined);
    await inspector.close();
    await inspectorConnection.quit().catch(() => undefined);
    await dispatcher.close();
  }
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
