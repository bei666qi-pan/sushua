import assert from "node:assert/strict";

import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";

import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;

type SourceModule = {
  createDocumentSourceModule: (runtime: ReturnType<typeof createPostgresRuntime>) => {
    listPages: (actor: { learnerId: string }, input: {
      documentVersionId: string;
      limit?: number;
      cursor?: string;
    }) => Promise<{ items: Array<{ id: string; pageNumber: number }>; nextCursor?: string }>;
    listBlocks: (actor: { learnerId: string }, input: {
      pageId: string;
      limit?: number;
      cursor?: string;
      blockTypes?: string[];
      minConfidence?: number;
    }) => Promise<{ items: Array<{ id: string; text?: string; readingOrder: number }>; nextCursor?: string }>;
  };
};

type SourceApi = {
  createDocumentSourceHandlers: (input: {
    enabled: boolean;
    identity: { resolve(request: Request): Promise<{ learnerId: string; kind: "guest"; setCookie: string } | { learnerId: string; userId: string; kind: "user" }> };
    sources: ReturnType<SourceModule["createDocumentSourceModule"]>;
  }) => {
    LIST_PAGES: (request: Request, documentVersionId: string) => Promise<Response>;
    LIST_BLOCKS: (request: Request, pageId: string) => Promise<Response>;
  };
};

async function main() {
  const sourceModule = await import("../src/features/documents/document-source-module")
    .catch(() => null) as SourceModule | null;
  assert.ok(sourceModule, "Document source module must exist");
  const sourceApi = await import("../src/features/documents/source-api")
    .catch(() => null) as SourceApi | null;
  assert.ok(sourceApi, "Document source HTTP module must exist");

  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await admin.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(admin);
  await ensureWebRole(admin);

  const owner = uuidv7();
  const viewer = uuidv7();
  const outsider = uuidv7();
  const source = await seedSource(admin, "owner", owner, viewer);
  const other = await seedSource(admin, "outsider", outsider);

  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const sources = sourceModule.createDocumentSourceModule(runtime);
  const handlers = sourceApi.createDocumentSourceHandlers({
    enabled: true,
    sources,
    identity: {
      async resolve(incoming) {
        const learnerId = incoming.headers.get("x-test-learner");
        if (!learnerId) throw new Error("missing_test_identity");
        return learnerId === owner
          ? { learnerId, kind: "guest" as const, setCookie: "sushua.guest=signed; HttpOnly; Secure" }
          : { learnerId, userId: uuidv7(), kind: "user" as const };
      },
    },
  });

  console.log("Document source v1 HTTP API");
  const firstPages = await handlers.LIST_PAGES(request(owner, `https://sushua.test/api/v1/document-versions/${source.versionId}/pages?limit=1`), source.versionId);
  assert.equal(firstPages.status, 200, await firstPages.clone().text());
  const firstPageBody = await firstPages.json();
  assert.deepEqual(firstPageBody.data.items.map((item: { page_number: number }) => item.page_number), [1]);
  assert.equal(firstPageBody.data.items[0].width, 612);
  assert.equal(firstPageBody.data.items[0].height, 792);
  assert.equal(firstPageBody.data.document_version_id, source.versionId);
  assert.equal(typeof firstPageBody.meta.next_cursor, "string");
  assert.match(firstPages.headers.get("set-cookie") ?? "", /HttpOnly/);
  const secondPages = await handlers.LIST_PAGES(
    request(owner, `https://sushua.test/api/v1/document-versions/${source.versionId}/pages?limit=1&cursor=${encodeURIComponent(firstPageBody.meta.next_cursor)}`),
    source.versionId,
  );
  assert.equal(secondPages.status, 200);
  assert.deepEqual((await secondPages.json()).data.items.map((item: { page_number: number }) => item.page_number), [2]);
  console.log("  ✓ Page 以稳定游标分页，游客读取会续期身份 Cookie");

  const viewerPages = await handlers.LIST_PAGES(request(viewer, `https://sushua.test/api/v1/document-versions/${source.versionId}/pages`), source.versionId);
  assert.equal(viewerPages.status, 200);
  const outsiderPages = await handlers.LIST_PAGES(request(outsider, `https://sushua.test/api/v1/document-versions/${source.versionId}/pages`), source.versionId);
  assert.equal(outsiderPages.status, 404);
  assert.equal((await outsiderPages.json()).error.code, "document_version_not_found");
  const guessedOtherVersion = await handlers.LIST_PAGES(request(owner, `https://sushua.test/api/v1/document-versions/${other.versionId}/pages`), other.versionId);
  assert.equal(guessedOtherVersion.status, 404);
  console.log("  ✓ A/B 租户猜测 DocumentVersion 只能获得防枚举 404");

  const firstBlocks = await handlers.LIST_BLOCKS(request(owner, `https://sushua.test/api/v1/pages/${source.pageIds[0]}/blocks?limit=1`), source.pageIds[0]);
  assert.equal(firstBlocks.status, 200, await firstBlocks.clone().text());
  const firstBlockBody = await firstBlocks.json();
  assert.deepEqual(firstBlockBody.data.items.map((item: { text: string }) => item.text), ["第一章"]);
  assert.equal(firstBlockBody.data.items[0].reading_order, 0);
  assert.equal(typeof firstBlockBody.meta.next_cursor, "string");
  const remainingBlocks = await handlers.LIST_BLOCKS(
    request(owner, `https://sushua.test/api/v1/pages/${source.pageIds[0]}/blocks?limit=2&cursor=${encodeURIComponent(firstBlockBody.meta.next_cursor)}`),
    source.pageIds[0],
  );
  assert.deepEqual((await remainingBlocks.json()).data.items.map((item: { text: string }) => item.text), ["高置信正文", "低置信候选"]);
  const filteredBlocks = await handlers.LIST_BLOCKS(
    request(owner, `https://sushua.test/api/v1/pages/${source.pageIds[0]}/blocks?type=text&min_confidence=0.9`),
    source.pageIds[0],
  );
  assert.equal(filteredBlocks.status, 200, await filteredBlocks.clone().text());
  assert.deepEqual((await filteredBlocks.json()).data.items.map((item: { text: string }) => item.text), ["高置信正文"]);
  console.log("  ✓ Block 按阅读顺序游标分页，并在数据库侧执行类型与置信度过滤");

  const outsiderBlocks = await handlers.LIST_BLOCKS(request(outsider, `https://sushua.test/api/v1/pages/${source.pageIds[0]}/blocks`), source.pageIds[0]);
  assert.equal(outsiderBlocks.status, 404);
  assert.equal((await outsiderBlocks.json()).error.code, "page_not_found");
  const guessedOtherPage = await handlers.LIST_BLOCKS(request(owner, `https://sushua.test/api/v1/pages/${other.pageIds[0]}/blocks`), other.pageIds[0]);
  assert.equal(guessedOtherPage.status, 404);
  console.log("  ✓ A/B 租户猜测 Page 或 Block 不能越过 RLS 读取来源文字");

  const invalidFilter = await handlers.LIST_BLOCKS(request(owner, `https://sushua.test/api/v1/pages/${source.pageIds[0]}/blocks?type=not-a-block`), source.pageIds[0]);
  assert.equal(invalidFilter.status, 400);
  assert.equal((await invalidFilter.json()).error.code, "invalid_block_type");
  console.log("  ✓ 无效过滤条件在读取前被拒绝");

  const emptyConfidence = await handlers.LIST_BLOCKS(request(owner, `https://sushua.test/api/v1/pages/${source.pageIds[0]}/blocks?min_confidence=`), source.pageIds[0]);
  assert.equal(emptyConfidence.status, 400);
  assert.equal((await emptyConfidence.json()).error.code, "invalid_min_confidence");
  console.log("  ✓ 空置信度不被宽松转换成零值过滤");

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
  await admin.query("GRANT SELECT ON document_versions, pages, blocks, workspace_members TO sushua_web_test");
}

async function seedSource(admin: Pool, suffix: string, owner: string, viewer?: string) {
  const workspaceId = uuidv7();
  const documentId = uuidv7();
  const versionId = uuidv7();
  const pageOne = uuidv7();
  const pageTwo = uuidv7();
  const createdAt = new Date("2026-09-04T00:00:00.000Z");
  await admin.query("INSERT INTO learners(id) VALUES($1)", [owner]);
  if (viewer) await admin.query("INSERT INTO learners(id) VALUES($1)", [viewer]);
  await admin.query(
    `INSERT INTO workspaces(id,slug,title,visibility,created_by_learner_id)
     VALUES($1,$2,$2,'private',$3)`,
    [workspaceId, `source-${suffix}-${workspaceId.slice(0, 8)}`, owner],
  );
  await admin.query("INSERT INTO workspace_members(workspace_id,learner_id,role) VALUES($1,$2,'owner')", [workspaceId, owner]);
  if (viewer) await admin.query("INSERT INTO workspace_members(workspace_id,learner_id,role) VALUES($1,$2,'viewer')", [workspaceId, viewer]);
  await admin.query(
    `INSERT INTO documents(
       id,workspace_id,filename,mime_type,sha256,parse_status,idempotency_key,request_hash,created_at,updated_at
     ) VALUES($1,$2,$3,'application/pdf',$4,'ready',$5,$6,$7,$7)`,
    [documentId, workspaceId, `${suffix}.pdf`, "a".repeat(64), `source-${suffix}`, "b".repeat(64), createdAt],
  );
  await admin.query(
    `INSERT INTO document_versions(
       id,workspace_id,document_id,version,source_object_key,content_hash,status,created_at,
       ir_object_key,ir_sha256,parser,parser_version,page_count,parsed_at,ir_schema_version,
       ir_indexed_sha256,ir_indexed_at
     ) VALUES($1,$2,$3,1,$4,$5,'ready',$6,$7,$8,'docling','2.123.1',2,$6,'sushua.document-ir.v1',$8,$6)`,
    [versionId, workspaceId, documentId,
      `tenant/${workspaceId}/${documentId}/${versionId}/source/original`, "a".repeat(64), createdAt,
      `tenant/${workspaceId}/${documentId}/${versionId}/ir/document-ir.json`, "c".repeat(64)],
  );
  await admin.query("UPDATE documents SET current_version_id=$1 WHERE id=$2", [versionId, documentId]);
  await admin.query(
    `INSERT INTO pages(id,workspace_id,document_version_id,page_number,width,height) VALUES
      ($1,$2,$3,1,612,792), ($4,$2,$3,2,612,792)`,
    [pageOne, workspaceId, versionId, pageTwo],
  );
  await admin.query(
    `INSERT INTO blocks(
       id,workspace_id,document_version_id,page_id,block_type,text,markdown,bbox,reading_order,confidence,source_hash
     ) VALUES
      ($1,$2,$3,$4,'heading','第一章','# 第一章','[0,0,1,0.1]'::jsonb,0,0.99,$5),
      ($6,$2,$3,$4,'text','高置信正文','高置信正文','[0,0.1,1,0.2]'::jsonb,1,0.95,$7),
      ($8,$2,$3,$4,'question_candidate','低置信候选','低置信候选','[0,0.3,1,0.2]'::jsonb,2,0.40,$9),
      ($10,$2,$3,$11,'text','第二页正文','第二页正文','[0,0,1,0.2]'::jsonb,0,0.90,$12)`,
    [uuidv7(), workspaceId, versionId, pageOne, "d".repeat(64), uuidv7(), "e".repeat(64), uuidv7(), "f".repeat(64), uuidv7(), pageTwo, "1".repeat(64)],
  );
  return { workspaceId, versionId, pageIds: [pageOne, pageTwo] };
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
