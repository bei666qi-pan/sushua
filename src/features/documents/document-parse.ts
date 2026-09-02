import type { PostgresRuntime } from "@/db/postgres/runtime";

export type DocumentParseResult = {
  irObjectKey: string;
  irSha256: string;
  parser: string;
  parserVersion: string;
  pageCount: number;
  irSchemaVersion: "sushua.document-ir.v1";
};

export type DocumentParseTarget = {
  jobId: string;
  workspaceId: string;
  documentId: string;
  documentVersionId: string;
  sourceAssetId: string;
  sourceObjectKey: string;
  sourceSha256: string;
  sizeBytes: number;
  mimeType: string;
  parseConfig: Record<string, unknown>;
  irSchemaVersion: "sushua.document-ir.v1";
  parseStatus: "parsing" | "ready";
  result?: DocumentParseResult;
};

const RESULT_FIELDS = new Set([
  "irObjectKey",
  "irSha256",
  "parser",
  "parserVersion",
  "pageCount",
  "irSchemaVersion",
]);

export function parseDocumentParseResult(value: unknown): DocumentParseResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).some((key) => !RESULT_FIELDS.has(key))
    || Object.keys(value).length !== RESULT_FIELDS.size) {
    throw new Error("invalid_parse_result");
  }
  const row = value as Record<string, unknown>;
  const result = {
    irObjectKey: stringField(row.irObjectKey),
    irSha256: stringField(row.irSha256),
    parser: stringField(row.parser),
    parserVersion: stringField(row.parserVersion),
    pageCount: numberField(row.pageCount),
    irSchemaVersion: stringField(row.irSchemaVersion),
  };
  validateResult(result);
  return result;
}

export function createDocumentParseModule(runtime: PostgresRuntime, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  return {
    async start(jobId: string, expectedAttempt: number): Promise<DocumentParseTarget> {
      assertUuidV7(jobId, "invalid_parse_job_id");
      assertAttempt(expectedAttempt);
      const startedAt = validNow(now(), "invalid_parse_timestamp");
      return runtime.withTenant({ learnerId: jobId }, async ({ query }) => {
        await query("SELECT assert_job_attempt_v1($1,$2,'document.parse')", [jobId, expectedAttempt]);
        const result = await query<{ result: Record<string, unknown> }>(
          "SELECT start_document_parse_v1($1,$2) AS result",
          [jobId, startedAt],
        );
        const row = result.rows[0]?.result;
        if (!row) throw new Error("parse_target_no_result");
        return targetFromRaw(row);
      });
    },

    async succeed(jobId: string, expectedAttempt: number, result: DocumentParseResult) {
      assertUuidV7(jobId, "invalid_parse_job_id");
      assertAttempt(expectedAttempt);
      validateResult(result);
      return await record(runtime, now, jobId, expectedAttempt, {
        status: "ready",
        irObjectKey: result.irObjectKey,
        irSha256: result.irSha256,
        parser: result.parser,
        parserVersion: result.parserVersion,
        pageCount: result.pageCount,
      });
    },

    async fail(jobId: string, expectedAttempt: number, errorCode: string) {
      assertUuidV7(jobId, "invalid_parse_job_id");
      assertAttempt(expectedAttempt);
      if (!validCode(errorCode)) throw new Error("invalid_parse_error_code");
      return await record(runtime, now, jobId, expectedAttempt, { status: "failed", errorCode });
    },
  };
}

async function record(
  runtime: PostgresRuntime,
  now: () => Date,
  jobId: string,
  expectedAttempt: number,
  value: ({ status: "ready" } & Omit<DocumentParseResult, "irSchemaVersion">)
    | { status: "failed"; errorCode: string },
): Promise<{ status: "ready" | "failed"; replayed: boolean }> {
  const completedAt = validNow(now(), "invalid_parse_timestamp");
  return runtime.withTenant({ learnerId: jobId }, async ({ query }) => {
    await query("SELECT assert_job_attempt_v1($1,$2,'document.parse')", [jobId, expectedAttempt]);
    const result = await query<{ result: { status: "ready" | "failed"; replayed: boolean } }>(
      "SELECT record_document_parse_v1($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result",
      value.status === "ready"
        ? [
            jobId,
            value.status,
            value.irObjectKey,
            value.irSha256,
            value.parser,
            value.parserVersion,
            value.pageCount,
            null,
            completedAt,
          ]
        : [jobId, value.status, null, null, null, null, null, value.errorCode, completedAt],
    );
    const row = result.rows[0]?.result;
    if (!row || !["ready", "failed"].includes(row.status) || typeof row.replayed !== "boolean") {
      throw new Error("invalid_parse_record_result");
    }
    return row;
  });
}

function targetFromRaw(row: Record<string, unknown>): DocumentParseTarget {
  const parseStatus = stringField(row.parse_status);
  const irSchemaVersion = stringField(row.ir_schema_version);
  if (!["parsing", "ready"].includes(parseStatus) || irSchemaVersion !== "sushua.document-ir.v1") {
    throw new Error("invalid_parse_target");
  }
  const target: DocumentParseTarget = {
    jobId: stringField(row.job_id),
    workspaceId: stringField(row.workspace_id),
    documentId: stringField(row.document_id),
    documentVersionId: stringField(row.document_version_id),
    sourceAssetId: stringField(row.source_asset_id),
    sourceObjectKey: stringField(row.source_object_key),
    sourceSha256: stringField(row.source_sha256),
    sizeBytes: numberField(row.size_bytes),
    mimeType: stringField(row.mime_type),
    parseConfig: recordField(row.parse_config),
    irSchemaVersion,
    parseStatus: parseStatus as DocumentParseTarget["parseStatus"],
    ...(row.result ? { result: resultFromRaw(recordField(row.result)) } : {}),
  };
  for (const value of [target.jobId, target.workspaceId, target.documentId, target.documentVersionId, target.sourceAssetId]) {
    assertUuidV7(value, "invalid_parse_target");
  }
  if (!Number.isSafeInteger(target.sizeBytes) || target.sizeBytes < 1 || target.sizeBytes > 200 * 1024 * 1024
    || !/^[0-9a-f]{64}$/.test(target.sourceSha256)
    || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(target.mimeType)
    || (target.parseStatus === "ready") !== Boolean(target.result)) {
    throw new Error("invalid_parse_target");
  }
  return target;
}

function resultFromRaw(row: Record<string, unknown>): DocumentParseResult {
  const result = {
    irObjectKey: stringField(row.ir_object_key),
    irSha256: stringField(row.ir_sha256),
    parser: stringField(row.parser),
    parserVersion: stringField(row.parser_version),
    pageCount: numberField(row.page_count),
    irSchemaVersion: stringField(row.ir_schema_version),
  };
  validateResult(result);
  return result;
}

function validateResult(result: {
  irObjectKey: string;
  irSha256: string;
  parser: string;
  parserVersion: string;
  pageCount: number;
  irSchemaVersion: string;
}): asserts result is DocumentParseResult {
  const objectSegments = result.irObjectKey.split("/");
  if (objectSegments.length < 6
    || objectSegments[0] !== "tenant"
    || !objectSegments.slice(1, 4).every((value) => isUuidV7(value))
    || objectSegments[4] !== "ir"
    || objectSegments.slice(5).some((value) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..")
    || !/^[0-9a-f]{64}$/.test(result.irSha256)
    || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(result.parser)
    || !/^[\x20-\x7e]{1,80}$/.test(result.parserVersion)
    || !Number.isInteger(result.pageCount) || result.pageCount < 1 || result.pageCount > 10_000
    || result.irSchemaVersion !== "sushua.document-ir.v1") {
    throw new Error("invalid_parse_result");
  }
}

function validNow(value: Date, code: string) {
  if (!Number.isFinite(value.getTime())) throw new Error(code);
  return value;
}

function validCode(value: string) {
  return /^[a-z][a-z0-9_.-]{0,119}$/.test(value);
}

function stringField(value: unknown) {
  if (typeof value !== "string") throw new Error("invalid_parse_target");
  return value;
}

function numberField(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("invalid_parse_target");
  return number;
}

function recordField(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_parse_target");
  return value as Record<string, unknown>;
}

function assertUuidV7(value: string, code: string) {
  if (!isUuidV7(value)) {
    throw new Error(code);
  }
}

function assertAttempt(value: number) {
  if (!Number.isInteger(value) || value < 1) throw new Error("invalid_job_attempt");
}

function isUuidV7(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
