export const JOB_TYPES = ["file.scan", "document.parse", "document.cleanup"] as const;

export type JobType = (typeof JOB_TYPES)[number];

export type JobEnvelope = Readonly<{
  schemaVersion: 1;
  id: string;
  type: JobType;
  workspaceId: string;
  learnerId?: string;
  resourceId: string;
  idempotencyKey: string;
  traceId: string;
  requestedAt: string;
  priority: number;
  budget: Readonly<{ maxCostFen?: number; maxTokens?: number }>;
  checkpoint?: Readonly<Record<string, unknown>>;
}>;

const ENVELOPE_FIELDS = new Set([
  "schemaVersion",
  "id",
  "type",
  "workspaceId",
  "learnerId",
  "resourceId",
  "idempotencyKey",
  "traceId",
  "requestedAt",
  "priority",
  "budget",
  "checkpoint",
]);
const BUDGET_FIELDS = new Set(["maxCostFen", "maxTokens"]);
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseJobEnvelope(value: unknown): JobEnvelope {
  if (!isRecord(value)) throw new Error("invalid_job_envelope");
  if (Object.keys(value).some((key) => !ENVELOPE_FIELDS.has(key))) {
    throw new Error("invalid_job_envelope_fields");
  }
  if (value.schemaVersion !== 1) throw new Error("invalid_job_schema_version");
  if (!(JOB_TYPES as readonly unknown[]).includes(value.type)) throw new Error("invalid_job_type");
  assertUuid(value.id, "invalid_job_id");
  assertUuid(value.workspaceId, "invalid_job_workspace_id");
  if (value.learnerId !== undefined) assertUuid(value.learnerId, "invalid_job_learner_id");
  assertUuid(value.resourceId, "invalid_job_resource_id");
  assertUuid(value.traceId, "invalid_job_trace_id");
  if (typeof value.idempotencyKey !== "string"
    || value.idempotencyKey.length < 1
    || value.idempotencyKey.length > 200
    || value.idempotencyKey.trim() !== value.idempotencyKey) {
    throw new Error("invalid_job_idempotency_key");
  }
  if (typeof value.requestedAt !== "string"
    || !Number.isFinite(Date.parse(value.requestedAt))
    || new Date(value.requestedAt).toISOString() !== value.requestedAt) {
    throw new Error("invalid_job_requested_at");
  }
  if (!Number.isInteger(value.priority) || (value.priority as number) < -10 || (value.priority as number) > 10) {
    throw new Error("invalid_job_priority");
  }
  const budget = parseBudget(value.budget);
  const checkpoint = value.checkpoint === undefined ? undefined : parseCheckpoint(value.checkpoint);

  return deepFreeze({
    schemaVersion: 1,
    id: value.id,
    type: value.type as JobType,
    workspaceId: value.workspaceId,
    ...(value.learnerId ? { learnerId: value.learnerId } : {}),
    resourceId: value.resourceId,
    idempotencyKey: value.idempotencyKey,
    traceId: value.traceId,
    requestedAt: value.requestedAt,
    priority: value.priority as number,
    budget,
    ...(checkpoint ? { checkpoint } : {}),
  });
}

function parseBudget(value: unknown): { maxCostFen?: number; maxTokens?: number } {
  if (!isRecord(value) || Object.keys(value).some((key) => !BUDGET_FIELDS.has(key))) {
    throw new Error("invalid_job_budget");
  }
  if (value.maxCostFen !== undefined
    && (typeof value.maxCostFen !== "number" || !Number.isFinite(value.maxCostFen) || value.maxCostFen < 0)) {
    throw new Error("invalid_job_budget");
  }
  if (value.maxTokens !== undefined
    && (typeof value.maxTokens !== "number" || !Number.isInteger(value.maxTokens) || value.maxTokens < 0)) {
    throw new Error("invalid_job_budget");
  }
  return {
    ...(value.maxCostFen !== undefined ? { maxCostFen: value.maxCostFen } : {}),
    ...(value.maxTokens !== undefined ? { maxTokens: value.maxTokens } : {}),
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

function assertUuid(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || !UUID_V7.test(value)) throw new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
