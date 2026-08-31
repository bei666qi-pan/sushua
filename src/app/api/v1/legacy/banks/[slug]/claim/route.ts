import { getAuthServer } from "@/features/auth/server";
import { createLegacyBankClaimHandler } from "@/features/legacy/legacy-bank-claim-api";
import { getLegacyClaimServer, getLearnerResolutionServer } from "@/features/legacy/server";
import { isFeatureEnabled } from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  const enabled = isFeatureEnabled("guest_claim");
  const handler = createLegacyBankClaimHandler({
    enabled,
    readUser: enabled ? async (incoming) => {
      const session = await getAuthServer().api.getSession({ headers: incoming.headers });
      return session?.user ? { id: session.user.id } : null;
    } : undefined,
    claims: enabled ? getLegacyClaimServer() : undefined,
    learners: enabled ? getLearnerResolutionServer() : undefined,
  });
  return handler(request, (await context.params).slug);
}
