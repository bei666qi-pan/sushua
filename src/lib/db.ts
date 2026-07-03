import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";
import { newSlug, sha256, newOwnerKey } from "./hash";
import { DEMO_QUESTIONS } from "./demo-data";
import type { Bank, Question, Visibility, DraftQuestion } from "./types";

// 用 Node 内置 node:sqlite(Node ≥24 默认启用)替代 better-sqlite3:
// 同一 SQLite 文件格式,数据无损;零原生依赖,容器构建不再需要编译链。

const SCHEMA = `
CREATE TABLE IF NOT EXISTS banks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  owner_key_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_id INTEGER NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  stem TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  answer TEXT NOT NULL DEFAULT '',
  explanation TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  chapter TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_questions_bank ON questions(bank_id, sort);
CREATE TABLE IF NOT EXISTS ai_explanations (
  question_hash TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS usage_log (
  hour_bucket TEXT PRIMARY KEY,
  cost_fen REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0
);
`;

declare global {
  // eslint-disable-next-line no-var
  var __sushuaDb: DatabaseSync | undefined;
}

export function getDb(): DatabaseSync {
  if (!globalThis.__sushuaDb) {
    const dir = process.env.DATA_DIR || path.join(process.cwd(), "data");
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, "sushua.db"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);
    migrate(db);
    seedDemo(db);
    globalThis.__sushuaDb = db;
  }
  return globalThis.__sushuaDb;
}

/** node:sqlite 没有 transaction helper,手动包 BEGIN/COMMIT */
function inTransaction(db: DatabaseSync, fn: () => void) {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** 已上线的库缺 chapter 列时补上(CREATE TABLE IF NOT EXISTS 对已存在的表不会加新列) */
function migrate(db: DatabaseSync) {
  const cols = db.prepare("SELECT name FROM pragma_table_info('questions')").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "chapter")) {
    db.exec("ALTER TABLE questions ADD COLUMN chapter TEXT NOT NULL DEFAULT ''");
  }
}

/** 首次启动内置一份公开示例题库,首页广场不空,新手可直接体验 */
function seedDemo(db: DatabaseSync) {
  const exists = db.prepare("SELECT id FROM banks WHERE slug = 'demo'").get();
  if (exists) return;
  const info = db
    .prepare(
      "INSERT INTO banks (slug, title, visibility, owner_key_hash) VALUES ('demo', ?, 'public', ?)"
    )
    .run("示例题库 · 计算机基础 10 题", sha256(newOwnerKey()));
  const ins = db.prepare(
    "INSERT INTO questions (bank_id, type, stem, options_json, answer, explanation, sort, chapter) VALUES (?,?,?,?,?,?,?,?)"
  );
  DEMO_QUESTIONS.forEach((q, i) => {
    ins.run(info.lastInsertRowid, q.type, q.stem, JSON.stringify(q.options), q.answer, q.explanation ?? "", i, q.chapter ?? "");
  });
}

// ---------- banks ----------

export function createBank(title: string, visibility: Visibility, questions: DraftQuestion[]) {
  const db = getDb();
  const slug = newSlug();
  const ownerKey = newOwnerKey();
  inTransaction(db, () => {
    const info = db
      .prepare("INSERT INTO banks (slug, title, visibility, owner_key_hash) VALUES (?,?,?,?)")
      .run(slug, title, visibility, sha256(ownerKey));
    const ins = db.prepare(
      "INSERT INTO questions (bank_id, type, stem, options_json, answer, explanation, sort, chapter) VALUES (?,?,?,?,?,?,?,?)"
    );
    questions.forEach((q, i) => {
      ins.run(info.lastInsertRowid, q.type, q.stem, JSON.stringify(q.options ?? []), q.answer ?? "", q.explanation ?? "", i, q.chapter ?? "");
    });
  });
  return { slug, ownerKey };
}

export function getBank(slug: string): Bank | undefined {
  return getDb()
    .prepare("SELECT id, slug, title, visibility, created_at FROM banks WHERE slug = ?")
    .get(slug) as Bank | undefined;
}

export function isOwner(bank: Bank, ownerKey: string | null): boolean {
  if (!ownerKey) return false;
  const row = getDb().prepare("SELECT owner_key_hash FROM banks WHERE id = ?").get(bank.id) as
    | { owner_key_hash: string }
    | undefined;
  return !!row && row.owner_key_hash === sha256(ownerKey);
}

export function getQuestions(bankId: number): Question[] {
  const rows = getDb()
    .prepare("SELECT id, type, stem, options_json, answer, explanation, sort, chapter FROM questions WHERE bank_id = ? ORDER BY sort")
    .all(bankId) as Array<{
    id: number; type: Question["type"]; stem: string; options_json: string; answer: string; explanation: string; sort: number; chapter: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    stem: r.stem,
    options: JSON.parse(r.options_json || "[]"),
    answer: r.answer,
    explanation: r.explanation || undefined,
    sort: r.sort,
    chapter: r.chapter || undefined,
  }));
}

export function listPublicBanks(): Bank[] {
  return getDb()
    .prepare(
      `SELECT b.id, b.slug, b.title, b.visibility, b.created_at,
              (SELECT COUNT(*) FROM questions q WHERE q.bank_id = b.id) AS question_count
       FROM banks b WHERE b.visibility = 'public' ORDER BY b.id DESC LIMIT 60`
    )
    .all() as unknown as Bank[];
}

export function updateBank(id: number, fields: { title?: string; visibility?: Visibility }) {
  const db = getDb();
  if (fields.title !== undefined) db.prepare("UPDATE banks SET title = ? WHERE id = ?").run(fields.title, id);
  if (fields.visibility !== undefined)
    db.prepare("UPDATE banks SET visibility = ? WHERE id = ?").run(fields.visibility, id);
}

export function deleteBank(id: number) {
  const db = getDb();
  inTransaction(db, () => {
    db.prepare("DELETE FROM questions WHERE bank_id = ?").run(id);
    db.prepare("DELETE FROM banks WHERE id = ?").run(id);
  });
}

// ---------- AI 解析缓存 ----------

export function getCachedExplanation(hash: string): string | undefined {
  const row = getDb()
    .prepare("SELECT content FROM ai_explanations WHERE question_hash = ?")
    .get(hash) as { content: string } | undefined;
  return row?.content;
}

export function saveExplanation(hash: string, content: string, tokensIn: number, tokensOut: number) {
  getDb()
    .prepare(
      "INSERT INTO ai_explanations (question_hash, content, tokens_in, tokens_out) VALUES (?,?,?,?) ON CONFLICT(question_hash) DO UPDATE SET content = excluded.content"
    )
    .run(hash, content, tokensIn, tokensOut);
}

// ---------- 小时成本 ----------

export function addUsage(bucket: string, fen: number) {
  getDb()
    .prepare(
      "INSERT INTO usage_log (hour_bucket, cost_fen, calls) VALUES (?,?,1) ON CONFLICT(hour_bucket) DO UPDATE SET cost_fen = cost_fen + excluded.cost_fen, calls = calls + 1"
    )
    .run(bucket, fen);
}

export function hourCostFen(bucket: string): { costFen: number; calls: number } {
  const row = getDb()
    .prepare("SELECT cost_fen, calls FROM usage_log WHERE hour_bucket = ?")
    .get(bucket) as { cost_fen: number; calls: number } | undefined;
  return { costFen: row?.cost_fen ?? 0, calls: row?.calls ?? 0 };
}
