import type { PostgresRuntime } from "@/db/postgres/runtime";

type ClaimContext = {
  learnerId: string;
  userId: string;
};

type ClaimResult =
  | { status: "claimed" | "already_claimed"; learnerId: string }
  | { status: "conflict"; learnerId: string; existingLearnerId: string };

export function createGuestClaimService(runtime: PostgresRuntime) {
  return {
    async claim(context: ClaimContext, input: { tokenHash: string }): Promise<ClaimResult> {
      return runtime.withTenant(context, async ({ query }) => {
        const result = await query<{
          status: ClaimResult["status"];
          learner_id: string;
          existing_learner_id: string | null;
        }>("SELECT * FROM claim_guest_learner($1)", [input.tokenHash]);
        const row = result.rows[0];
        if (!row) throw new Error("guest_claim_no_result");
        if (row.status === "conflict") {
          if (!row.existing_learner_id) throw new Error("guest_claim_conflict_missing_learner");
          return {
            status: "conflict",
            learnerId: row.learner_id,
            existingLearnerId: row.existing_learner_id,
          };
        }
        return { status: row.status, learnerId: row.learner_id };
      });
    },
  };
}
