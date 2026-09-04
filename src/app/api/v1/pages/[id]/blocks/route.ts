import { getCurrentIdentityServer } from "@/features/auth/current-identity-server";
import { createDocumentSourceHandlers } from "@/features/documents/source-api";
import { getDocumentSourceServer } from "@/features/documents/source-server";
import { isFeatureEnabled } from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handlers() {
  const enabled = isFeatureEnabled("source_review");
  return createDocumentSourceHandlers({
    enabled,
    identity: enabled ? getCurrentIdentityServer() : undefined,
    sources: enabled ? getDocumentSourceServer() : undefined,
  });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handlers().LIST_BLOCKS(request, (await context.params).id);
}
