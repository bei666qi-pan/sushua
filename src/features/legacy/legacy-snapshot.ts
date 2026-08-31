import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const LEGACY_TABLES = ["banks", "questions", "ai_explanations", "usage_log"] as const;

export type LegacySnapshotReport = {
  snapshotPath: string;
  fileSize: number;
  sha256: string;
  rowCounts: Record<(typeof LEGACY_TABLES)[number], number>;
  banks: Array<{ legacyBankId: string; slug: string; questionCount: number; checksum: string }>;
};

export type LegacyQuestionData = {
  id: string;
  type: string;
  stem: string;
  options: unknown[];
  answer: string;
  explanation: string;
  sort: number;
  chapter: string;
};

export type LegacyBankData = {
  legacyBankId: string;
  slug: string;
  title: string;
  visibility: string;
  ownerKeyHash: string;
  createdAt: string;
  questions: LegacyQuestionData[];
  checksum: string;
};

export async function createLegacySnapshot(input: {
  sourcePath: string;
  snapshotPath: string;
}): Promise<LegacySnapshotReport> {
  const sourcePath = path.resolve(input.sourcePath);
  const snapshotPath = path.resolve(input.snapshotPath);
  if (sourcePath === snapshotPath) throw new Error("legacy_snapshot_path_must_differ");
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  try {
    const reservation = await open(snapshotPath, "wx");
    await reservation.close();
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") throw new Error("legacy_snapshot_destination_exists");
    throw error;
  }

  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, snapshotPath);
  } finally {
    source.close();
  }

  const analysis = readLegacySnapshotData(snapshotPath);
  const bytes = await readFile(snapshotPath);
  return {
    snapshotPath,
    fileSize: bytes.byteLength,
    sha256: sha256(bytes),
    rowCounts: analysis.rowCounts,
    banks: analysis.banks.map((bank) => ({
      legacyBankId: bank.legacyBankId,
      slug: bank.slug,
      questionCount: bank.questions.length,
      checksum: bank.checksum,
    })),
  };
}

export function readLegacySnapshotData(snapshotPath: string): {
  rowCounts: LegacySnapshotReport["rowCounts"];
  banks: LegacyBankData[];
} {
  const snapshot = new DatabaseSync(path.resolve(snapshotPath), { readOnly: true });
  try {
    assertLegacyTables(snapshot);
    const rowCounts = Object.fromEntries(LEGACY_TABLES.map((table) => [table, countRows(snapshot, table)])) as
      LegacySnapshotReport["rowCounts"];
    const banks = readBanks(snapshot).map((bank): LegacyBankData => {
      const questions = readQuestions(snapshot, bank.id).map((question) => ({
        id: String(question.id),
        type: question.type,
        stem: question.stem,
        options: parseOptions(question.options_json, question.id),
        answer: question.answer,
        explanation: question.explanation,
        sort: question.sort,
        chapter: question.chapter,
      }));
      const canonical = {
        bank: {
          id: String(bank.id),
          slug: bank.slug,
          title: bank.title,
          visibility: bank.visibility,
          ownerKeyHash: bank.owner_key_hash,
          createdAt: bank.created_at,
        },
        questions,
      };
      return {
        legacyBankId: String(bank.id),
        slug: bank.slug,
        title: bank.title,
        visibility: bank.visibility,
        ownerKeyHash: bank.owner_key_hash,
        createdAt: bank.created_at,
        questions,
        checksum: sha256(JSON.stringify(canonical)),
      };
    });
    return { rowCounts, banks };
  } finally {
    snapshot.close();
  }
}

function assertLegacyTables(database: DatabaseSync) {
  const rows = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('banks','questions','ai_explanations','usage_log')",
  ).all() as Array<{ name: string }>;
  const present = new Set(rows.map((row) => row.name));
  const missing = LEGACY_TABLES.filter((table) => !present.has(table));
  if (missing.length > 0) throw new Error(`legacy_snapshot_missing_tables:${missing.join(",")}`);
}

function countRows(database: DatabaseSync, table: (typeof LEGACY_TABLES)[number]) {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return Number(row.count);
}

type LegacyBankRow = {
  id: number;
  slug: string;
  title: string;
  visibility: string;
  owner_key_hash: string;
  created_at: string;
};

function readBanks(database: DatabaseSync) {
  return database.prepare(
    "SELECT id, slug, title, visibility, owner_key_hash, created_at FROM banks ORDER BY id",
  ).all() as unknown as LegacyBankRow[];
}

type LegacyQuestionRow = {
  id: number;
  type: string;
  stem: string;
  options_json: string;
  answer: string;
  explanation: string;
  sort: number;
  chapter: string;
};

function readQuestions(database: DatabaseSync, bankId: number) {
  return database.prepare(
    `SELECT id, type, stem, options_json, answer, explanation, sort, chapter
     FROM questions WHERE bank_id = ? ORDER BY sort, id`,
  ).all(bankId) as unknown as LegacyQuestionRow[];
}

function parseOptions(value: string, questionId: number): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) throw new Error("not_array");
    return parsed;
  } catch {
    throw new Error(`legacy_snapshot_invalid_options:${questionId}`);
  }
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
