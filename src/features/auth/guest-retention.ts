import { v7 as uuidv7 } from "uuid";
import type { PostgresRuntime } from "@/db/postgres/runtime";

type PurgeResult = {
  purgedSessions: number;
  purgedLearners: number;
  purgedWorkspaces: number;
};

export function createGuestRetentionService(runtime: PostgresRuntime) {
  return {
    async purgeExpired(input: { before: Date; limit: number }): Promise<PurgeResult> {
      if (!Number.isFinite(input.before.getTime())) throw new Error("invalid_guest_cleanup_cutoff");
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000) {
        throw new Error("invalid_guest_cleanup_limit");
      }

      return runtime.withTenant({ learnerId: uuidv7() }, async ({ query }) => {
        const result = await query<{
          purged_sessions: number;
          purged_learners: number;
          purged_workspaces: number;
        }>("SELECT * FROM purge_expired_guest_learners($1,$2)", [input.before, input.limit]);
        const row = result.rows[0];
        if (!row) throw new Error("guest_cleanup_no_result");
        return {
          purgedSessions: row.purged_sessions,
          purgedLearners: row.purged_learners,
          purgedWorkspaces: row.purged_workspaces,
        };
      });
    },
  };
}
