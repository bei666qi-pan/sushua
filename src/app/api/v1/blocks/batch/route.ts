import { getCurrentIdentityServer } from "@/features/auth/current-identity-server";
import { createDocumentRevisionBatchHandler } from "@/features/documents/document-revision-api";
import { getDocumentRevisionServer } from "@/features/documents/document-revision-server";
import { isFeatureEnabled } from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handler() {
  const enabled = isFeatureEnabled("source_review");
  return createDocumentRevisionBatchHandler({
    enabled,
    identity: enabled ? getCurrentIdentityServer() : undefined,
    revisions: enabled ? getDocumentRevisionServer() : undefined,
  });
}

export function PATCH(request: Request) {
  return handler()(request);
}
