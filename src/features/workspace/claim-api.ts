import { v7 as uuidv7 } from "uuid";
import { createGuestClaimService } from "@/features/auth/guest-claim";
import { createGuestSessionService } from "@/features/auth/guest-session";
import { createWorkspaceModule } from "./module";

type GuestSessions = ReturnType<typeof createGuestSessionService>;
type GuestClaims = ReturnType<typeof createGuestClaimService>;
type Workspaces = ReturnType<typeof createWorkspaceModule>;

export function createWorkspaceClaimHandler(input: {
  enabled: boolean;
  readUser?: (request: Request) => Promise<{ id: string } | null>;
  guests?: GuestSessions;
  claims?: GuestClaims;
  workspaces?: Workspaces;
}) {
  return async function claim(request: Request, workspaceId: string): Promise<Response> {
    if (!input.enabled) return apiError(404, "not_found", "Not found", false);
    if (!request.headers.get("idempotency-key")?.trim()) {
      return apiError(400, "idempotency_key_required", "需要有效的 Idempotency-Key", false);
    }
    if (!input.readUser || !input.guests || !input.claims || !input.workspaces) {
      throw new Error("workspace_claim_dependencies_unavailable");
    }

    const user = await input.readUser(request);
    if (!user) return apiError(401, "authentication_required", "请先登录后再认领", false);
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
