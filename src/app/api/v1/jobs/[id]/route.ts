import { getCurrentIdentityServer } from "@/features/auth/current-identity-server";
import { createJobHandlers } from "@/features/jobs/api";
import { getJobServer } from "@/features/jobs/server";
import { isFeatureEnabled } from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handlers() {
  const enabled = isFeatureEnabled("async_ingestion");
  return createJobHandlers({
    enabled,
    identity: enabled ? getCurrentIdentityServer() : undefined,
    jobs: enabled ? getJobServer() : undefined,
  });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handlers().GET(request, (await context.params).id);
}
