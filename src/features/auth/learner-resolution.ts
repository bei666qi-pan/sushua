import { v7 as uuidv7 } from "uuid";
import type { PostgresRuntime } from "@/db/postgres/runtime";

export function createLearnerResolutionService(runtime: PostgresRuntime) {
  return {
    async forUser(userId: string): Promise<string> {
      const candidateId = uuidv7();
      return runtime.withTenant({ learnerId: candidateId, userId }, async ({ query }) => {
        const result = await query<{ learner_id: string }>(
          "SELECT resolve_authenticated_learner($1) AS learner_id",
          [candidateId],
        );
        const learnerId = result.rows[0]?.learner_id;
        if (!learnerId) throw new Error("authenticated_learner_resolution_failed");
        return learnerId;
      });
    },
  };
}
