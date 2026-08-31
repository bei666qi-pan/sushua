import { getPostgresServerRuntime } from "@/db/postgres/server";
import { createLearnerResolutionService } from "@/features/auth/learner-resolution";
import { createLegacyClaimService } from "./legacy-claim";

export function getLegacyClaimServer() {
  return createLegacyClaimService(getPostgresServerRuntime());
}

export function getLearnerResolutionServer() {
  return createLearnerResolutionService(getPostgresServerRuntime());
}
