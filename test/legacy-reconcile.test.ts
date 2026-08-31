import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { promisify } from "node:util";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { backfillLegacyWorkspaces } from "../src/features/legacy/legacy-backfill";
import { createLegacySnapshot } from "../src/features/legacy/legacy-snapshot";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;
const execFileAsync = promisify(execFile);

async function main() {
  const reconcileModule = await import("../src/features/legacy/legacy-reconcile").catch(() => null);
  assert.ok(reconcileModule, "legacy reconciliation module must exist");
  assert.equal(typeof reconcileModule.reconcileLegacyWorkspaces, "function");

  const directory = await mkdtemp(path.join(tmpdir(), "sushua-legacy-reconcile-"));
  const sourcePath = path.join(directory, "source.db");
  const snapshotPath = path.join(directory, "snapshot.db");
  const source = new DatabaseSync(sourcePath);
  source.exec(`
    CREATE TABLE banks (id INTEGER PRIMARY KEY, slug TEXT, title TEXT, visibility TEXT, owner_key_hash TEXT, created_at TEXT);
    CREATE TABLE questions (id INTEGER PRIMARY KEY, bank_id INTEGER, type TEXT, stem TEXT, options_json TEXT, answer TEXT, explanation TEXT, sort INTEGER, chapter TEXT);
    CREATE TABLE ai_explanations (question_hash TEXT PRIMARY KEY, content TEXT, tokens_in INTEGER, tokens_out INTEGER, prompt_version INTEGER, created_at TEXT);
    CREATE TABLE usage_log (hour_bucket TEXT PRIMARY KEY, cost_fen REAL, calls INTEGER);
    INSERT INTO banks VALUES (1, 'reconcile-one', '对账题库', 'unlisted', '${"a".repeat(64)}', '2026-08-01 00:00:00');
    INSERT INTO questions VALUES (1, 1, 'single', '题干', '["A","B"]', 'A', '', 0, '');
  `);
  await createLegacySnapshot({ sourcePath, snapshotPath });

  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await pool.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(pool);
  await backfillLegacyWorkspaces(pool, { snapshotPath, dryRun: false });

  console.log("Legacy Workspace reconciliation");
  const matched = await reconcileModule.reconcileLegacyWorkspaces(pool, { snapshotPath });
  assert.deepEqual(matched.summary, { total: 1, matched: 1, missing: 0, drifted: 0 });
  assert.deepEqual(matched.items, [{ legacyBankId: "1", slug: "reconcile-one", status: "matched", reasons: [] }]);
  console.log("  ✓ checksum、title、visibility、owner hash 与唯一 owner 一致时报告 matched");

  const scriptPath = path.join(process.cwd(), "scripts/reconcile-legacy-workspaces.ts");
  assert.equal(existsSync(scriptPath), true, "legacy reconciliation CLI must exist");
  const cli = await execFileAsync(process.execPath, [
    "--import", "tsx",
    scriptPath,
    "--snapshot", snapshotPath,
  ], { cwd: process.cwd(), env: { ...process.env, DATABASE_DIRECT_URL: databaseUrl } });
  assert.deepEqual(JSON.parse(cli.stdout).summary, { total: 1, matched: 1, missing: 0, drifted: 0 });
  console.log("  ✓ 独立 CLI 使用 direct URL 输出机器可读对账报告");

  await pool.query("UPDATE workspaces SET title = '被篡改的名称' WHERE slug = 'reconcile-one'");
  await pool.query("UPDATE legacy_bank_mappings SET checksum = $1 WHERE legacy_slug = 'reconcile-one'", ["f".repeat(64)]);
  const drifted = await reconcileModule.reconcileLegacyWorkspaces(pool, { snapshotPath });
  assert.deepEqual(drifted.summary, { total: 1, matched: 0, missing: 0, drifted: 1 });
  assert.deepEqual(drifted.items[0], {
    legacyBankId: "1",
    slug: "reconcile-one",
    status: "drifted",
    reasons: ["checksum_changed", "title_changed"],
  });
  assert.equal((await pool.query("SELECT title FROM workspaces WHERE slug = 'reconcile-one'")).rows[0]?.title, "被篡改的名称");
  console.log("  ✓ 多项漂移精确列出且对账本身不修改数据");

  let driftExit: unknown;
  try {
    await execFileAsync(process.execPath, ["--import", "tsx", scriptPath, "--snapshot", snapshotPath], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_DIRECT_URL: databaseUrl },
    });
  } catch (error) {
    driftExit = error;
  }
  const cliError = driftExit as { code?: number; stdout?: string };
  assert.equal(cliError.code, 2);
  assert.equal(JSON.parse(cliError.stdout ?? "{}").summary.drifted, 1);
  console.log("  ✓ CLI 发现漂移时返回退出码 2，可直接阻断读切换");

  await pool.query("DELETE FROM workspaces WHERE slug = 'reconcile-one'");
  const missing = await reconcileModule.reconcileLegacyWorkspaces(pool, { snapshotPath });
  assert.deepEqual(missing.summary, { total: 1, matched: 0, missing: 1, drifted: 0 });
  assert.deepEqual(missing.items[0], { legacyBankId: "1", slug: "reconcile-one", status: "missing", reasons: ["mapping_missing"] });
  console.log("  ✓ 映射缺失明确报告 missing，不伪造一致");

  source.close();
  await pool.end();
  await rm(directory, { recursive: true, force: true });
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
