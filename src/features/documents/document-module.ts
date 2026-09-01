import { parseJobEnvelope, type JobEnvelope } from "@sushua/job-contracts";
import type { PostgresRuntime } from "@/db/postgres/runtime";

type DocumentActor = { learnerId: string; userId?: string };
type DocumentContext = DocumentActor & { workspaceId: string };
type WorkspaceMode = "question_bank" | "study_material" | "mixed" | "unknown";
type UploadDraftInput = {
  documentId: string;
  versionId: string;
  assetId: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  objectKey: string;
  manualMode?: WorkspaceMode;
  idempotencyKey: string;
  requestHash: string;
  storageUploadId?: string;
  uploadExpiresAt?: string;
};
type DocumentRecord = {
  id: string;
  workspaceId: string;
  filename: string;
  mimeType: string;
  sha256: string;
  parseStatus: "uploading" | "scan_pending" | "parsing" | "ready" | "failed";
  currentVersionId: string;
  version: number;
  versionStatus: "uploading" | "scan_pending" | "scanned" | "parsing" | "ready" | "failed";
  assetId: string;
  objectKey: string;
  scanStatus: "pending" | "clean" | "infected" | "failed";
  sizeBytes: number;
  storageUploadId?: string;
  uploadExpiresAt?: string;
  uploadState?: "initiated" | "uploaded" | "aborted";
  completionIdempotencyKey?: string;
  completionRequestHash?: string;
  createdAt: string;
};
type DocumentRow = {
  id: string;
  workspace_id: string;
  filename: string;
  mime_type: string;
  sha256: string;
  parse_status: DocumentRecord["parseStatus"];
  current_version_id: string;
  version: number;
  version_status: DocumentRecord["versionStatus"];
  asset_id: string;
  object_key: string;
  scan_status: DocumentRecord["scanStatus"];
  size_bytes: string | number;
  storage_upload_id: string | null;
  upload_expires_at: Date | string | null;
  upload_state: DocumentRecord["uploadState"] | null;
  completion_idempotency_key: string | null;
  completion_request_hash: string | null;
  created_at: Date | string;
  request_hash: string;
};
type UploadCompletionInput = {
  assetId: string;
  storageUploadId: string;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
  idempotencyKey: string;
  requestHash: string;
  jobRequestHash: string;
  jobId: string;
  traceId: string;
};

export function createDocumentModule(runtime: PostgresRuntime, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  return {
    async createUploadDraft(context: DocumentContext, input: UploadDraftInput): Promise<{
      status: "created" | "replayed";
      document: DocumentRecord;
    }> {
      validateUploadDraft(context, input);
      const createdAt = now();
      if (!Number.isFinite(createdAt.getTime())) throw new Error("invalid_document_timestamp");
      return runtime.withTenant(context, async ({ query }) => {
        await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          `${context.workspaceId}:document-upload:${input.idempotencyKey}`,
        ]);
        const existing = await readByIdempotencyKey(query, context.workspaceId, input.idempotencyKey);
        if (existing) {
          if (existing.request_hash !== input.requestHash) throw new Error("document_idempotency_conflict");
          return { status: "replayed", document: fromRow(existing) };
        }

        await query(
          `INSERT INTO documents (
             id, workspace_id, filename, mime_type, sha256, manual_mode, parse_status,
             idempotency_key, request_hash, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,'uploading',$7,$8,$9,$9)`,
          [input.documentId, context.workspaceId, input.filename, input.mimeType, input.sha256,
            input.manualMode ?? null, input.idempotencyKey, input.requestHash, createdAt],
        );
        await query(
          `INSERT INTO document_versions (
             id, workspace_id, document_id, version, source_object_key, content_hash, status, created_at
           ) VALUES ($1,$2,$3,1,$4,$5,'uploading',$6)`,
          [input.versionId, context.workspaceId, input.documentId, input.objectKey, input.sha256, createdAt],
        );
        await query(
          `INSERT INTO source_assets (
             id, workspace_id, document_version_id, kind, object_key, mime_type, size_bytes, sha256,
             scan_status, storage_upload_id, upload_expires_at, upload_state, created_at
           ) VALUES ($1,$2,$3,'original',$4,$5,$6,$7,'pending',$8,$9,
             CASE WHEN $8::text IS NULL THEN NULL ELSE 'initiated'::source_asset_upload_state END,$10)`,
          [input.assetId, context.workspaceId, input.versionId, input.objectKey, input.mimeType,
            input.size, input.sha256, input.storageUploadId ?? null, input.uploadExpiresAt ?? null, createdAt],
        );
        await query("UPDATE documents SET current_version_id = $1 WHERE id = $2", [input.versionId, input.documentId]);
        const row = await readByIdempotencyKey(query, context.workspaceId, input.idempotencyKey);
        if (!row) throw new Error("document_create_no_result");
        return { status: "created", document: fromRow(row) };
      });
    },

    async findUploadDraft(
      context: DocumentContext,
      idempotencyKey: string,
      requestHash: string,
    ): Promise<DocumentRecord | undefined> {
      if (!idempotencyKey || idempotencyKey.length > 200 || !hash(requestHash)) {
        throw new Error("invalid_document_idempotency_key");
      }
      return runtime.withTenant(context, async ({ query }) => {
        const result = await query<DocumentRow>(
          `${documentSelect}
           JOIN workspace_members wm ON wm.workspace_id = d.workspace_id
             AND wm.learner_id = $3 AND wm.role IN ('owner','editor')
           WHERE d.workspace_id = $1 AND d.idempotency_key = $2`,
          [context.workspaceId, idempotencyKey, context.learnerId],
        );
        const row = result.rows[0];
        if (row && row.request_hash !== requestHash) throw new Error("document_idempotency_conflict");
        return row ? fromRow(row) : undefined;
      });
    },

    async findUploadByAsset(actor: DocumentActor, assetId: string): Promise<DocumentRecord | undefined> {
      assertUuidV7(actor.learnerId, "invalid_document_learner");
      assertUuidV7(assetId, "invalid_document_asset_id");
      return runtime.withTenant(actor, async ({ query }) => {
        const result = await query<DocumentRow>(
          `${documentSelect}
           JOIN workspace_members wm ON wm.workspace_id = d.workspace_id
             AND wm.learner_id = $2 AND wm.role IN ('owner','editor')
           WHERE sa.id = $1`,
          [assetId, actor.learnerId],
        );
        return result.rows[0] ? fromRow(result.rows[0]) : undefined;
      });
    },

    async completeUpload(context: DocumentContext, input: UploadCompletionInput): Promise<{
      status: "created" | "replayed";
      job: { envelope: JobEnvelope; state: string };
    }> {
      validateUploadCompletion(context, input);
      const completedAt = now();
      if (!Number.isFinite(completedAt.getTime())) throw new Error("invalid_document_timestamp");
      return runtime.withTenant(context, async ({ query }) => {
        const result = await query<{ result: { status: "created" | "replayed"; job: Record<string, unknown> } }>(
          "SELECT complete_source_upload_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS result",
          [
            input.assetId,
            context.workspaceId,
            context.learnerId,
            input.storageUploadId,
            input.sizeBytes,
            input.sha256,
            input.mimeType,
            input.idempotencyKey,
            input.requestHash,
            input.jobRequestHash,
            input.jobId,
            input.traceId,
            completedAt,
          ],
        );
        const row = result.rows[0]?.result;
        if (!row) throw new Error("upload_complete_no_result");
        if (row.status !== "created" && row.status !== "replayed") {
          throw new Error("invalid_upload_completion_result");
        }
        return {
          status: row.status,
          job: {
            envelope: jobEnvelopeFromRaw(row.job),
            state: stringField(row.job.state, "invalid_upload_completion_job"),
          },
        };
      });
    },

    async read(actor: DocumentActor, documentId: string): Promise<DocumentRecord | undefined> {
      assertUuidV7(documentId, "invalid_document_id");
      return runtime.withTenant(actor, async ({ query }) => {
        const result = await query<DocumentRow>(`${documentSelect} WHERE d.id = $1`, [documentId]);
        return result.rows[0] ? fromRow(result.rows[0]) : undefined;
      });
    },
  };
}

const documentSelect = `SELECT d.id, d.workspace_id, d.filename, d.mime_type, d.sha256,
  d.parse_status, d.current_version_id, dv.version, dv.status AS version_status,
  sa.id AS asset_id, sa.object_key, sa.scan_status, sa.size_bytes, sa.storage_upload_id,
  sa.upload_expires_at, sa.upload_state, sa.completion_idempotency_key,
  sa.completion_request_hash, d.created_at, d.request_hash
  FROM documents d
  JOIN document_versions dv ON dv.id = d.current_version_id AND dv.document_id = d.id
  JOIN source_assets sa ON sa.document_version_id = dv.id AND sa.kind = 'original'`;

async function readByIdempotencyKey(
  query: Parameters<Parameters<PostgresRuntime["withTenant"]>[1]>[0]["query"],
  workspaceId: string,
  idempotencyKey: string,
) {
  const result = await query<DocumentRow>(
    `${documentSelect} WHERE d.workspace_id = $1 AND d.idempotency_key = $2`,
    [workspaceId, idempotencyKey],
  );
  return result.rows[0];
}

function validateUploadDraft(context: DocumentContext, input: UploadDraftInput) {
  assertUuidV7(context.learnerId, "invalid_document_learner");
  assertUuidV7(context.workspaceId, "invalid_document_workspace");
  assertUuidV7(input.documentId, "invalid_document_id");
  assertUuidV7(input.versionId, "invalid_document_version_id");
  assertUuidV7(input.assetId, "invalid_document_asset_id");
  if (!input.filename || input.filename !== input.filename.trim() || input.filename.length > 255 || /[\\/]/.test(input.filename)) {
    throw new Error("invalid_document_filename");
  }
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(input.mimeType)) {
    throw new Error("invalid_document_mime_type");
  }
  if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > 200 * 1024 * 1024) {
    throw new Error("invalid_document_size");
  }
  if (!hash(input.sha256)) throw new Error("invalid_document_sha256");
  if (!input.idempotencyKey || input.idempotencyKey !== input.idempotencyKey.trim() || input.idempotencyKey.length > 200) {
    throw new Error("invalid_document_idempotency_key");
  }
  if (!hash(input.requestHash)) throw new Error("invalid_document_request_hash");
  if ((input.storageUploadId === undefined) !== (input.uploadExpiresAt === undefined)) {
    throw new Error("invalid_document_upload_plan");
  }
  if (input.storageUploadId !== undefined
    && (!input.storageUploadId || input.storageUploadId.length > 1024
      || !input.uploadExpiresAt || !Number.isFinite(Date.parse(input.uploadExpiresAt)))) {
    throw new Error("invalid_document_upload_plan");
  }
  if (input.manualMode !== undefined
    && !["question_bank", "study_material", "mixed", "unknown"].includes(input.manualMode)) {
    throw new Error("invalid_document_mode");
  }
  const expectedKey = `tenant/${context.workspaceId}/${input.documentId}/${input.versionId}/source/${input.assetId}`;
  if (input.objectKey !== expectedKey) throw new Error("invalid_document_object_key");
}

function validateUploadCompletion(context: DocumentContext, input: UploadCompletionInput) {
  assertUuidV7(context.learnerId, "invalid_document_learner");
  assertUuidV7(context.workspaceId, "invalid_document_workspace");
  assertUuidV7(input.assetId, "invalid_document_asset_id");
  assertUuidV7(input.jobId, "invalid_upload_job_id");
  assertUuidV7(input.traceId, "invalid_upload_trace_id");
  if (!input.storageUploadId || input.storageUploadId.length > 1024) throw new Error("invalid_storage_upload_id");
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 200 * 1024 * 1024) {
    throw new Error("invalid_document_size");
  }
  if (!hash(input.sha256) || !hash(input.requestHash) || !hash(input.jobRequestHash)) {
    throw new Error("invalid_upload_completion_hash");
  }
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(input.mimeType)) {
    throw new Error("invalid_document_mime_type");
  }
  if (!input.idempotencyKey || input.idempotencyKey !== input.idempotencyKey.trim() || input.idempotencyKey.length > 200) {
    throw new Error("invalid_document_idempotency_key");
  }
}

function fromRow(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sha256: row.sha256,
    parseStatus: row.parse_status,
    currentVersionId: row.current_version_id,
    version: row.version,
    versionStatus: row.version_status,
    assetId: row.asset_id,
    objectKey: row.object_key,
    scanStatus: row.scan_status,
    sizeBytes: Number(row.size_bytes),
    ...(row.storage_upload_id ? { storageUploadId: row.storage_upload_id } : {}),
    ...(row.upload_expires_at ? { uploadExpiresAt: new Date(row.upload_expires_at).toISOString() } : {}),
    ...(row.upload_state ? { uploadState: row.upload_state } : {}),
    ...(row.completion_idempotency_key ? { completionIdempotencyKey: row.completion_idempotency_key } : {}),
    ...(row.completion_request_hash ? { completionRequestHash: row.completion_request_hash } : {}),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function stringField(value: unknown, code: string): string {
  if (typeof value !== "string") throw new Error(code);
  return value;
}

function jobEnvelopeFromRaw(row: Record<string, unknown>): JobEnvelope {
  const requestedAt = new Date(stringField(row.requested_at, "invalid_upload_completion_job"));
  if (!Number.isFinite(requestedAt.getTime())) throw new Error("invalid_upload_completion_job");
  return parseJobEnvelope({
    schemaVersion: row.schema_version,
    id: row.id,
    type: row.type,
    workspaceId: row.workspace_id,
    ...(row.learner_id ? { learnerId: row.learner_id } : {}),
    resourceId: row.resource_id,
    idempotencyKey: row.idempotency_key,
    traceId: row.trace_id,
    requestedAt: requestedAt.toISOString(),
    priority: row.priority,
    budget: row.budget,
    ...(row.checkpoint ? { checkpoint: row.checkpoint } : {}),
  });
}

function assertUuidV7(value: string, code: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(code);
  }
}

function hash(value: string) {
  return /^[0-9a-f]{64}$/.test(value);
}
