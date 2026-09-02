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
    await input.jobs.apply(claim.job.id, claim.job.attempt, { type: "fail", errorCode: "unsupported_job_type" });
    throw new UnrecoverableError("unsupported_job_type");
  }

  const lease = createLeaseMonitor({
    jobs: input.jobs,
    job: claim.job,
    leaseSeconds: input.leaseSeconds,
    parentSignal: input.signal,
  });
  let result: { checkpoint?: Record<string, unknown> };
  let handlerError: unknown;
  try {
    result = await handler({
      job: claim.job,
      signal: lease.signal,
      reportProgress: async (progress, checkpoint) => {
        await input.jobs.apply(claim.job.id, claim.job.attempt, {
          type: "progress",
          progress,
          ...(checkpoint ? { checkpoint } : {}),
        });
      },
    });
  } catch (error) {
    handlerError = error;
    result = {};
  }

  await lease.stop();
  const control = lease.outcome === "active"
    ? await input.jobs.heartbeat(claim.job.id, claim.job.attempt, input.leaseSeconds)
    : { status: lease.outcome } as const;
  if (control.status === "cancel_requested") {
    const cancelled = await input.jobs.apply(claim.job.id, claim.job.attempt, { type: "cancel" });
    return { state: cancelled.state };
  }
  if (control.status === "lease_lost") return { state: "lease_lost" };
  if (control.status === "heartbeat_failed" || control.status === "worker_stopping") {
    throw new Error(control.status);
  }

  if (handlerError !== undefined) {
    const error = handlerError;
    const executionError = error instanceof JobExecutionError
      ? error
      : new JobExecutionError("job_handler_failed", { retryable: true });
    if (!executionError.retryable) {
      await input.jobs.apply(claim.job.id, claim.job.attempt, { type: "fail", errorCode: executionError.code });
      throw new UnrecoverableError(executionError.code);
    }
    if (claim.job.attempt >= claim.job.maxAttempts) {
      await input.jobs.apply(claim.job.id, claim.job.attempt, { type: "dead_letter", errorCode: executionError.code });
      throw new UnrecoverableError(executionError.code);
    }
    const retryAt = new Date(input.now().getTime() + executionError.retryAfterMs);
    await input.jobs.apply(claim.job.id, claim.job.attempt, { type: "retry", errorCode: executionError.code, runAfter: retryAt });
    return moveToDelayed(input.queueJob, retryAt.getTime(), input.token);
  }

  const succeeded = await input.jobs.apply(claim.job.id, claim.job.attempt, {
    type: "succeed",
    ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}),
  });
  return { state: succeeded.state };
}

type LeaseMonitorOutcome = "active" | "cancel_requested" | "lease_lost" | "heartbeat_failed" | "worker_stopping";

function createLeaseMonitor(input: {
  jobs: JobModule;
  job: JobSnapshot;
  leaseSeconds: number;
  parentSignal: AbortSignal;
}) {
  const controller = new AbortController();
  const intervalMs = Math.max(100, Math.min(5_000, Math.floor(input.leaseSeconds * 1_000 / 3)));
  let outcome: LeaseMonitorOutcome = "active";
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const abort = (next: LeaseMonitorOutcome) => {
    if (outcome !== "active") return;
    outcome = next;
    controller.abort(new Error(`job_${next}`));
  };
  const onParentAbort = () => abort("worker_stopping");
  if (input.parentSignal.aborted) onParentAbort();
  else input.parentSignal.addEventListener("abort", onParentAbort, { once: true });

  const schedule = () => {
    if (stopped || outcome !== "active") return;
    timer = setTimeout(() => {
      inFlight = input.jobs.heartbeat(input.job.id, input.job.attempt, input.leaseSeconds)
        .then((heartbeat) => {
          if (heartbeat.status !== "active") abort(heartbeat.status);
        })
        .catch(() => abort("heartbeat_failed"))
        .finally(schedule);
    }, intervalMs);
  };
  schedule();

  return {
    signal: controller.signal,
    get outcome() { return outcome; },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      input.parentSignal.removeEventListener("abort", onParentAbort);
      await inFlight;
    },
  };
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
