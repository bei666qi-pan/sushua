import { notFound } from "next/navigation";
import { SourceReviewPanel } from "@/features/documents/source-review-panel";
import { isFeatureEnabled } from "@/lib/feature-flags";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const dynamic = "force-dynamic";

export default async function SourceReviewPage({ params }: { params: Promise<{ documentVersionId: string }> }) {
  if (!isFeatureEnabled("source_review")) notFound();
  const { documentVersionId } = await params;
  if (!UUID_V7.test(documentVersionId)) notFound();
  return <SourceReviewPanel documentVersionId={documentVersionId} />;
}
