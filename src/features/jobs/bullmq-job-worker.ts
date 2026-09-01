import {
  DelayedError,
  UnrecoverableError,
  Worker,
  type Job,
} from "bullmq";
import type { JobEnvelope, JobType } from "@sushua/job-contracts";
import { redisConnectionFromUrl } from "./bullmq-job-dispatcher";
import type { JobModule, JobSnapshot } from "./job-module";

type ProgressUpdate = {
  phase: string;
  percent: number;
  current?: number;
  total?: number;
  messageCode?: string;
};

export type JobHandler = (context: {
  job: JobSnapshot;
  signal: AbortSignal;
  reportProgress(progress: ProgressUpdate, checkpoint?: Record<string, unknown>): Promise<void>;
}) => Promise<{ checkpoint?: Record<string, unknown> }>;

export class JobExecutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number;

  constructor(code: string, input: { retryable: boolean; retryAfterMs?: number }) {
    if (!/^[a-z][a-z0-9_.-]{0,119}$/.test(code)) throw new Error("invalid_job_execution_error_code");
    const retryAfterMs = input.retryAfterMs ?? 1_000;
    if (!Number.isInteger(retryAfterMs) || retryAfterMs < 1 || retryAfterMs > 3_600_000) {
      throw new Error("invalid_job_retry_delay");
    }
    super(code);
    this.name = "JobExecutionError";
    this.code = code;
    this.retryable = input.retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export function createBullMqJobWorker(input: {
  queueName: string;
  redisUrl: string;
  jobs: JobModule;
  handlers: Partial<Record<JobType, JobHandler>>;
  leaseSeconds: number;
  concurrency?: number;
  now?: () => Date;
  onError(error: Error): void;
}) {
  if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(input.queueName)) throw new Error("invalid_job_queue_name");
  if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 1 || input.leaseSeconds > 3600) {
    throw new Error("invalid_job_lease");
  }
  const concurrency = input.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new Error("invalid_job_worker_concurrency");
  }
  const now = input.now ?? (() => new Date());
  const connection = redisConnectionFromUrl(input.redisUrl);
  const worker = new Worker<JobEnvelope, { state: string }>(
    input.queueName,
    async (queueJob, token, signal) => processJob({
      queueJob,
      token,
      signal: signal ?? new AbortController().signal,
      jobs: input.jobs,
      handlers: input.handlers,
      leaseSeconds: input.leaseSeconds,
      now,
    }),
    {
      connection,
      concurrency,
    },
  );
  worker.on("error", input.onError);

  let closed = false;
  return {
    waitUntilReady: () => worker.waitUntilReady(),
    async close() {
      if (closed) return;
      closed = true;
      await worker.close();
      await connection.quit().catch(() => undefined);
    },
  };
}

async function processJob(input: {
  queueJob: Job<JobEnvelope, { state: string }>;
  token?: string;
  signal: AbortSignal;
  jobs: JobModule;
  handlers: Partial<Record<JobType, JobHandler>>;
  leaseSeconds: number;
  now: () => Date;
}): Promise<{ state: string }> {
  if (!input.queueJob.id) throw new UnrecoverableError("invalid_redis_job_id");
  const claim = await input.jobs.claim(input.queueJob.id, input.leaseSeconds);
  if (claim.status === "ignored") return { state: claim.job.state };
  if (claim.status === "not_due") {
    return moveToDelayed(input.queueJob, Date.parse(claim.job.runAfter), input.token);
  }
  if (claim.status === "busy") {
    if (!claim.job.timeoutAt) throw new UnrecoverableError("missing_job_lease");
    return moveToDelayed(input.queueJob, Date.parse(claim.job.timeoutAt), input.token);
  }

  const handler = input.handlers[claim.job.type];
  if (!handler) {
    await input.jobs.apply(claim.job.id, { type: "fail", errorCode: "unsupported_job_type" });
    throw new UnrecoverableError("unsupported_job_type");
  }

  let result: { checkpoint?: Record<string, unknown> };
  try {
    result = await handler({
      job: claim.job,
      signal: input.signal,
      reportProgress: async (progress, checkpoint) => {
        await input.jobs.apply(claim.job.id, {
          type: "progress",
          progress,
          ...(checkpoint ? { checkpoint } : {}),
        });
      },
    });
  } catch (error) {
    const executionError = error instanceof JobExecutionError
      ? error
      : new JobExecutionError("job_handler_failed", { retryable: true });
    if (!executionError.retryable) {
      await input.jobs.apply(claim.job.id, { type: "fail", errorCode: executionError.code });
      throw new UnrecoverableError(executionError.code);
    }
    if (claim.job.attempt >= claim.job.maxAttempts) {
      await input.jobs.apply(claim.job.id, { type: "dead_letter", errorCode: executionError.code });
      throw new UnrecoverableError(executionError.code);
    }
    const retryAt = new Date(input.now().getTime() + executionError.retryAfterMs);
    await input.jobs.apply(claim.job.id, { type: "retry", errorCode: executionError.code, runAfter: retryAt });
    return moveToDelayed(input.queueJob, retryAt.getTime(), input.token);
  }

  const succeeded = await input.jobs.apply(claim.job.id, {
    type: "succeed",
    ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}),
  });
  return { state: succeeded.state };
}

async function moveToDelayed(
  job: Job<JobEnvelope, { state: string }>,
  timestamp: number,
  token?: string,
): Promise<never> {
  if (!Number.isFinite(timestamp)) throw new UnrecoverableError("invalid_job_schedule");
  await job.moveToDelayed(timestamp, token);
  throw new DelayedError();
}
