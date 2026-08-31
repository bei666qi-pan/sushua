import { v7 as uuidv7 } from "uuid";
import { createLearnerResolutionService } from "@/features/auth/learner-resolution";
import { createLegacyClaimService } from "./legacy-claim";

type LegacyClaims = ReturnType<typeof createLegacyClaimService>;
type Learners = ReturnType<typeof createLearnerResolutionService>;

export function createLegacyBankClaimHandler(input: {
  enabled: boolean;
  readUser?: (request: Request) => Promise<{ id: string } | null>;
  claims?: LegacyClaims;
  learners?: Learners;
}) {
  return async function claim(request: Request, legacySlug: string): Promise<Response> {
    if (!input.enabled) return apiError(404, "not_found", "Not found", false);
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 200) {
      return apiError(400, "idempotency_key_required", "需要有效的 Idempotency-Key", false);
    }
    if (!input.readUser) throw new Error("legacy_bank_claim_user_reader_unavailable");

    const user = await input.readUser(request);
    if (!user) return apiError(401, "authentication_required", "请先登录后再认领", false);

    const body = await readBody(request);
    if ("error" in body) return apiError(400, body.error, body.message, false);
    if (!input.claims || !input.learners) throw new Error("legacy_bank_claim_dependencies_unavailable");

    const learnerId = await input.learners.forUser(user.id);
    try {
      const result = await input.claims.claimBySlug(
        { learnerId, userId: user.id },
        { slug: legacySlug, ownerKey: body.ownerKey },
      );
      return Response.json({
        data: {
          status: result.status,
          learner_id: result.learnerId,
          workspace_id: result.workspaceId,
        },
        meta: { request_id: uuidv7(), schema_version: "sushua.api.v1" },
      });
    } catch (error) {
      return mapClaimError(error);
    }
  };
}

async function readBody(request: Request): Promise<
  { ownerKey: string } | { error: string; message: string }
> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { error: "invalid_json", message: "请求格式错误" };
  }
  if (!body || typeof body !== "object" || typeof (body as Record<string, unknown>).owner_key !== "string") {
    return { error: "owner_key_required", message: "缺少旧管理凭证" };
  }
  return { ownerKey: (body as { owner_key: string }).owner_key };
}

function mapClaimError(error: unknown): Response {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("invalid_legacy_owner_key")) {
    return apiError(401, "invalid_legacy_owner_key", "旧管理凭证无效", false);
  }
  if (message.includes("invalid_legacy_slug_format") || message.includes("legacy_mapping_not_found") || message.includes("legacy_workspace_not_found")) {
    return apiError(404, "workspace_not_found", "未找到可认领的旧资料库", false);
  }
  if (message.includes("legacy_workspace_already_claimed")) {
    return apiError(409, "workspace_already_claimed", "该旧资料库已被其他账号认领", false);
  }
  throw error;
}

function apiError(status: number, code: string, message: string, retryable: boolean) {
  return Response.json({ error: { code, message, retryable }, request_id: uuidv7() }, { status });
}
