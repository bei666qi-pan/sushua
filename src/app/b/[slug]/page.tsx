import { QuizApp } from "@/components/quiz-app";
import { isFeatureEnabled } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";

export default async function BankPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ claim?: string }>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const legacyClaimEnabled = isFeatureEnabled("guest_claim") && isFeatureEnabled("workspace_library");
  return (
    <QuizApp
      slug={slug}
      legacyClaimEnabled={legacyClaimEnabled}
      pendingLegacyClaim={legacyClaimEnabled && query.claim === "1"}
    />
  );
}
