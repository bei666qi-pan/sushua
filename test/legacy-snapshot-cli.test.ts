import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "sushua-legacy-cli-"));
  const source = path.join(directory, "source.db");
  const snapshot = path.join(directory, "snapshot.db");
  const database = new DatabaseSync(source);
  database.exec(`
    CREATE TABLE banks (id INTEGER PRIMARY KEY, slug TEXT, title TEXT, visibility TEXT, owner_key_hash TEXT, created_at TEXT);
    CREATE TABLE questions (id INTEGER PRIMARY KEY, bank_id INTEGER, type TEXT, stem TEXT, options_json TEXT, answer TEXT, explanation TEXT, sort INTEGER, chapter TEXT);
    CREATE TABLE ai_explanations (question_hash TEXT PRIMARY KEY, content TEXT, tokens_in INTEGER, tokens_out INTEGER, prompt_version INTEGER, created_at TEXT);
    CREATE TABLE usage_log (hour_bucket TEXT PRIMARY KEY, cost_fen REAL, calls INTEGER);
    INSERT INTO banks VALUES (1, 'cli-bank', 'CLI Fixture', 'private', '${"d".repeat(64)}', '2026-09-01 00:00:00');
  `);
  database.close();

  console.log("Legacy snapshot CLI");
  const result = await execFileAsync(process.execPath, [
    "--import", "tsx",
    "scripts/snapshot-legacy-sqlite.ts",
    "--source", source,
    "--snapshot", snapshot,
  ], { cwd: process.cwd() });
  const report = JSON.parse(result.stdout);
  assert.equal(report.snapshotPath, snapshot);
  assert.equal(report.rowCounts.banks, 1);
  assert.equal(report.banks[0]?.slug, "cli-bank");
  const restored = new DatabaseSync(snapshot, { readOnly: true });
  assert.equal((restored.prepare("SELECT COUNT(*) AS count FROM banks").get() as { count: number }).count, 1);
  restored.close();
  console.log("  ✓ 独立进程执行 CLI、输出 JSON，并生成可只读恢复的快照");

  await rm(directory, { recursive: true, force: true });
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
