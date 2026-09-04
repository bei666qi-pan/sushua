import { getCurrentIdentityServer } from "@/features/auth/current-identity-server";
import { createDocumentSourceHandlers } from "@/features/documents/source-api";
import { getBlockSourceServer } from "@/features/documents/block-source-server";
import { isFeatureEnabled } from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handlers() {
  const enabled = isFeatureEnabled("source_review");
  return createDocumentSourceHandlers({
    enabled,
    identity: enabled ? getCurrentIdentityServer() : undefined,
    source: enabled ? getBlockSourceServer() : undefined,
  });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handlers().GET_BLOCK_SOURCE(request, (await context.params).id);
}
