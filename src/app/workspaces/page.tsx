import { notFound } from "next/navigation";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { WorkspaceLibrary } from "./workspace-library";
import { parsePendingClaim } from "@/features/workspace/navigation";

export const dynamic = "force-dynamic";

export default async function WorkspacesPage({ searchParams }: { searchParams: Promise<{ claim?: string }> }) {
  if (!isFeatureEnabled("workspace_library")) notFound();
  const pendingClaimId = parsePendingClaim((await searchParams).claim);
  return <WorkspaceLibrary pendingClaimId={pendingClaimId} />;
}
