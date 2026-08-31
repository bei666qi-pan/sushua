import type { Pool, PoolClient } from "pg";
import { v7 as uuidv7 } from "uuid";
import { readLegacySnapshotData, type LegacyBankData } from "./legacy-snapshot";

type BackfillItem = {
  legacyBankId: string;
  slug: string;
  status: "ready" | "created" | "replayed" | "conflict";
  questionsPending: number;
  reason?: string;
};

export type LegacyBackfillReport = {
  dryRun: boolean;
  committed: boolean;
  sourceRowCounts: ReturnType<typeof readLegacySnapshotData>["rowCounts"];
  questionsPending: number;
  items: BackfillItem[];
};

export async function backfillLegacyWorkspaces(pool: Pool, input: {
  snapshotPath: string;
  dryRun?: boolean;
}): Promise<LegacyBackfillReport> {
  const dryRun = input.dryRun ?? true;
  const source = readLegacySnapshotData(input.snapshotPath);
  const client = await pool.connect();
  const items: BackfillItem[] = [];
  try {
    await client.query("BEGIN");
    for (const bank of source.banks) items.push(await backfillBank(client, bank, dryRun));
    const hasConflict = items.some((item) => item.status === "conflict");
    if (dryRun || hasConflict) await client.query("ROLLBACK");
    else await client.query("COMMIT");
    return {
      dryRun,
      committed: !dryRun && !hasConflict,
      sourceRowCounts: source.rowCounts,
      questionsPending: source.rowCounts.questions,
      items,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function backfillBank(client: PoolClient, bank: LegacyBankData, dryRun: boolean): Promise<BackfillItem> {
  const base = {
    legacyBankId: bank.legacyBankId,
    slug: bank.slug,
    questionsPending: bank.questions.length,
  };
  const validationError = validateBank(bank);
  if (validationError) return { ...base, status: "conflict", reason: validationError };

  const existing = await client.query<{
    legacy_bank_id: string;
    legacy_slug: string;
    checksum: string;
  }>(
    `SELECT legacy_bank_id, legacy_slug, checksum
     FROM legacy_bank_mappings
     WHERE legacy_bank_id = $1 OR legacy_slug = $2`,
    [bank.legacyBankId, bank.slug],
  );
  if (existing.rows.length > 0) {
    const exact = existing.rows.find((row) =>
      row.legacy_bank_id === bank.legacyBankId && row.legacy_slug === bank.slug,
    );
    if (!exact) return { ...base, status: "conflict", reason: "mapping_identity_conflict" };
    return exact.checksum === bank.checksum
      ? { ...base, status: "replayed" }
      : { ...base, status: "conflict", reason: "checksum_changed" };
  }

  const occupied = await client.query("SELECT id FROM workspaces WHERE slug = $1", [bank.slug]);
  if (occupied.rowCount) return { ...base, status: "conflict", reason: "workspace_slug_taken" };

  const learnerId = uuidv7();
  const workspaceId = uuidv7();
  await client.query("INSERT INTO learners (id) VALUES ($1)", [learnerId]);
  await client.query(
    `INSERT INTO workspaces (
       id, slug, title, visibility, created_by_learner_id, detected_mode, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'question_bank', $6, $6)`,
    [workspaceId, bank.slug, bank.title, mapVisibility(bank.visibility), learnerId, sqliteUtc(bank.createdAt)],
  );
  await client.query(
    "INSERT INTO workspace_members (workspace_id, learner_id, role, created_at) VALUES ($1, $2, 'owner', $3)",
    [workspaceId, learnerId, sqliteUtc(bank.createdAt)],
  );
  await client.query(
    `INSERT INTO legacy_bank_mappings (
       legacy_bank_id, legacy_slug, workspace_id, owner_key_hash, checksum
     ) VALUES ($1, $2, $3, $4, $5)`,
    [bank.legacyBankId, bank.slug, workspaceId, bank.ownerKeyHash, bank.checksum],
  );
  return { ...base, status: dryRun ? "ready" : "created" };
}

function validateBank(bank: LegacyBankData): string | undefined {
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(bank.slug)) return "invalid_legacy_slug";
  if (!/^[0-9a-f]{64}$/.test(bank.ownerKeyHash)) return "invalid_owner_key_hash";
  if (!Number.isFinite(Date.parse(sqliteUtc(bank.createdAt)))) return "invalid_created_at";
  if (!(["private", "unlisted", "public"] as string[]).includes(bank.visibility)) return "invalid_visibility";
  return undefined;
}

function mapVisibility(value: string): "private" | "link" | "public" {
  if (value === "unlisted") return "link";
  if (value === "public") return "public";
  return "private";
}

function sqliteUtc(value: string): string {
  return value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
}
