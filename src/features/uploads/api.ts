import { v7 as uuidv7 } from "uuid";
import type { CurrentIdentity } from "@/features/auth/current-identity";
import {
  createUploadModule,
  type UploadCompleteInput,
  type UploadInitInput,
} from "./upload-module";

type UploadModule = ReturnType<typeof createUploadModule>;
type IdentityResolver = { resolve(request: Request): Promise<CurrentIdentity> };

export function createUploadCompleteHandler(input: {
  enabled: boolean;
  identity?: IdentityResolver;
  uploads?: UploadModule;
}) {
  return async (request: Request, assetId: string): Promise<Response> => {
    if (!input.enabled) return apiError(404, "not_found", "Not found", false);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 200) {
      return apiError(400, "idempotency_key_required", "需要有效的 Idempotency-Key", false);
    }
    if (!uuidV7(assetId)) return apiError(400, "invalid_asset_id", "Upload id 无效", false);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "invalid_json", "请求格式错误", false);
    }
    const parsed = parseCompleteBody(body, assetId, idempotencyKey);
    if ("error" in parsed) return apiError(400, parsed.error, parsed.message, false);
    if (!input.identity || !input.uploads) throw new Error("upload_complete_dependencies_unavailable");
    const current = await input.identity.resolve(request);
    try {
      const result = await input.uploads.complete({
        learnerId: current.learnerId,
        ...(current.kind === "user" ? { userId: current.userId } : {}),
      }, parsed.upload);
      const job = result.job;
      return withIdentityCookie(Response.json({
        data: {
          job_id: job.envelope.id,
          resource_id: job.envelope.resourceId,
          type: job.envelope.type,
          state: job.state,
          status_url: `/api/v1/jobs/${job.envelope.id}`,
          stream_url: `/api/v1/jobs/${job.envelope.id}/stream`,
        },
        meta: {
          request_id: uuidv7(),
          schema_version: "sushua.api.v1",
          idempotent_replay: result.status === "replayed",
        },
      }, { status: 202 }), current);
    } catch (error) {
      return withIdentityCookie(uploadCompleteError(error), current);
    }
  };
}

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

export function createUploadCancelHandler(input: {
  enabled: boolean;
  identity?: IdentityResolver;
  uploads?: UploadModule;
}) {
  return async (request: Request, assetId: string): Promise<Response> => {
    if (!input.enabled) return apiError(404, "not_found", "Not found", false);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 200) {
      return apiError(400, "idempotency_key_required", "需要有效的 Idempotency-Key", false);
    }
    if (!uuidV7(assetId)) return apiError(400, "invalid_asset_id", "Upload id 无效", false);
    if (!input.identity || !input.uploads) throw new Error("upload_cancel_dependencies_unavailable");
    const current = await input.identity.resolve(request);
    try {
      const result = await input.uploads.cancel({
        learnerId: current.learnerId,
        ...(current.kind === "user" ? { userId: current.userId } : {}),
      }, { assetId, idempotencyKey });
      return withIdentityCookie(Response.json({
        data: { asset_id: assetId, state: "aborted" },
        meta: {
          request_id: uuidv7(),
          schema_version: "sushua.api.v1",
          idempotent_replay: result.status === "replayed",
        },
      }), current);
    } catch (error) {
      return withIdentityCookie(uploadCancelError(error), current);
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

function parseCompleteBody(body: unknown, assetId: string, idempotencyKey: string):
  | { upload: UploadCompleteInput }
  | { error: string; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_body", message: "请求正文无效" };
  const value = body as Record<string, unknown>;
  const allowed = new Set(["upload_id", "sha256", "parts"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return { error: "invalid_body", message: "请求包含未支持字段" };
  const uploadId = typeof value.upload_id === "string" ? value.upload_id : "";
  const sha256 = typeof value.sha256 === "string" ? value.sha256 : "";
  if (!uploadId || uploadId.length > 1024) return { error: "invalid_upload_id", message: "Storage upload id 无效" };
  if (!/^[0-9a-f]{64}$/.test(sha256)) return { error: "invalid_sha256", message: "SHA256 无效" };
  if (!Array.isArray(value.parts) || value.parts.length < 1 || value.parts.length > 10_000) {
    return { error: "invalid_parts", message: "分片清单无效" };
  }
  const parts: UploadCompleteInput["parts"] = [];
  for (const raw of value.parts) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "invalid_parts", message: "分片清单无效" };
    const part = raw as Record<string, unknown>;
    if (Object.keys(part).some((key) => key !== "part_number" && key !== "etag")
      || !Number.isInteger(part.part_number)
      || (part.part_number as number) < 1
      || typeof part.etag !== "string"
      || !part.etag.trim()
      || part.etag.length > 256) {
      return { error: "invalid_parts", message: "分片清单无效" };
    }
    parts.push({ partNumber: part.part_number as number, etag: part.etag });
  }
  parts.sort((left, right) => left.partNumber - right.partNumber);
  if (parts.some((part, index) => part.partNumber !== index + 1)) {
    return { error: "invalid_parts", message: "分片清单无效" };
  }
  return { upload: { assetId, uploadId, sha256, parts, idempotencyKey } };
}

function uploadError(error: unknown) {
  const code = error instanceof Error ? error.message : "upload_init_failed";
  if (code === "document_idempotency_conflict") return apiError(409, "idempotency_conflict", "该幂等键已用于不同请求", false);
  if (isPgPermission(error)) return apiError(404, "workspace_not_found", "Workspace not found", false);
  if (code.startsWith("invalid_")) return apiError(400, code, "上传参数无效", false);
  return apiError(503, "upload_init_failed", "上传初始化失败", true);
}

function uploadCompleteError(error: unknown) {
  const code = error instanceof Error ? error.message : "upload_complete_failed";
  if (code === "upload_not_found") return apiError(404, code, "Upload not found", false);
  if (code === "upload_completion_idempotency_conflict") {
    return apiError(409, "idempotency_conflict", "该幂等键已用于不同完成请求", false);
  }
  if (code === "upload_metadata_mismatch" || code === "upload_not_completable") {
    return apiError(409, code, "上传状态或对象元数据不匹配", false);
  }
  if (code.startsWith("invalid_")) return apiError(400, code, "上传完成参数无效", false);
  return apiError(503, "upload_complete_failed", "上传完成确认失败", true);
}

function uploadCancelError(error: unknown) {
  const code = error instanceof Error ? error.message : "upload_cancel_failed";
  if (code === "upload_not_found" || isPgPermission(error)) {
    return apiError(404, "upload_not_found", "Upload not found", false);
  }
  if (code === "upload_not_cancellable") {
    return apiError(409, code, "上传已完成，无法取消", false);
  }
  if (code.startsWith("invalid_")) return apiError(400, code, "上传取消参数无效", false);
  return apiError(503, "upload_cancel_failed", "上传取消失败，请重试", true);
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
