import { Queue, createNodeRedisClient, type IRedisClient } from "bullmq";
import { createClient } from "redis";
import { parseJobEnvelope, type JobEnvelope } from "@sushua/job-contracts";
import type { JobDispatcher } from "./job-dispatcher";

export function createBullMqJobDispatcher(input: {
  queueName: string;
  redisUrl: string;
}): JobDispatcher {
  if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(input.queueName)) throw new Error("invalid_job_queue_name");
  const { connection, raw } = createRedisConnection(input.redisUrl);
  const queue = new Queue<JobEnvelope>(input.queueName, {
    connection,
  });
  return {
    async dispatch(value) {
      const envelope = parseJobEnvelope(value);
      const job = await queue.add(envelope.type, envelope, {
        jobId: envelope.id,
        attempts: 1,
        priority: 11 - envelope.priority,
        removeOnComplete: false,
        removeOnFail: false,
      });
      if (job.id !== envelope.id) throw new Error("job_dispatch_identity_mismatch");
    },
    async close() {
      if (!raw.isOpen) return;
      await queue.close();
      if (raw.isOpen) await raw.quit().catch(() => undefined);
    },
  };
}

export function redisConnectionFromUrl(value: string): IRedisClient {
  return createRedisConnection(value).connection;
}

function createRedisConnection(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_redis_url");
  }
  if ((url.protocol !== "redis:" && url.protocol !== "rediss:")
    || !url.hostname
    || url.search
    || url.hash) {
    throw new Error("invalid_redis_url");
  }
  const databaseText = url.pathname.replace(/^\//, "");
  if (databaseText && !/^\d{1,3}$/.test(databaseText)) throw new Error("invalid_redis_url");
  const database = databaseText ? Number(databaseText) : 0;
  if (database > 255) throw new Error("invalid_redis_url");
  const raw = createClient({ url: url.toString() });
  return { raw, connection: createNodeRedisClient(raw) };
}
