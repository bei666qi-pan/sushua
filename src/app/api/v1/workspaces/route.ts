import { getCurrentIdentityServer } from "@/features/auth/current-identity-server";
import { createWorkspaceCollectionHandlers } from "@/features/workspace/api";
import { getWorkspaceServer } from "@/features/workspace/server";
import { isFeatureEnabled } from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handlers() {
  const enabled = isFeatureEnabled("workspace_library");
  return createWorkspaceCollectionHandlers({
    enabled,
    identity: enabled ? getCurrentIdentityServer() : undefined,
    workspaces: enabled ? getWorkspaceServer() : undefined,
  });
}

export const GET = (request: Request) => handlers().GET(request);
export const POST = (request: Request) => handlers().POST(request);
