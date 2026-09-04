import assert from "node:assert/strict";

import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";

import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;

type QuestionModule = {
  createQuestionReadModule: (runtime: ReturnType<typeof createPostgresRuntime>) => {
    listWorkspaceQuestions: (actor: { learnerId: string }, input: { workspaceId: string; cursor?: string; limit?: number }) => Promise<{ items: Array<{ id: string; version: number; stem: string; status: string }>; nextCursor?: string }>;
    getQuestionSources: (actor: { learnerId: string }, input: { questionVersionId: string }) => Promise<Array<{ documentVersionId: string; pageId: string; blockId: string; sourceHash: string; relation: string }>>;
  };
};

type QuestionApi = {
  createQuestionReadHandlers: (input: {
    enabled: boolean;
    identity?: { resolve(request: Request): Promise<{ learnerId: string; kind: "guest"; setCookie: string } | { learnerId: string; userId: string; kind: "user" }> };
    reader?: ReturnType<QuestionModule["createQuestionReadModule"]>;
  }) => {
    LIST: (request: Request, workspaceId: string) => Promise<Response>;
    SOURCES: (request: Request, questionVersionId: string) => Promise<Response>;
  };
};

async function main() {
  const questionModule = await import("../src/features/questions/question-read-module").catch(() => null) as QuestionModule | null;
  assert.ok(questionModule, "Question read module must exist");
  const questionApi = await import("../src/features/questions/question-read-api").catch(() => null) as QuestionApi | null;
  assert.ok(questionApi, "Question read HTTP module must exist");
  const sourceRoute = await import("../src/app/api/v1/question-versions/[id]/sources/route").catch(() => null);
  assert.ok(sourceRoute, "Question-version source route must exist");
  assert.equal(typeof sourceRoute.GET, "function");

  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await admin.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(admin);
  await ensureWebRole(admin);

  const owner = uuidv7();
  const viewer = uuidv7();
  const outsider = uuidv7();
  const seeded = await seedQuestions(admin, owner, viewer);
  const other = await seedQuestions(admin, outsider);
  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const reader = questionModule.createQuestionReadModule(runtime);
  const handlers = questionApi.createQuestionReadHandlers({
    enabled: true,
    reader,
    identity: { async resolve(incoming) {
      const learnerId = incoming.headers.get("x-test-learner");
      if (!learnerId) throw new Error("missing_test_identity");
      return learnerId === owner
        ? { learnerId, kind: "guest" as const, setCookie: "sushua.guest=signed; HttpOnly; Secure" }
        : { learnerId, userId: uuidv7(), kind: "user" as const };
    } },
  });

  console.log("Question read v1 HTTP API");
  const first = await handlers.LIST(request(owner, `https://sushua.test/api/v1/workspaces/${seeded.workspaceId}/questions?limit=1`), seeded.workspaceId);
  assert.equal(first.status, 200, await first.clone().text());
  const firstBody = await first.json();
  assert.deepEqual(firstBody.data.items.map((item: { id: string }) => item.id), [seeded.newestQuestionId]);
  assert.equal(firstBody.data.items[0].version, 2);
  assert.equal(firstBody.data.items[0].workspace_id, seeded.workspaceId);
  assert.equal(firstBody.data.items[0].version_id, seeded.newestVersionId);
  assert.equal("workspaceId" in firstBody.data.items[0], false);
  assert.equal(firstBody.data.items[0].stem, "新版题干");
  assert.equal(typeof firstBody.meta.next_cursor, "string");
  assert.match(first.headers.get("set-cookie") ?? "", /HttpOnly/);
  const second = await handlers.LIST(request(owner, `https://sushua.test/api/v1/workspaces/${seeded.workspaceId}/questions?limit=1&cursor=${encodeURIComponent(firstBody.meta.next_cursor)}`), seeded.workspaceId);
  assert.equal(second.status, 200, await second.clone().text());
  assert.deepEqual((await second.json()).data.items.map((item: { id: string }) => item.id), [seeded.olderQuestionId]);
  console.log("  ✓ 仅返回当前非归档版本，并以稳定游标分页");

  const viewerResponse = await handlers.LIST(request(viewer, `https://sushua.test/api/v1/workspaces/${seeded.workspaceId}/questions`), seeded.workspaceId);
  assert.equal(viewerResponse.status, 200);
  const outsiderResponse = await handlers.LIST(request(outsider, `https://sushua.test/api/v1/workspaces/${seeded.workspaceId}/questions`), seeded.workspaceId);
  assert.equal(outsiderResponse.status, 404);
  assert.equal((await outsiderResponse.json()).error.code, "workspace_not_found");
  const guessedOther = await handlers.LIST(request(owner, `https://sushua.test/api/v1/workspaces/${other.workspaceId}/questions`), other.workspaceId);
  assert.equal(guessedOther.status, 404);
  console.log("  ✓ Workspace 成员可读，跨租户猜测只得到防枚举 404");

  const sources = await handlers.SOURCES(request(owner, `https://sushua.test/api/v1/question-versions/${seeded.newestVersionId}/sources`), seeded.newestVersionId);
  assert.equal(sources.status, 200, await sources.clone().text());
  const sourceBody = await sources.json();
  assert.deepEqual(sourceBody.data.items, [{
    document_version_id: seeded.documentVersionId,
    page_id: seeded.pageId,
    block_id: seeded.blockId,
    bbox: [0, 0, 1, 0.25],
    source_quote: "资料中的原文证据",
    source_hash: seeded.sourceHash,
    relation: "supports_stem",
  }]);
  const foreignSources = await handlers.SOURCES(request(outsider, `https://sushua.test/api/v1/question-versions/${seeded.newestVersionId}/sources`), seeded.newestVersionId);
  assert.equal(foreignSources.status, 404);
  console.log("  ✓ QuestionVersion 来源保留 DocumentVersion/Page/Block/source hash 精确绑定");

  let resolved = false;
  const disabled = questionApi.createQuestionReadHandlers({ enabled: false, identity: { async resolve() { resolved = true; throw new Error("must_not_resolve"); } } });
  assert.equal((await disabled.LIST(new Request("https://sushua.test/api/v1/workspaces/x/questions"), seeded.workspaceId)).status, 404);
  assert.equal(resolved, false);
  const invalid = await handlers.LIST(request(owner, `https://sushua.test/api/v1/workspaces/${seeded.workspaceId}/questions?limit=0`), seeded.workspaceId);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "invalid_question_limit");
  const invalidWorkspace = await handlers.LIST(request(owner, "https://sushua.test/api/v1/workspaces/not-a-uuid/questions"), "not-a-uuid");
  assert.equal(invalidWorkspace.status, 400);
  assert.equal((await invalidWorkspace.json()).error.code, "invalid_workspace_id");
  console.log("  ✓ Flag 关闭时不初始化身份，错误分页参数在读取前拒绝");

  await runtime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

function request(learnerId: string, url: string) {
  return new Request(url, { headers: { "x-test-learner": learnerId } });
}

async function ensureWebRole(admin: Pool) {
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_web_test') THEN
      CREATE ROLE sushua_web_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END $$`);
  await admin.query("GRANT USAGE ON SCHEMA public TO sushua_web_test");
  await admin.query("GRANT SELECT ON workspaces, workspace_members, documents, document_versions, pages, blocks, questions, question_versions, question_sources TO sushua_web_test");
}

async function seedQuestions(admin: Pool, owner: string, viewer?: string) {
  const workspaceId = uuidv7();
  const documentId = uuidv7();
  const documentVersionId = uuidv7();
  const pageId = uuidv7();
  const blockId = uuidv7();
  const newestQuestionId = uuidv7();
  const newestOldVersionId = uuidv7();
  const newestVersionId = uuidv7();
  const olderQuestionId = uuidv7();
  const olderVersionId = uuidv7();
  const archivedQuestionId = uuidv7();
  const archivedVersionId = uuidv7();
  const sourceHash = "d".repeat(64);
  const olderAt = new Date("2026-09-04T00:00:00.000Z");
  const newerAt = new Date("2026-09-04T00:01:00.000Z");
  await admin.query("INSERT INTO learners(id) VALUES($1)", [owner]);
  if (viewer) await admin.query("INSERT INTO learners(id) VALUES($1)", [viewer]);
  await admin.query("INSERT INTO workspaces(id,slug,title,visibility,created_by_learner_id) VALUES($1,$2,$2,'private',$3)", [workspaceId, `questions-${workspaceId}`, owner]);
  await admin.query("INSERT INTO workspace_members(workspace_id,learner_id,role) VALUES($1,$2,'owner')", [workspaceId, owner]);
  if (viewer) await admin.query("INSERT INTO workspace_members(workspace_id,learner_id,role) VALUES($1,$2,'viewer')", [workspaceId, viewer]);
  await admin.query(
    "INSERT INTO documents(id,workspace_id,filename,mime_type,sha256,parse_status,idempotency_key,request_hash,created_at,updated_at) VALUES($1,$2,'source.pdf','application/pdf',$3,'ready',$4,$5,$6,$6)",
    [documentId, workspaceId, "a".repeat(64), `document-${workspaceId}`, "b".repeat(64), olderAt],
  );
  await admin.query(
    `INSERT INTO document_versions(id,workspace_id,document_id,version,source_object_key,content_hash,status,created_at,ir_object_key,ir_sha256,parser,parser_version,page_count,parsed_at,ir_schema_version,ir_indexed_sha256,ir_indexed_at)
     VALUES($1,$2,$3,1,$4,$5,'ready',$6,$7,$8,'docling','2.123.1',1,$6,'sushua.document-ir.v1',$8,$6)`,
    [documentVersionId, workspaceId, documentId, `tenant/${workspaceId}/${documentId}/${documentVersionId}/source/original`, "a".repeat(64), olderAt, `tenant/${workspaceId}/${documentId}/${documentVersionId}/ir/document-ir.json`, "c".repeat(64)],
  );
  await admin.query("UPDATE documents SET current_version_id=$1 WHERE id=$2", [documentVersionId, documentId]);
  await admin.query("INSERT INTO pages(id,workspace_id,document_version_id,page_number,width,height) VALUES($1,$2,$3,1,612,792)", [pageId, workspaceId, documentVersionId]);
  await admin.query("INSERT INTO blocks(id,workspace_id,document_version_id,page_id,block_type,text,markdown,bbox,reading_order,confidence,source_hash) VALUES($1,$2,$3,$4,'text','资料中的原文证据','资料中的原文证据','[0,0,1,0.25]'::jsonb,0,0.99,$5)", [blockId, workspaceId, documentVersionId, pageId, sourceHash]);
  await insertQuestion(admin, { workspaceId, questionId: newestQuestionId, versionId: newestOldVersionId, currentVersionId: newestOldVersionId, version: 1, stem: "旧版题干", status: "ready", owner, createdAt: newerAt });
  await insertQuestionVersion(admin, { workspaceId, questionId: newestQuestionId, versionId: newestVersionId, version: 2, stem: "新版题干", owner, createdAt: newerAt });
  await admin.query("UPDATE questions SET current_version_id=$1 WHERE id=$2", [newestVersionId, newestQuestionId]);
  await admin.query("INSERT INTO question_sources(question_version_id,workspace_id,document_version_id,page_id,block_id,bbox,source_quote,source_hash,relation) VALUES($1,$2,$3,$4,$5,'[0,0,1,0.25]'::jsonb,'资料中的原文证据',$6,'supports_stem')", [newestVersionId, workspaceId, documentVersionId, pageId, blockId, sourceHash]);
  await insertQuestion(admin, { workspaceId, questionId: olderQuestionId, versionId: olderVersionId, currentVersionId: olderVersionId, version: 1, stem: "旧题干", status: "ready", owner, createdAt: olderAt });
  await insertQuestion(admin, { workspaceId, questionId: archivedQuestionId, versionId: archivedVersionId, currentVersionId: archivedVersionId, version: 1, stem: "不应出现的归档题", status: "archived", owner, createdAt: newerAt });
  return { workspaceId, documentVersionId, pageId, blockId, newestQuestionId, newestVersionId, olderQuestionId, sourceHash };
}

async function insertQuestion(admin: Pool, input: { workspaceId: string; questionId: string; versionId: string; currentVersionId: string; version: number; stem: string; status: "ready" | "archived"; owner: string; createdAt: Date }) {
  await admin.query("INSERT INTO questions(id,workspace_id,origin,type,status,current_version_id,created_by_learner_id,created_at) VALUES($1,$2,'user','single_choice',$3,NULL,$4,$5)", [input.questionId, input.workspaceId, input.status, input.owner, input.createdAt]);
  await insertQuestionVersion(admin, input);
  await admin.query("UPDATE questions SET current_version_id=$1 WHERE id=$2", [input.currentVersionId, input.questionId]);
}

async function insertQuestionVersion(admin: Pool, input: { workspaceId: string; questionId: string; versionId: string; version: number; stem: string; owner: string; createdAt: Date }) {
  await admin.query("INSERT INTO question_versions(id,workspace_id,question_id,version,stem,options,answer,rubric,difficulty,cognitive_level,confidence,created_by_learner_id,created_at) VALUES($1,$2,$3,$4,$5,'[]'::jsonb,'[]'::jsonb,'{}'::jsonb,3,'understand',0.9,$6,$7)", [input.versionId, input.workspaceId, input.questionId, input.version, input.stem, input.owner, input.createdAt]);
}

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_web_test";
  url.password = "integration-only";
  return url.toString();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
