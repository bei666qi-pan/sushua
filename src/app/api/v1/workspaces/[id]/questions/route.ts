import { getCurrentIdentityServer } from "@/features/auth/current-identity-server";
import { createQuestionReadHandlers } from "@/features/questions/question-read-api";
import { getQuestionReadServer } from "@/features/questions/question-read-server";
import { isFeatureEnabled } from "@/lib/feature-flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const enabled = isFeatureEnabled("grounded_generation");
  return createQuestionReadHandlers({ enabled, ...(enabled ? { identity: getCurrentIdentityServer(), reader: getQuestionReadServer() } : {}) }).LIST(request, (await context.params).id);
}
