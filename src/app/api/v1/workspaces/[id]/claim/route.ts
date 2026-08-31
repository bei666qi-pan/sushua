import { getAuthServer } from "@/features/auth/server";
import { getGuestClaimServer, getGuestSessionServer } from "@/features/auth/guest-server";
import { createWorkspaceClaimHandler } from "@/features/workspace/claim-api";
import { getWorkspaceServer } from "@/features/workspace/server";
import { isFeatureEnabled } from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const enabled = isFeatureEnabled("guest_claim");
  const handler = createWorkspaceClaimHandler({
    enabled,
    readUser: enabled ? async (incoming) => {
      const session = await getAuthServer().api.getSession({ headers: incoming.headers });
      return session?.user ? { id: session.user.id } : null;
    } : undefined,
    guests: enabled ? getGuestSessionServer() : undefined,
    claims: enabled ? getGuestClaimServer() : undefined,
    workspaces: enabled ? getWorkspaceServer() : undefined,
  });
  return handler(request, (await context.params).id);
}
