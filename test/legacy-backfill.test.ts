import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { backfillLegacyWorkspaces } from "../src/features/legacy/legacy-backfill";
import { createLegacySnapshot } from "../src/features/legacy/legacy-snapshot";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;

function createFixture(sourcePath: string) {
  const database = new DatabaseSync(sourcePath);
  database.exec(`
    CREATE TABLE banks (id INTEGER PRIMARY KEY, slug TEXT, title TEXT, visibility TEXT, owner_key_hash TEXT, created_at TEXT);
    CREATE TABLE questions (id INTEGER PRIMARY KEY, bank_id INTEGER, type TEXT, stem TEXT, options_json TEXT, answer TEXT, explanation TEXT, sort INTEGER, chapter TEXT);
    CREATE TABLE ai_explanations (question_hash TEXT PRIMARY KEY, content TEXT, tokens_in INTEGER, tokens_out INTEGER, prompt_version INTEGER, created_at TEXT);
    CREATE TABLE usage_log (hour_bucket TEXT PRIMARY KEY, cost_fen REAL, calls INTEGER);
    INSERT INTO banks VALUES (1, 'legacy-one', '旧题库一', 'private', '${"a".repeat(64)}', '2026-07-01 00:00:00');
    INSERT INTO banks VALUES (2, 'legacy-two', '旧题库二', 'unlisted', '${"b".repeat(64)}', '2026-07-02 00:00:00');
    INSERT INTO questions VALUES (11, 1, 'single', '第一题', '["A","B"]', 'A', '', 0, '第一章');
    INSERT INTO questions VALUES (12, 1, 'judge', '第二题', '[]', '对', '', 1, '');
    INSERT INTO questions VALUES (21, 2, 'short', '第三题', '[]', '答案', '', 0, '');
  `);
  return database;
}

async function counts(pool: Pool) {
  const result = await pool.query<{ learners: string; workspaces: string; mappings: string; members: string }>(`
    SELECT
      (SELECT COUNT(*) FROM learners)::text AS learners,
      (SELECT COUNT(*) FROM workspaces)::text AS workspaces,
      (SELECT COUNT(*) FROM legacy_bank_mappings)::text AS mappings,
      (SELECT COUNT(*) FROM workspace_members)::text AS members
  `);
  return result.rows[0];
}

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "sushua-legacy-backfill-"));
  const sourcePath = path.join(directory, "source.db");
  const snapshotPath = path.join(directory, "snapshot.db");
  const source = createFixture(sourcePath);
  await createLegacySnapshot({ sourcePath, snapshotPath });
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await pool.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(pool);

  console.log("Legacy Workspace backfill");
  const dryRun = await backfillLegacyWorkspaces(pool, { snapshotPath, dryRun: true });
  assert.equal(dryRun.committed, false);
  assert.deepEqual(dryRun.items.map((item) => ({ slug: item.slug, status: item.status, questions: item.questionsPending })), [
    { slug: "legacy-one", status: "ready", questions: 2 },
    { slug: "legacy-two", status: "ready", questions: 1 },
  ]);
  assert.deepEqual(await counts(pool), { learners: "0", workspaces: "0", mappings: "0", members: "0" });
  console.log("  ✓ dry-run 完整执行后回滚，明确题目仍 pending");

  const applied = await backfillLegacyWorkspaces(pool, { snapshotPath, dryRun: false });
  assert.equal(applied.committed, true);
  assert.deepEqual(applied.items.map((item) => item.status), ["created", "created"]);
  assert.deepEqual(await counts(pool), { learners: "2", workspaces: "2", mappings: "2", members: "2" });
  const rows = await pool.query<{ slug: string; visibility: string; role: string; checksum: string }>(`
    SELECT w.slug, w.visibility, wm.role, lbm.checksum
    FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id
    JOIN legacy_bank_mappings lbm ON lbm.workspace_id = w.id
    ORDER BY w.slug
  `);
  assert.deepEqual(rows.rows.map((row) => ({ slug: row.slug, visibility: row.visibility, role: row.role })), [
    { slug: "legacy-one", visibility: "private", role: "owner" },
    { slug: "legacy-two", visibility: "link", role: "owner" },
  ]);
  assert.ok(rows.rows.every((row) => /^[0-9a-f]{64}$/.test(row.checksum)));
  console.log("  ✓ commit 原子创建 placeholder Learner、Workspace、owner 与 checksum mapping");

  const replayed = await backfillLegacyWorkspaces(pool, { snapshotPath, dryRun: false });
  assert.equal(replayed.committed, true);
  assert.deepEqual(replayed.items.map((item) => item.status), ["replayed", "replayed"]);
  assert.deepEqual(await counts(pool), { learners: "2", workspaces: "2", mappings: "2", members: "2" });
  console.log("  ✓ 相同快照幂等重跑不重复数据");

  source.exec("UPDATE questions SET answer = 'B' WHERE id = 11");
  const changedSnapshot = path.join(directory, "snapshot-changed.db");
  await createLegacySnapshot({ sourcePath, snapshotPath: changedSnapshot });
  const conflict = await backfillLegacyWorkspaces(pool, { snapshotPath: changedSnapshot, dryRun: false });
  assert.equal(conflict.committed, false);
  assert.equal(conflict.items[0]?.status, "conflict");
  assert.equal(conflict.items[0]?.reason, "checksum_changed");
  assert.deepEqual(await counts(pool), { learners: "2", workspaces: "2", mappings: "2", members: "2" });
  console.log("  ✓ checksum 漂移使整批回滚，不覆盖既有映射制造通过");

  source.close();
  await pool.end();
  await rm(directory, { recursive: true, force: true });
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
