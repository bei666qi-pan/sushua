import type { PostgresRuntime } from "@/db/postgres/runtime";

type RevisionActor = {
  learnerId: string;
  workspaceId: string;
};

const OPERATIONS = ["edit", "delete", "split", "merge"] as const;
type RevisionOperationKind = (typeof OPERATIONS)[number];

export type DocumentRevisionOperation = {
  sourceBlockId: string;
  operation: RevisionOperationKind;
  patch: Record<string, unknown>;
};

export type CreateDocumentRevisionInput = {
  revisionId: string;
  documentId: string;
  baseDocumentVersionId: string;
  revisionNumber: number;
  operations: DocumentRevisionOperation[];
};

export type CreateConcurrentDocumentRevisionInput = Omit<CreateDocumentRevisionInput, "revisionNumber"> & {
  expectedRevisionNumber: number;
  idempotencyKey: string;
  requestHash: string;
};

export type DocumentRevision = Omit<CreateDocumentRevisionInput, "revisionId"> & {
  id: string;
  workspaceId: string;
};

export type ConcurrentDocumentRevisionResult = {
  status: "created" | "replayed";
  revision: DocumentRevision;
};

export function createDocumentRevisionModule(runtime: PostgresRuntime) {
  return {
    async createRevision(actor: RevisionActor, input: CreateDocumentRevisionInput): Promise<DocumentRevision> {
      const result = await this.createRevisionIfCurrent(actor, {
        ...input,
        expectedRevisionNumber: input.revisionNumber - 1,
        idempotencyKey: `legacy:${input.revisionId}`,
        requestHash: "0".repeat(64),
      });
      return result.revision;
    },
    async createRevisionIfCurrent(actor: RevisionActor, input: CreateConcurrentDocumentRevisionInput): Promise<ConcurrentDocumentRevisionResult> {
      validateConcurrent(actor, input);
      const revision = buildRevision(actor, input, input.expectedRevisionNumber + 1);
      return runtime.withTenant(actor, async ({ query }) => {
        await query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`${revision.workspaceId}:${revision.documentId}`],
        );
        const base = await query<{ id: string }>(
          `SELECT dv.id
             FROM document_versions dv
             JOIN documents d ON d.id = dv.document_id AND d.workspace_id = dv.workspace_id
            WHERE dv.id = $1
              AND dv.workspace_id = $2
              AND dv.document_id = $3
              AND d.deleted_at IS NULL`,
          [revision.baseDocumentVersionId, revision.workspaceId, revision.documentId],
        );
        if (!base.rows[0]) throw new Error("document_revision_base_not_found");

        const existing = await query<{ id: string; revision_number: number; request_hash: string }>(
          `SELECT id, revision_number, request_hash
             FROM document_revisions
            WHERE workspace_id = $1
              AND document_id = $2
              AND idempotency_key = $3`,
          [revision.workspaceId, revision.documentId, input.idempotencyKey],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== input.requestHash) throw new Error("document_revision_idempotency_conflict");
          return {
            status: "replayed" as const,
            revision: { ...revision, id: existing.rows[0].id, revisionNumber: existing.rows[0].revision_number },
          };
        }

        const current = await query<{ revision_number: number }>(
          `SELECT revision_number
             FROM document_revisions
            WHERE workspace_id = $1
              AND document_id = $2
            ORDER BY revision_number DESC
            LIMIT 1`,
          [revision.workspaceId, revision.documentId],
        );
        const currentRevisionNumber = current.rows[0]?.revision_number ?? 0;
        if (currentRevisionNumber !== input.expectedRevisionNumber) throw new Error("document_revision_conflict");
        revision.revisionNumber = currentRevisionNumber + 1;

        const sourceIds = revision.operations.map((operation) => operation.sourceBlockId);
        const blocks = await query<{ id: string }>(
          `SELECT id
             FROM blocks
            WHERE workspace_id = $1
              AND document_version_id = $2
              AND id = ANY($3::uuid[])
              AND deleted_at IS NULL`,
          [revision.workspaceId, revision.baseDocumentVersionId, sourceIds],
        );
        if (blocks.rows.length !== sourceIds.length) throw new Error("document_revision_source_blocks_not_found");

        await query(
          `INSERT INTO document_revisions(
            id, workspace_id, document_id, base_document_version_id, revision_number, created_by_learner_id,
            idempotency_key, request_hash
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            revision.id,
            revision.workspaceId,
            revision.documentId,
            revision.baseDocumentVersionId,
            revision.revisionNumber,
            actor.learnerId,
            input.idempotencyKey,
            input.requestHash,
          ],
        );
        for (const operation of revision.operations) {
          await query(
            `INSERT INTO document_revision_blocks(
              revision_id, workspace_id, base_document_version_id, source_block_id, operation, patch
            ) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
            [
              revision.id,
              revision.workspaceId,
              revision.baseDocumentVersionId,
              operation.sourceBlockId,
              operation.operation,
              JSON.stringify(operation.patch),
            ],
          );
        }
        return { status: "created" as const, revision };
      });
    },
  };
}

function buildRevision(actor: RevisionActor, input: Omit<CreateConcurrentDocumentRevisionInput, "expectedRevisionNumber" | "idempotencyKey" | "requestHash">, revisionNumber: number): DocumentRevision {
  return {
    id: input.revisionId,
    workspaceId: actor.workspaceId,
    documentId: input.documentId,
    baseDocumentVersionId: input.baseDocumentVersionId,
    revisionNumber,
    operations: input.operations.map((operation) => ({ ...operation, patch: structuredClone(operation.patch) })),
  };
}

function validateConcurrent(actor: RevisionActor, input: CreateConcurrentDocumentRevisionInput) {
  validate(actor, { ...input, revisionNumber: input.expectedRevisionNumber + 1 });
  if (!Number.isSafeInteger(input.expectedRevisionNumber) || input.expectedRevisionNumber < 0 || input.expectedRevisionNumber >= 1_000_000) {
    throw new Error("invalid_document_revision_number");
  }
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200) throw new Error("invalid_document_revision_idempotency_key");
  if (!/^[0-9a-f]{64}$/.test(input.requestHash)) throw new Error("invalid_document_revision_request_hash");
}

function validate(actor: RevisionActor, input: CreateDocumentRevisionInput) {
  assertUuidV7(actor.learnerId, "invalid_document_revision_learner");
  assertUuidV7(actor.workspaceId, "invalid_document_revision_workspace");
  assertUuidV7(input.revisionId, "invalid_document_revision_id");
  assertUuidV7(input.documentId, "invalid_document_revision_document_id");
  assertUuidV7(input.baseDocumentVersionId, "invalid_document_revision_base_version_id");
  if (!Number.isSafeInteger(input.revisionNumber) || input.revisionNumber < 1 || input.revisionNumber > 1_000_000) {
    throw new Error("invalid_document_revision_number");
  }
  if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 100) {
    throw new Error("invalid_document_revision_operations");
  }
  const seenBlocks = new Set<string>();
  for (const operation of input.operations) {
    if (!operation || typeof operation !== "object"
      || !isRevisionOperation(operation.operation)
      || !uuidV7(operation.sourceBlockId)
      || !isPlainRecord(operation.patch)
      || !isJsonValue(operation.patch)
      || seenBlocks.has(operation.sourceBlockId)
      || serializedSize(operation.patch) > 32 * 1024) {
      throw new Error("invalid_document_revision_operations");
    }
    seenBlocks.add(operation.sourceBlockId);
  }
}

function isRevisionOperation(value: unknown): value is RevisionOperationKind {
  return typeof value === "string" && (OPERATIONS as readonly string[]).includes(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : isPlainRecord(value) && Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function serializedSize(value: Record<string, unknown>): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function assertUuidV7(value: string, code: string) {
  if (!uuidV7(value)) throw new Error(code);
}

function uuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
