import { createHash } from "node:crypto";
import type { PostgresRuntime } from "@/db/postgres/runtime";

type LegacyClaimContext = {
  learnerId: string;
  userId: string;
  workspaceId: string;
};

type LegacyClaimResult = {
  status: "claimed" | "already_claimed";
  learnerId: string;
  workspaceId: string;
};

export function createLegacyClaimService(runtime: PostgresRuntime) {
  return {
    async claim(context: LegacyClaimContext, input: { ownerKey: string }): Promise<LegacyClaimResult> {
      if (!/^[0-9a-f]{32}$/i.test(input.ownerKey)) throw new Error("invalid_legacy_owner_key_format");
      const ownerKeyHash = createHash("sha256").update(input.ownerKey).digest("hex");
      return runtime.withTenant(context, async ({ query }) => {
        const result = await query<{ status: LegacyClaimResult["status"]; learner_id: string; workspace_id: string }>(
          "SELECT * FROM claim_legacy_workspace($1)",
          [ownerKeyHash],
        );
        const row = result.rows[0];
        if (!row) throw new Error("legacy_claim_no_result");
        return { status: row.status, learnerId: row.learner_id, workspaceId: row.workspace_id };
      });
    },

    async claimBySlug(
      context: Omit<LegacyClaimContext, "workspaceId">,
      input: { slug: string; ownerKey: string },
    ): Promise<LegacyClaimResult> {
      if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(input.slug)) throw new Error("invalid_legacy_slug_format");
      if (!/^[0-9a-f]{32}$/i.test(input.ownerKey)) throw new Error("invalid_legacy_owner_key_format");
      const ownerKeyHash = createHash("sha256").update(input.ownerKey).digest("hex");
      return runtime.withTenant(context, async ({ query }) => {
        const result = await query<{ status: LegacyClaimResult["status"]; learner_id: string; workspace_id: string }>(
          "SELECT * FROM claim_legacy_workspace_by_slug($1, $2)",
          [input.slug, ownerKeyHash],
        );
        const row = result.rows[0];
        if (!row) throw new Error("legacy_claim_no_result");
        return { status: row.status, learnerId: row.learner_id, workspaceId: row.workspace_id };
      });
    },
  };
}
