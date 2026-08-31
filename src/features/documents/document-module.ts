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
  created_at: Date | string;
  request_hash: string;
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
             scan_status, created_at
           ) VALUES ($1,$2,$3,'original',$4,$5,$6,$7,'pending',$8)`,
          [input.assetId, context.workspaceId, input.versionId, input.objectKey, input.mimeType,
            input.size, input.sha256, createdAt],
        );
        await query("UPDATE documents SET current_version_id = $1 WHERE id = $2", [input.versionId, input.documentId]);
        const row = await readByIdempotencyKey(query, context.workspaceId, input.idempotencyKey);
        if (!row) throw new Error("document_create_no_result");
        return { status: "created", document: fromRow(row) };
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
  sa.id AS asset_id, sa.object_key, sa.scan_status, d.created_at, d.request_hash
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
  if (input.manualMode !== undefined
    && !["question_bank", "study_material", "mixed", "unknown"].includes(input.manualMode)) {
    throw new Error("invalid_document_mode");
  }
  const expectedKey = `tenant/${context.workspaceId}/${input.documentId}/${input.versionId}/source/${input.assetId}`;
  if (input.objectKey !== expectedKey) throw new Error("invalid_document_object_key");
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
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function assertUuidV7(value: string, code: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(code);
  }
}

function hash(value: string) {
  return /^[0-9a-f]{64}$/.test(value);
}
