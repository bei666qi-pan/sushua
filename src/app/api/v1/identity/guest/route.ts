import { createGuestBootstrapHandler } from "@/features/auth/guest-bootstrap-api";
import { getGuestSessionServer } from "@/features/auth/guest-server";
import { isFeatureEnabled } from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request) {
  const enabled = isFeatureEnabled("guest_claim");
  return createGuestBootstrapHandler({
    sessions: enabled ? getGuestSessionServer() : undefined,
    enabled,
  })(request);
}
