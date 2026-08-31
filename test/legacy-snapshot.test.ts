import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLegacySnapshot } from "../src/features/legacy/legacy-snapshot";

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "sushua-legacy-snapshot-"));
  const sourcePath = path.join(directory, "live.db");
  const snapshotPath = path.join(directory, "backups", "snapshot.db");
  const db = new DatabaseSync(sourcePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE banks (id INTEGER PRIMARY KEY, slug TEXT, title TEXT, visibility TEXT, owner_key_hash TEXT, created_at TEXT);
    CREATE TABLE questions (id INTEGER PRIMARY KEY, bank_id INTEGER, type TEXT, stem TEXT, options_json TEXT, answer TEXT, explanation TEXT, sort INTEGER, chapter TEXT);
    CREATE TABLE ai_explanations (question_hash TEXT PRIMARY KEY, content TEXT, tokens_in INTEGER, tokens_out INTEGER, prompt_version INTEGER, created_at TEXT);
    CREATE TABLE usage_log (hour_bucket TEXT PRIMARY KEY, cost_fen REAL, calls INTEGER);
    INSERT INTO banks VALUES (1, 'bank-one', '题库一', 'private', '${"a".repeat(64)}', '2026-08-01 00:00:00');
    INSERT INTO banks VALUES (2, 'bank-two', '题库二', 'public', '${"b".repeat(64)}', '2026-08-02 00:00:00');
    INSERT INTO questions VALUES (11, 1, 'single', '第一题', '["甲","乙"]', 'A', '解析一', 0, '第一章');
    INSERT INTO questions VALUES (12, 1, 'judge', '第二题', '[]', '对', '', 1, '');
    INSERT INTO questions VALUES (21, 2, 'short', '第三题', '[]', '答案三', '', 0, '');
    INSERT INTO ai_explanations VALUES ('${"c".repeat(64)}', '缓存', 10, 20, 1, '2026-08-03 00:00:00');
    INSERT INTO usage_log VALUES ('2026-08-03T01', 1.5, 2);
  `);

  console.log("Legacy SQLite 在线快照");
  const report = await createLegacySnapshot({ sourcePath, snapshotPath });
  assert.equal(report.snapshotPath, snapshotPath);
  assert.deepEqual(report.rowCounts, { banks: 2, questions: 3, ai_explanations: 1, usage_log: 1 });
  assert.equal(report.fileSize, (await stat(snapshotPath)).size);
  assert.equal(report.sha256, createHash("sha256").update(await readFile(snapshotPath)).digest("hex"));
  console.log("  ✓ Online Backup 生成独立文件，并记录大小、SHA256 与四表行数");

  const expectedFirst = {
    bank: {
      id: "1",
      slug: "bank-one",
      title: "题库一",
      visibility: "private",
      ownerKeyHash: "a".repeat(64),
      createdAt: "2026-08-01 00:00:00",
    },
    questions: [
      { id: "11", type: "single", stem: "第一题", options: ["甲", "乙"], answer: "A", explanation: "解析一", sort: 0, chapter: "第一章" },
      { id: "12", type: "judge", stem: "第二题", options: [], answer: "对", explanation: "", sort: 1, chapter: "" },
    ],
  };
  assert.equal(report.banks[0]?.checksum, createHash("sha256").update(JSON.stringify(expectedFirst)).digest("hex"));
  assert.deepEqual(report.banks.map((bank) => ({ id: bank.legacyBankId, slug: bank.slug, questions: bank.questionCount })), [
    { id: "1", slug: "bank-one", questions: 2 },
    { id: "2", slug: "bank-two", questions: 1 },
  ]);
  assert.equal(JSON.stringify(report).includes("解析一"), false);
  console.log("  ✓ 逐 Bank checksum 覆盖稳定题目顺序，报告不泄露题目正文");

  await assert.rejects(
    () => createLegacySnapshot({ sourcePath, snapshotPath }),
    /legacy_snapshot_destination_exists/,
  );
  console.log("  ✓ 已有快照不可被静默覆盖");

  db.exec("INSERT INTO usage_log VALUES ('2026-08-03T02', 2.5, 1)");
  const secondPath = path.join(directory, "backups", "snapshot-2.db");
  const second = await createLegacySnapshot({ sourcePath, snapshotPath: secondPath });
  assert.equal(second.rowCounts.usage_log, 2);
  console.log("  ✓ WAL 中最新提交也进入一致性快照，不直接复制活动数据库文件");

  db.close();
  await rm(directory, { recursive: true, force: true });
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
