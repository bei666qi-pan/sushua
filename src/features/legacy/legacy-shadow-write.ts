import { v7 as uuidv7 } from "uuid";
import type { PostgresRuntime } from "@/db/postgres/runtime";
import type { LegacyBankData } from "./legacy-snapshot";

type ShadowSyncResult = {
  status: "created" | "updated" | "replayed";
  workspaceId: string;
};

export function createLegacyShadowWriteService(runtime: PostgresRuntime) {
  return {
    async sync(bank: LegacyBankData): Promise<ShadowSyncResult> {
      validateBank(bank);
      const learnerId = uuidv7();
      const workspaceId = uuidv7();
      return runtime.withTenant({ learnerId }, async ({ query }) => {
        const result = await query<{ status: ShadowSyncResult["status"]; result_workspace_id: string }>(
          "SELECT * FROM shadow_sync_legacy_workspace($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            bank.legacyBankId,
            bank.slug,
            bank.title,
            mapVisibility(bank.visibility),
            bank.ownerKeyHash,
            bank.checksum,
            sqliteUtc(bank.createdAt),
            learnerId,
            workspaceId,
          ],
        );
        const row = result.rows[0];
        if (!row) throw new Error("legacy_shadow_sync_no_result");
        return { status: row.status, workspaceId: row.result_workspace_id };
      });
    },

    async remove(input: { slug: string; ownerKeyHash: string }): Promise<{
      status: "deleted" | "missing";
      workspaceId?: string;
    }> {
      if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(input.slug)) throw new Error("invalid_legacy_slug");
      if (!/^[0-9a-f]{64}$/.test(input.ownerKeyHash)) throw new Error("invalid_owner_key_hash");
      return runtime.withTenant({ learnerId: uuidv7() }, async ({ query }) => {
        const result = await query<{ status: "deleted" | "missing"; result_workspace_id: string | null }>(
          "SELECT * FROM shadow_delete_legacy_workspace($1,$2)",
          [input.slug, input.ownerKeyHash],
        );
        const row = result.rows[0];
        if (!row) throw new Error("legacy_shadow_delete_no_result");
        return { status: row.status, ...(row.result_workspace_id ? { workspaceId: row.result_workspace_id } : {}) };
      });
    },
  };
}

function validateBank(bank: LegacyBankData) {
  if (!/^[0-9]+$/.test(bank.legacyBankId)) throw new Error("invalid_legacy_bank_id");
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(bank.slug)) throw new Error("invalid_legacy_slug");
  if (!bank.title || bank.title.length > 80) throw new Error("invalid_legacy_title");
  if (!(["private", "unlisted", "public"] as string[]).includes(bank.visibility)) throw new Error("invalid_visibility");
  if (!/^[0-9a-f]{64}$/.test(bank.ownerKeyHash) || !/^[0-9a-f]{64}$/.test(bank.checksum)) throw new Error("invalid_legacy_hash");
  if (!Number.isFinite(Date.parse(sqliteUtc(bank.createdAt)))) throw new Error("invalid_created_at");
}

function mapVisibility(value: string) {
  if (value === "unlisted") return "link";
  if (value === "public") return "public";
  return "private";
}

function sqliteUtc(value: string) {
  return value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
}
