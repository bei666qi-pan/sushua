import type { PostgresRuntime } from "@/db/postgres/runtime";

type Actor = { learnerId: string; userId?: string };
type QuestionCursor = { createdAt: string; id: string };

export type ReadQuestion = {
  id: string;
  workspaceId: string;
  origin: string;
  parentQuestionId?: string;
  type: string;
  status: string;
  version: number;
  versionId: string;
  stem: string;
  options: unknown;
  answer: unknown;
  rubric: unknown;
  explanation?: string;
  difficulty: number;
  cognitiveLevel: string;
  chapter?: string;
  confidence: number;
  createdAt: string;
};

export type QuestionSource = {
  documentVersionId: string;
  pageId: string;
  blockId: string;
  bbox: [number, number, number, number];
  sourceQuote: string;
  sourceHash: string;
  relation: "supports_stem" | "supports_answer" | "supports_explanation";
};

export function createQuestionReadModule(runtime: PostgresRuntime) {
  return {
    async listWorkspaceQuestions(actor: Actor, input: { workspaceId: string; cursor?: string; limit?: number }) {
      assertUuidV7(actor.learnerId, "invalid_question_learner");
      assertUuidV7(input.workspaceId, "invalid_workspace_id");
      const limit = normalizeLimit(input.limit);
      const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
      return runtime.withTenant(actor, async ({ query }) => {
        const workspace = await query<{ id: string }>("SELECT id FROM workspaces WHERE id=$1", [input.workspaceId]);
        if (!workspace.rows[0]) throw new Error("workspace_not_found");
        const result = await query<QuestionRow>(
          `SELECT q.id, q.workspace_id, q.origin, q.parent_question_id, q.type, q.status, q.created_at,
                  v.id AS version_id, v.version, v.stem, v.options, v.answer, v.rubric, v.explanation,
                  v.difficulty, v.cognitive_level, v.chapter, v.confidence
             FROM questions q
             JOIN question_versions v ON v.id=q.current_version_id
            WHERE q.workspace_id=$1 AND q.current_version_id IS NOT NULL AND q.status <> 'archived'
              AND ($2::timestamptz IS NULL OR q.created_at < $2 OR (q.created_at=$2 AND q.id < $3::uuid))
            ORDER BY q.created_at DESC, q.id DESC LIMIT $4`,
          [input.workspaceId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1],
        );
        const rows = result.rows.slice(0, limit);
        const last = rows.at(-1);
        return { items: rows.map(questionFromRow), ...(result.rows.length > limit && last ? { nextCursor: encodeCursor({ createdAt: last.created_at, id: last.id }) } : {}) };
      });
    },
    async getQuestionSources(actor: Actor, input: { questionVersionId: string }): Promise<QuestionSource[]> {
      assertUuidV7(actor.learnerId, "invalid_question_learner");
      assertUuidV7(input.questionVersionId, "invalid_question_version_id");
      return runtime.withTenant(actor, async ({ query }) => {
        const result = await query<SourceRow>(
          `SELECT document_version_id,page_id,block_id,bbox,source_quote,source_hash,relation
             FROM question_sources WHERE question_version_id=$1
             ORDER BY relation ASC, block_id ASC`, [input.questionVersionId],
        );
        const exists = await query<{ id: string }>("SELECT id FROM question_versions WHERE id=$1", [input.questionVersionId]);
        if (!exists.rows[0]) throw new Error("question_version_not_found");
        return result.rows.map((row) => ({ documentVersionId: row.document_version_id, pageId: row.page_id, blockId: row.block_id, bbox: row.bbox, sourceQuote: row.source_quote, sourceHash: row.source_hash, relation: row.relation }));
      });
    },
  };
}

type QuestionRow = { id: string; workspace_id: string; origin: string; parent_question_id: string | null; type: string; status: string; created_at: string; version_id: string; version: number; stem: string; options: unknown; answer: unknown; rubric: unknown; explanation: string | null; difficulty: number; cognitive_level: string; chapter: string | null; confidence: number };
type SourceRow = { document_version_id: string; page_id: string; block_id: string; bbox: [number, number, number, number]; source_quote: string; source_hash: string; relation: QuestionSource["relation"] };

function questionFromRow(row: QuestionRow): ReadQuestion { return { id: row.id, workspaceId: row.workspace_id, origin: row.origin, ...(row.parent_question_id ? { parentQuestionId: row.parent_question_id } : {}), type: row.type, status: row.status, version: row.version, versionId: row.version_id, stem: row.stem, options: row.options, answer: row.answer, rubric: row.rubric, ...(row.explanation ? { explanation: row.explanation } : {}), difficulty: row.difficulty, cognitiveLevel: row.cognitive_level, ...(row.chapter ? { chapter: row.chapter } : {}), confidence: row.confidence, createdAt: row.created_at }; }
function normalizeLimit(value: number | undefined) { const result = value ?? 50; if (!Number.isSafeInteger(result) || result < 1 || result > 100) throw new Error("invalid_question_limit"); return result; }
function encodeCursor(value: QuestionCursor) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decodeCursor(value: string): QuestionCursor { try { const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); const row = parsed as Record<string, unknown>; if (typeof row.createdAt !== "string" || Number.isNaN(Date.parse(row.createdAt)) || typeof row.id !== "string" || !uuidV7(row.id)) throw new Error(); return { createdAt: row.createdAt, id: row.id }; } catch { throw new Error("invalid_question_cursor"); } }
function assertUuidV7(value: string, code: string) { if (!uuidV7(value)) throw new Error(code); }
function uuidV7(value: string) { return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
