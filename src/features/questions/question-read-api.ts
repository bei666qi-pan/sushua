import { v7 as uuidv7 } from "uuid";
import type { QuestionSource, ReadQuestion } from "./question-read-module";

type Identity = { learnerId: string; kind: "guest"; setCookie: string } | { learnerId: string; userId: string; kind: "user" };
type Reader = {
  listWorkspaceQuestions(actor: { learnerId: string; userId?: string }, input: { workspaceId: string; cursor?: string; limit?: number }): Promise<{ items: ReadQuestion[]; nextCursor?: string }>;
  getQuestionSources(actor: { learnerId: string; userId?: string }, input: { questionVersionId: string }): Promise<QuestionSource[]>;
};

export function createQuestionReadHandlers(input: { enabled: boolean; identity?: { resolve(request: Request): Promise<Identity> }; reader?: Reader }) {
  return {
    async LIST(request: Request, workspaceId: string) {
      if (!input.enabled) return error(404, "not_found", "Not found");
      const parsed = query(request.url);
      if ("error" in parsed) return error(400, parsed.error, "查询参数无效");
      if (!input.identity || !input.reader) throw new Error("question_read_dependencies_unavailable");
      const identity = await input.identity.resolve(request);
      try {
        const result = await input.reader.listWorkspaceQuestions(actor(identity), { workspaceId, ...parsed });
        return response({ data: { workspace_id: workspaceId, items: result.items.map(questionData) }, meta: { request_id: uuidv7(), schema_version: "sushua.api.v1", ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}) } }, identity);
      } catch (caught) { return response(readError(caught, "workspace_not_found", "题目"), identity); }
    },
    async SOURCES(request: Request, questionVersionId: string) {
      if (!input.enabled) return error(404, "not_found", "Not found");
      if (!input.identity || !input.reader) throw new Error("question_read_dependencies_unavailable");
      const identity = await input.identity.resolve(request);
      try { const items = await input.reader.getQuestionSources(actor(identity), { questionVersionId }); return response({ data: { question_version_id: questionVersionId, items: items.map(questionSourceData) }, meta: { request_id: uuidv7(), schema_version: "sushua.api.v1" } }, identity); }
      catch (caught) { return response(readError(caught, "question_version_not_found", "题目来源"), identity); }
    },
  };
}

function query(raw: string): { cursor?: string; limit?: number } | { error: string } { const search = new URL(raw).searchParams; if (![...search.keys()].every((key) => key === "cursor" || key === "limit") || search.getAll("cursor").length > 1 || search.getAll("limit").length > 1) return { error: "invalid_query" }; const cursor = search.get("cursor"); const limit = search.get("limit"); if (cursor !== null && (!cursor || cursor.length > 1024)) return { error: "invalid_question_cursor" }; if (limit !== null && (!/^[1-9][0-9]*$/.test(limit) || Number(limit) > 100)) return { error: "invalid_question_limit" }; return { ...(cursor ? { cursor } : {}), ...(limit ? { limit: Number(limit) } : {}) }; }
function actor(identity: Identity) { return { learnerId: identity.learnerId, ...(identity.kind === "user" ? { userId: identity.userId } : {}) }; }
function questionData(question: ReadQuestion) {
  return {
    id: question.id,
    workspace_id: question.workspaceId,
    origin: question.origin,
    ...(question.parentQuestionId ? { parent_question_id: question.parentQuestionId } : {}),
    type: question.type,
    status: question.status,
    version: question.version,
    version_id: question.versionId,
    stem: question.stem,
    options: question.options,
    answer: question.answer,
    rubric: question.rubric,
    ...(question.explanation ? { explanation: question.explanation } : {}),
    difficulty: question.difficulty,
    cognitive_level: question.cognitiveLevel,
    ...(question.chapter ? { chapter: question.chapter } : {}),
    confidence: question.confidence,
    created_at: question.createdAt,
  };
}
function questionSourceData(source: QuestionSource) {
  return {
    document_version_id: source.documentVersionId,
    page_id: source.pageId,
    block_id: source.blockId,
    bbox: source.bbox,
    source_quote: source.sourceQuote,
    source_hash: source.sourceHash,
    relation: source.relation,
  };
}
function readError(caught: unknown, notFoundCode: string, subject: string) {
  const code = caught instanceof Error ? caught.message : "question_read_failed";
  if (["invalid_workspace_id", "invalid_question_learner", "invalid_question_cursor", "invalid_question_limit", "invalid_question_version_id"].includes(code)) {
    return { error: { code, message: `${subject}读取参数无效`, retryable: false }, request_id: uuidv7(), status: 400 };
  }
  if (code === notFoundCode) return { error: { code, message: `${subject}不可用`, retryable: false }, request_id: uuidv7(), status: 404 };
  return { error: { code: "question_read_failed", message: `${subject}暂时不可用`, retryable: true }, request_id: uuidv7(), status: 503 };
}
function error(status: number, code: string, message: string) { return Response.json({ error: { code, message, retryable: false }, request_id: uuidv7() }, { status }); }
function response(body: unknown, identity: Identity) { const headers = new Headers(); if (identity.kind === "guest") headers.set("set-cookie", identity.setCookie); const status = hasStatus(body) ? body.status : 200; return Response.json(hasStatus(body) ? omitStatus(body) : body, { status, headers }); }
function hasStatus(value: unknown): value is { status: number } { return Boolean(value && typeof value === "object" && "status" in value && typeof value.status === "number"); }
function omitStatus(value: { status: number }) { const body = { ...value }; Reflect.deleteProperty(body, "status"); return body; }
