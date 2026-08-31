import { v7 as uuidv7 } from "uuid";
import { createGuestClaimService } from "@/features/auth/guest-claim";
import { createGuestSessionService } from "@/features/auth/guest-session";
import { createWorkspaceModule } from "./module";
import { createLegacyClaimService } from "@/features/legacy/legacy-claim";
import { createLearnerResolutionService } from "@/features/auth/learner-resolution";

type GuestSessions = ReturnType<typeof createGuestSessionService>;
type GuestClaims = ReturnType<typeof createGuestClaimService>;
type Workspaces = ReturnType<typeof createWorkspaceModule>;
type LegacyClaims = ReturnType<typeof createLegacyClaimService>;
type Learners = ReturnType<typeof createLearnerResolutionService>;

export function createWorkspaceClaimHandler(input: {
  enabled: boolean;
  readUser?: (request: Request) => Promise<{ id: string } | null>;
  guests?: GuestSessions;
  claims?: GuestClaims;
  workspaces?: Workspaces;
  legacyClaims?: LegacyClaims;
  learners?: Learners;
}) {
  return async function claim(request: Request, workspaceId: string): Promise<Response> {
    if (!input.enabled) return apiError(404, "not_found", "Not found", false);
    if (!request.headers.get("idempotency-key")?.trim()) {
      return apiError(400, "idempotency_key_required", "需要有效的 Idempotency-Key", false);
    }
    if (!input.readUser) throw new Error("workspace_claim_user_reader_unavailable");

    const user = await input.readUser(request);
    if (!user) return apiError(401, "authentication_required", "请先登录后再认领", false);
    const body = await optionalJson(request);
    if ("error" in body) return apiError(400, "invalid_json", "请求格式错误", false);
    if (typeof body.value.legacy_owner_key === "string") {
      if (!input.legacyClaims || !input.learners) throw new Error("legacy_claim_dependencies_unavailable");
      const learnerId = await input.learners.forUser(user.id);
      try {
        const result = await input.legacyClaims.claim(
          { learnerId, userId: user.id, workspaceId },
          { ownerKey: body.value.legacy_owner_key },
        );
        return Response.json({
          data: { status: result.status, learner_id: result.learnerId, workspace_id: result.workspaceId },
          meta: { request_id: uuidv7(), schema_version: "sushua.api.v1" },
        });
      } catch (error) {
        return legacyClaimError(error);
      }
    }

    if (!input.guests || !input.claims || !input.workspaces) {
      throw new Error("guest_claim_dependencies_unavailable");
    }
    const capability = readCookie(request.headers.get("cookie"), "sushua.guest");
    const proof = capability ? await input.guests.getClaimProof(capability) : undefined;
    if (!proof) return apiError(401, "guest_proof_required", "游客证明无效或已过期", false);

    const owned = await input.workspaces.getOwnedWorkspace({
      learnerId: proof.learnerId,
      workspaceId,
    });
    if (!owned) return apiError(404, "workspace_not_found", "未找到可认领的资料库", false);

    const result = await input.claims.claim(
      { learnerId: proof.learnerId, userId: user.id },
      { tokenHash: proof.tokenHash },
    );
    if (result.status === "conflict") {
      return Response.json({
        error: {
          code: "learner_merge_required",
          message: "该账号已有学习资料，需要确认后合并",
          retryable: false,
          details: { existing_learner_id: result.existingLearnerId },
        },
        request_id: uuidv7(),
      }, { status: 409 });
    }
    return Response.json({
      data: { status: result.status, learner_id: result.learnerId },
      meta: { request_id: uuidv7(), schema_version: "sushua.api.v1" },
    });
  };
}

async function optionalJson(request: Request): Promise<{ value: Record<string, unknown> } | { error: true }> {
  const text = await request.text();
  if (!text) return { value: {} };
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? { value: value as Record<string, unknown> } : { error: true };
  } catch {
    return { error: true };
  }
}

function legacyClaimError(error: unknown): Response {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("invalid_legacy_owner_key")) {
    return apiError(401, "invalid_legacy_owner_key", "旧管理凭证无效", false);
  }
  if (message.includes("legacy_mapping_not_found") || message.includes("legacy_workspace_not_found")) {
    return apiError(404, "workspace_not_found", "未找到可认领的旧资料库", false);
  }
  if (message.includes("legacy_workspace_already_claimed")) {
    return apiError(409, "workspace_already_claimed", "该旧资料库已被其他账号认领", false);
  }
  throw error;
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator >= 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function apiError(status: number, code: string, message: string, retryable: boolean) {
  return Response.json({ error: { code, message, retryable }, request_id: uuidv7() }, { status });
}
