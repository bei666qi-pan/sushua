import { v7 as uuidv7 } from "uuid";
import { createHash } from "node:crypto";
import type { CurrentIdentity } from "@/features/auth/current-identity";
import type { createDocumentRevisionModule, DocumentRevisionOperation } from "./document-revision-module";

type RevisionModule = ReturnType<typeof createDocumentRevisionModule>;
type IdentityResolver = { resolve(request: Request): Promise<CurrentIdentity> };

export function createDocumentRevisionBatchHandler(input: {
  enabled: boolean;
  identity?: IdentityResolver;
  revisions?: RevisionModule;
}) {
  return async (request: Request): Promise<Response> => {
    if (!input.enabled) return apiError(404, "not_found", "Not found", false);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 200) {
      return apiError(400, "idempotency_key_required", "需要有效的 Idempotency-Key", false);
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "invalid_json", "请求格式错误", false);
    }
    const parsed = parseBody(body, idempotencyKey);
    if ("error" in parsed) return apiError(400, parsed.error, parsed.message, false);
    if (!input.identity || !input.revisions) throw new Error("document_revision_batch_dependencies_unavailable");
    const current = await input.identity.resolve(request);
    try {
      const result = await input.revisions.createRevisionIfCurrent(
        { learnerId: current.learnerId, workspaceId: parsed.workspaceId },
        {
          revisionId: uuidv7(),
          documentId: parsed.documentId,
          baseDocumentVersionId: parsed.baseDocumentVersionId,
          expectedRevisionNumber: parsed.baseRevisionNumber,
          idempotencyKey,
          requestHash: parsed.requestHash,
          operations: parsed.operations,
        },
      );
      return withIdentityCookie(Response.json({
        data: revisionData(result.revision),
        meta: {
          request_id: uuidv7(),
          schema_version: "sushua.api.v1",
          idempotent_replay: result.status === "replayed",
        },
      }, { status: result.status === "created" ? 201 : 200 }), current);
    } catch (error) {
      return withIdentityCookie(revisionError(error), current);
    }
  };
}

type ParsedRevision = {
  workspaceId: string;
  documentId: string;
  baseDocumentVersionId: string;
  baseRevisionNumber: number;
  operations: DocumentRevisionOperation[];
  requestHash: string;
};

function parseBody(body: unknown, idempotencyKey: string): ParsedRevision | { error: string; message: string } {
  if (!isRecord(body)) return { error: "invalid_body", message: "请求正文无效" };
  const allowed = new Set(["workspace_id", "document_id", "base_document_version_id", "base_revision_number", "operations"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return { error: "invalid_body", message: "请求包含未支持字段" };
  const workspaceId = stringId(body.workspace_id);
  const documentId = stringId(body.document_id);
  const baseDocumentVersionId = stringId(body.base_document_version_id);
  if (!workspaceId || !documentId || !baseDocumentVersionId) return { error: "invalid_body", message: "资料库或文档版本无效" };
  const baseRevisionNumber = body.base_revision_number;
  if (typeof baseRevisionNumber !== "number" || !Number.isSafeInteger(baseRevisionNumber) || baseRevisionNumber < 0 || baseRevisionNumber >= 1_000_000) {
    return { error: "invalid_base_revision_number", message: "修订版本无效" };
  }
  if (!Array.isArray(body.operations) || body.operations.length < 1 || body.operations.length > 100) {
    return { error: "invalid_document_revision_operations", message: "批量操作无效" };
  }
  const operations = body.operations.map(parseOperation);
  if (operations.some((operation) => !operation)) return { error: "invalid_document_revision_operations", message: "批量操作无效" };
  const validOperations = operations as DocumentRevisionOperation[];
  if (new Set(validOperations.map((operation) => operation.sourceBlockId)).size !== validOperations.length) {
    return { error: "invalid_document_revision_operations", message: "同一 Block 不能重复修改" };
  }
  const canonical = canonicalJson({
    workspace_id: workspaceId,
    document_id: documentId,
    base_document_version_id: baseDocumentVersionId,
    base_revision_number: baseRevisionNumber,
    operations: validOperations.map((operation) => ({ source_block_id: operation.sourceBlockId, operation: operation.operation, patch: operation.patch })),
  });
  return {
    workspaceId,
    documentId,
    baseDocumentVersionId,
    baseRevisionNumber,
    operations: validOperations,
    requestHash: createHash("sha256").update(`${idempotencyKey}\n${canonical}`).digest("hex"),
  };
}

function parseOperation(value: unknown): DocumentRevisionOperation | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => !["source_block_id", "operation", "patch"].includes(key))) return undefined;
  const sourceBlockId = stringId(value.source_block_id);
  if (!sourceBlockId || !["edit", "delete", "split", "merge"].includes(String(value.operation)) || !isRecord(value.patch) || !isJsonValue(value.patch)) return undefined;
  return { sourceBlockId, operation: value.operation as DocumentRevisionOperation["operation"], patch: value.patch };
}

function stringId(value: unknown): string | undefined {
  return typeof value === "string" && uuidV7(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : isRecord(value) && Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) throw new Error("invalid_json_canonicalization");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function revisionData(revision: { id: string; documentId: string; baseDocumentVersionId: string; revisionNumber: number; operations: DocumentRevisionOperation[] }) {
  return {
    id: revision.id,
    document_id: revision.documentId,
    base_document_version_id: revision.baseDocumentVersionId,
    revision_number: revision.revisionNumber,
    operations: revision.operations.map((operation) => ({
      source_block_id: operation.sourceBlockId,
      operation: operation.operation,
      patch: operation.patch,
    })),
  };
}

function revisionError(error: unknown): Response {
  const code = error instanceof Error ? error.message : "document_revision_batch_failed";
  if (code === "document_revision_base_not_found" || code === "document_revision_source_blocks_not_found") {
    return apiError(404, code, "文档或来源 Block 不存在", false);
  }
  if (code === "document_revision_conflict") return apiError(409, code, "文档已被其他修订更新，请刷新后重试", false);
  if (code === "document_revision_idempotency_conflict") return apiError(409, "idempotency_conflict", "该幂等键已用于不同请求", false);
  if (isPgPermission(error)) return apiError(403, "editor_permission_required", "需要编辑权限", false);
  if (code.startsWith("invalid_document_revision_")) return apiError(400, code, "修订参数无效", false);
  return apiError(503, "document_revision_batch_failed", "批量修订暂时不可用", true);
}

function isPgPermission(error: unknown) {
  return !!error && typeof error === "object" && "code" in error && error.code === "42501";
}

function uuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function withIdentityCookie(response: Response, identity: CurrentIdentity) {
  if (identity.kind === "guest") response.headers.append("set-cookie", identity.setCookie);
  return response;
}

function apiError(status: number, code: string, message: string, retryable: boolean) {
  return Response.json({ error: { code, message, retryable }, request_id: uuidv7() }, { status });
}
