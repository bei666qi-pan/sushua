import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { parseJobEnvelope, type JobEnvelope, type JobType } from "@sushua/job-contracts";
import type { PostgresRuntime } from "@/db/postgres/runtime";

type JobActor = { learnerId: string; userId?: string };
type JobContext = JobActor & { workspaceId: string };
type JobRequest = {
  type: JobType;
  resourceId: string;
  idempotencyKey: string;
  priority: number;
  budget: { maxCostFen?: number; maxTokens?: number };
  maxAttempts: number;
};
type JobState = "queued" | "running" | "succeeded" | "partially_succeeded" | "failed"
  | "dead_lettered" | "cancel_requested" | "cancelled";
type JobProgress = {
  phase: string;
  percent: number;
  current?: number;
  total?: number;
  messageCode?: string;
  updatedAt: string;
};
type JobSnapshot = {
  id: string;
  workspaceId: string;
  learnerId?: string;
  resourceId: string;
  type: JobType;
  state: JobState;
  progress: JobProgress;
  checkpoint?: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  errorCode?: string;
  runAfter: string;
};
type JobEvent =
  | { type: "start" }
  | { type: "progress"; progress: Omit<JobProgress, "updatedAt">; checkpoint?: Record<string, unknown> }
  | { type: "retry"; errorCode: string; runAfter: Date }
  | { type: "succeed"; checkpoint?: Record<string, unknown> }
  | { type: "partial_succeed"; checkpoint?: Record<string, unknown>; errorCode?: string }
  | { type: "fail" | "dead_letter"; errorCode: string }
  | { type: "cancel" };
type RawJob = Record<string, unknown>;

export function createJobModule(runtime: PostgresRuntime, options: {
  now?: () => Date;
  newId?: () => string;
} = {}) {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? uuidv7;

  return {
    async submit(context: JobContext, request: JobRequest): Promise<{
      status: "created" | "replayed";
      envelope: JobEnvelope;
    }> {
      if (!Number.isInteger(request.maxAttempts) || request.maxAttempts < 1 || request.maxAttempts > 10) {
        throw new Error("invalid_job_max_attempts");
      }
      const requestedAt = now().toISOString();
      const candidate = parseJobEnvelope({
        schemaVersion: 1,
        id: newId(),
        type: request.type,
        workspaceId: context.workspaceId,
        learnerId: context.learnerId,
        resourceId: request.resourceId,
        idempotencyKey: request.idempotencyKey,
        traceId: newId(),
        requestedAt,
        priority: request.priority,
        budget: request.budget,
      });
      const requestHash = sha256(JSON.stringify({
        type: candidate.type,
        resourceId: candidate.resourceId,
        priority: candidate.priority,
        budget: candidate.budget,
        maxAttempts: request.maxAttempts,
      }));
      return runtime.withTenant(context, async ({ query }) => {
        const result = await query<{ result: { status: "created" | "replayed"; job: RawJob } }>(
          "SELECT submit_job_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) AS result",
          [
            candidate.id,
            candidate.resourceId,
            candidate.type,
            candidate.workspaceId,
            candidate.idempotencyKey,
            requestHash,
            candidate.priority,
            candidate.budget,
            request.maxAttempts,
            candidate.traceId,
            candidate.learnerId,
            candidate.requestedAt,
          ],
        );
        const row = result.rows[0]?.result;
        if (!row) throw new Error("job_submit_no_result");
        return { status: row.status, envelope: envelopeFromRaw(row.job) };
      });
    },

    async read(actor: JobActor, jobId: string): Promise<JobSnapshot | undefined> {
      assertUuid(jobId, "invalid_job_id");
      return runtime.withTenant(actor, async ({ query }) => {
        const result = await query<RawJob>("SELECT * FROM jobs WHERE id = $1", [jobId]);
        return result.rows[0] ? snapshotFromRaw(result.rows[0]) : undefined;
      });
    },

    async apply(jobId: string, event: JobEvent): Promise<JobSnapshot> {
      assertUuid(jobId, "invalid_job_id");
      const eventAt = now();
      const normalized = normalizeEvent(event, eventAt);
      return runtime.withTenant({ learnerId: newId() }, async ({ query }) => {
        const result = await query<{ result: RawJob }>(
          "SELECT transition_job_v1($1,$2,$3,$4,$5,$6,$7) AS result",
          [
            jobId,
            event.type,
            normalized.progress ?? null,
            normalized.checkpoint ?? null,
            normalized.errorCode ?? null,
            normalized.runAfter ?? null,
            eventAt,
          ],
        );
        const row = result.rows[0]?.result;
        if (!row) throw new Error("job_transition_no_result");
        return snapshotFromRaw(row);
      });
    },

    async requestCancel(actor: JobActor, jobId: string, reason: string): Promise<JobSnapshot> {
      assertUuid(jobId, "invalid_job_id");
      if (!reason || reason.length > 120) throw new Error("invalid_job_cancel_reason");
      return runtime.withTenant(actor, async ({ query }) => {
        const result = await query<{ result: RawJob }>(
          "SELECT request_job_cancel($1,$2) AS result",
          [jobId, reason],
        );
        const row = result.rows[0]?.result;
        if (!row) throw new Error("job_cancel_no_result");
        return snapshotFromRaw(row);
      });
    },
  };
}

function normalizeEvent(event: JobEvent, eventAt: Date): {
  progress?: JobProgress;
  checkpoint?: Record<string, unknown>;
  errorCode?: string;
  runAfter?: Date;
} {
  if (event.type === "progress") {
    const progress = parseProgress({ ...event.progress, updatedAt: eventAt.toISOString() });
    return { progress, ...(event.checkpoint ? { checkpoint: parseCheckpoint(event.checkpoint) } : {}) };
  }
  if (event.type === "retry") {
    if (!validCode(event.errorCode) || !Number.isFinite(event.runAfter.getTime())) throw new Error("invalid_job_retry");
    return { errorCode: event.errorCode, runAfter: event.runAfter };
  }
  if (event.type === "succeed") {
    return event.checkpoint ? { checkpoint: parseCheckpoint(event.checkpoint) } : {};
  }
  if (event.type === "partial_succeed") {
    if (event.errorCode !== undefined && !validCode(event.errorCode)) throw new Error("invalid_job_error_code");
    return {
      ...(event.checkpoint ? { checkpoint: parseCheckpoint(event.checkpoint) } : {}),
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    };
  }
  if (event.type === "fail" || event.type === "dead_letter") {
    if (!validCode(event.errorCode)) throw new Error("invalid_job_error_code");
    return { errorCode: event.errorCode };
  }
  return {};
}

function envelopeFromRaw(row: RawJob): JobEnvelope {
  return parseJobEnvelope({
    schemaVersion: row.schema_version,
    id: row.id,
    type: row.type,
    workspaceId: row.workspace_id,
    ...(row.learner_id ? { learnerId: row.learner_id } : {}),
    resourceId: row.resource_id,
    idempotencyKey: row.idempotency_key,
    traceId: row.trace_id,
    requestedAt: iso(row.requested_at),
    priority: row.priority,
    budget: row.budget,
    ...(row.checkpoint ? { checkpoint: row.checkpoint } : {}),
  });
}

function snapshotFromRaw(row: RawJob): JobSnapshot {
  const progress = parseProgress(row.progress);
  return {
    id: stringField(row.id, "invalid_job_row"),
    workspaceId: stringField(row.workspace_id, "invalid_job_row"),
    ...(row.learner_id ? { learnerId: stringField(row.learner_id, "invalid_job_row") } : {}),
    resourceId: stringField(row.resource_id, "invalid_job_row"),
    type: row.type as JobType,
    state: row.state as JobState,
    progress,
    ...(row.checkpoint ? { checkpoint: parseCheckpoint(row.checkpoint) } : {}),
    attempt: numberField(row.attempt, "invalid_job_row"),
    maxAttempts: numberField(row.max_attempts, "invalid_job_row"),
    ...(row.error_code ? { errorCode: stringField(row.error_code, "invalid_job_row") } : {}),
    runAfter: iso(row.run_after),
  };
}

function parseProgress(value: unknown): JobProgress {
  if (!isRecord(value)
    || typeof value.phase !== "string"
    || !/^[a-z][a-z0-9_.-]{0,63}$/.test(value.phase)
    || typeof value.percent !== "number"
    || !Number.isFinite(value.percent)
    || value.percent < 0
    || value.percent > 100
    || typeof value.updatedAt !== "string"
    || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error("invalid_job_progress");
  }
  for (const key of ["current", "total"] as const) {
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || (value[key] as number) < 0)) {
      throw new Error("invalid_job_progress");
    }
  }
  const current = value.current === undefined ? undefined : value.current as number;
  const total = value.total === undefined ? undefined : value.total as number;
  if (current !== undefined && total !== undefined && current > total) {
    throw new Error("invalid_job_progress");
  }
  if (value.messageCode !== undefined && (typeof value.messageCode !== "string" || !validCode(value.messageCode))) {
    throw new Error("invalid_job_progress");
  }
  return {
    phase: value.phase,
    percent: value.percent,
    ...(current !== undefined ? { current } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(value.messageCode ? { messageCode: value.messageCode } : {}),
    updatedAt: new Date(value.updatedAt).toISOString(),
  };
}

function parseCheckpoint(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("invalid_job_checkpoint");
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("invalid_job_checkpoint");
  }
  if (Buffer.byteLength(serialized, "utf8") > 16_384) throw new Error("invalid_job_checkpoint");
  const cloned: unknown = JSON.parse(serialized);
  if (!isRecord(cloned) || Object.keys(cloned).length !== Object.keys(value).length) {
    throw new Error("invalid_job_checkpoint");
  }
  return cloned;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(stringField(value, "invalid_job_timestamp"));
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_job_timestamp");
  return date.toISOString();
}

function assertUuid(value: string, code: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(code);
  }
}

function validCode(value: string) {
  return /^[a-z][a-z0-9_.-]{0,119}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  return value;
}

function numberField(value: unknown, code: string): number {
  if (typeof value !== "number") throw new Error(code);
  return value;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
