import { getCurrentIdentityServer } from "@/features/auth/current-identity-server";
import { createUploadInitHandler } from "@/features/uploads/api";
import { getUploadServer } from "@/features/uploads/server";
import { isFeatureEnabled } from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handler() {
  const enabled = isFeatureEnabled("async_ingestion");
  return createUploadInitHandler({
    enabled,
    identity: enabled ? getCurrentIdentityServer() : undefined,
    uploads: enabled ? getUploadServer() : undefined,
  });
}

export function POST(request: Request) {
  return handler()(request);
}
