import type { Pool } from "pg";
import { readLegacySnapshotData, type LegacyBankData } from "./legacy-snapshot";

type ReconciliationStatus = "matched" | "missing" | "drifted";

type ReconciliationItem = {
  legacyBankId: string;
  slug: string;
  status: ReconciliationStatus;
  reasons: string[];
};

export type LegacyReconciliationReport = {
  sourceRowCounts: ReturnType<typeof readLegacySnapshotData>["rowCounts"];
  summary: { total: number; matched: number; missing: number; drifted: number };
  items: ReconciliationItem[];
};

type MappingRow = {
  legacy_bank_id: string;
  legacy_slug: string;
  checksum: string;
  owner_key_hash: string;
  title: string;
  visibility: string;
  deleted_at: Date | null;
  owner_count: number;
  owner_matches_creator: boolean;
};

export async function reconcileLegacyWorkspaces(pool: Pool, input: {
  snapshotPath: string;
}): Promise<LegacyReconciliationReport> {
  const source = readLegacySnapshotData(input.snapshotPath);
  const items: ReconciliationItem[] = [];
  for (const bank of source.banks) items.push(await reconcileBank(pool, bank));
  return {
    sourceRowCounts: source.rowCounts,
    summary: {
      total: items.length,
      matched: items.filter((item) => item.status === "matched").length,
      missing: items.filter((item) => item.status === "missing").length,
      drifted: items.filter((item) => item.status === "drifted").length,
    },
    items,
  };
}

async function reconcileBank(pool: Pool, bank: LegacyBankData): Promise<ReconciliationItem> {
  const result = await pool.query<MappingRow>(
    `SELECT
       lbm.legacy_bank_id,
       lbm.legacy_slug,
       lbm.checksum,
       lbm.owner_key_hash,
       w.title,
       w.visibility::text,
       w.deleted_at,
       (SELECT COUNT(*)::int FROM workspace_members wm WHERE wm.workspace_id = w.id AND wm.role = 'owner') AS owner_count,
       EXISTS (
         SELECT 1 FROM workspace_members wm
         WHERE wm.workspace_id = w.id AND wm.role = 'owner' AND wm.learner_id = w.created_by_learner_id
       ) AS owner_matches_creator
     FROM legacy_bank_mappings lbm
     JOIN workspaces w ON w.id = lbm.workspace_id
     WHERE lbm.legacy_bank_id = $1 OR lbm.legacy_slug = $2
     ORDER BY lbm.legacy_bank_id`,
    [bank.legacyBankId, bank.slug],
  );
  if (result.rows.length === 0) return item(bank, "missing", ["mapping_missing"]);
  if (result.rows.length !== 1) return item(bank, "drifted", ["mapping_identity_conflict"]);

  const row = result.rows[0];
  const reasons: string[] = [];
  if (row.legacy_bank_id !== bank.legacyBankId || row.legacy_slug !== bank.slug) reasons.push("mapping_identity_conflict");
  if (row.checksum !== bank.checksum) reasons.push("checksum_changed");
  if (row.title !== bank.title) reasons.push("title_changed");
  if (row.visibility !== mapVisibility(bank.visibility)) reasons.push("visibility_changed");
  if (row.owner_key_hash !== bank.ownerKeyHash) reasons.push("owner_key_hash_changed");
  if (row.deleted_at) reasons.push("workspace_deleted");
  if (row.owner_count !== 1 || !row.owner_matches_creator) reasons.push("owner_invariant_broken");
  return item(bank, reasons.length === 0 ? "matched" : "drifted", reasons);
}

function item(bank: LegacyBankData, status: ReconciliationStatus, reasons: string[]): ReconciliationItem {
  return { legacyBankId: bank.legacyBankId, slug: bank.slug, status, reasons };
}

function mapVisibility(value: string) {
  if (value === "unlisted") return "link";
  if (value === "public") return "public";
  return "private";
}
