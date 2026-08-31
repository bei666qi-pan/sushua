import { getCurrentIdentityServer } from "@/features/auth/current-identity-server";
import { createUploadCompleteHandler } from "@/features/uploads/api";
import { getUploadServer } from "@/features/uploads/server";
import { isFeatureEnabled } from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const enabled = isFeatureEnabled("async_ingestion");
  return createUploadCompleteHandler({
    enabled,
    identity: enabled ? getCurrentIdentityServer() : undefined,
    uploads: enabled ? getUploadServer() : undefined,
  })(request, (await context.params).id);
}
