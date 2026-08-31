import { v7 as uuidv7 } from "uuid";
import type { CurrentIdentity } from "@/features/auth/current-identity";
import { createUploadModule, type UploadInitInput } from "./upload-module";

type UploadModule = ReturnType<typeof createUploadModule>;
type IdentityResolver = { resolve(request: Request): Promise<CurrentIdentity> };

export function createUploadInitHandler(input: {
  enabled: boolean;
  identity?: IdentityResolver;
  uploads?: UploadModule;
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
    if (!input.identity || !input.uploads) throw new Error("upload_api_dependencies_unavailable");
    const current = await input.identity.resolve(request);
    try {
      const result = await input.uploads.initialize({
        learnerId: current.learnerId,
        ...(current.kind === "user" ? { userId: current.userId } : {}),
        workspaceId: parsed.workspaceId,
      }, parsed.upload);
      return withIdentityCookie(Response.json({
        data: {
          workspace_id: parsed.workspaceId,
          document_id: result.document.id,
          document_version_id: result.document.currentVersionId,
          asset_id: result.document.assetId,
          upload: {
            upload_id: result.plan.uploadId,
            part_size_bytes: result.plan.partSizeBytes,
            expires_at: result.plan.expiresAt,
            parts: result.plan.parts.map((part) => ({ part_number: part.partNumber, url: part.url })),
          },
        },
        meta: {
          request_id: uuidv7(),
          schema_version: "sushua.api.v1",
          idempotent_replay: result.status === "replayed",
        },
      }, { status: result.status === "created" ? 201 : 200 }), current);
    } catch (error) {
      return withIdentityCookie(uploadError(error), current);
    }
  };
}

function parseBody(body: unknown, idempotencyKey: string):
  | { workspaceId: string; upload: UploadInitInput }
  | { error: string; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_body", message: "请求正文无效" };
  const value = body as Record<string, unknown>;
  const allowed = new Set(["workspace_id", "filename", "size", "mime_type", "sha256", "mode"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return { error: "invalid_body", message: "请求包含未支持字段" };
  const workspaceId = typeof value.workspace_id === "string" ? value.workspace_id : "";
  const filename = typeof value.filename === "string" ? value.filename.trim() : "";
  const mimeType = typeof value.mime_type === "string" ? value.mime_type : "";
  const sha256 = typeof value.sha256 === "string" ? value.sha256 : "";
  const size = value.size;
  const mode = value.mode;
  if (!uuidV7(workspaceId)) return { error: "invalid_workspace_id", message: "Workspace id 无效" };
  if (!filename || filename.length > 255 || /[\\/]/.test(filename)) return { error: "invalid_filename", message: "文件名无效" };
  if (!Number.isSafeInteger(size) || (size as number) < 1 || (size as number) > 200 * 1024 * 1024) {
    return { error: "invalid_size", message: "文件大小无效" };
  }
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mimeType)) return { error: "invalid_mime_type", message: "MIME 无效" };
  if (!/^[0-9a-f]{64}$/.test(sha256)) return { error: "invalid_sha256", message: "SHA256 无效" };
  if (mode !== undefined && !["question_bank", "study_material", "mixed", "unknown"].includes(String(mode))) {
    return { error: "invalid_mode", message: "解析模式无效" };
  }
  return {
    workspaceId,
    upload: {
      filename,
      size: size as number,
      mimeType,
      sha256,
      ...(mode === undefined ? {} : { mode: mode as UploadInitInput["mode"] }),
      idempotencyKey,
    },
  };
}

function uploadError(error: unknown) {
  const code = error instanceof Error ? error.message : "upload_init_failed";
  if (code === "document_idempotency_conflict") return apiError(409, "idempotency_conflict", "该幂等键已用于不同请求", false);
  if (isPgPermission(error)) return apiError(404, "workspace_not_found", "Workspace not found", false);
  if (code.startsWith("invalid_")) return apiError(400, code, "上传参数无效", false);
  return apiError(503, "upload_init_failed", "上传初始化失败", true);
}

function isPgPermission(error: unknown) {
  return !!error && typeof error === "object"
    && (("code" in error && error.code === "42501")
      || (error instanceof Error && error.message.includes("row-level security")));
}

function uuidV7(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function withIdentityCookie(response: Response, identity: CurrentIdentity) {
  if (identity.kind === "guest") response.headers.append("set-cookie", identity.setCookie);
  return response;
}

function apiError(status: number, code: string, message: string, retryable: boolean) {
  return Response.json({ error: { code, message, retryable }, request_id: uuidv7() }, { status });
}
