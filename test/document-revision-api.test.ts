import assert from "node:assert/strict";
import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";

import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";

type RevisionApi = {
  createDocumentRevisionBatchHandler: (input: unknown) => (request: Request) => Promise<Response>;
};

async function main() {
  const api = await import("../src/features/documents/document-revision-api") as RevisionApi;
  const handler = api.createDocumentRevisionBatchHandler({ enabled: true });

  const response = await handler(new Request("https://sushua.test/api/v1/blocks/batch", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }));

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "idempotency_key_required");
  console.log("Document revision batch v1 HTTP API\n  ✓ 缺少 Idempotency-Key 时不会解析身份或访问数据库");

  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await admin.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(admin);
  await ensureWebRole(admin);
  const fixture = await seedFixture(admin);
  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const revisions = (await import("../src/features/documents/document-revision-module")).createDocumentRevisionModule(runtime);
  const authenticated = api.createDocumentRevisionBatchHandler({
    enabled: true,
    revisions,
    identity: {
      async resolve(request: Request) {
        const learnerId = request.headers.get("x-test-learner");
        if (!learnerId) throw new Error("missing_test_identity");
        return learnerId === fixture.ownerId
          ? { learnerId, kind: "guest" as const, setCookie: "sushua.guest=signed; HttpOnly; Secure" }
          : { learnerId, userId: uuidv7(), kind: "user" as const };
      },
    },
  });

  const request = (learnerId: string, idempotencyKey: string, baseRevisionNumber: number) => new Request("https://sushua.test/api/v1/blocks/batch", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
      "x-test-learner": learnerId,
    },
    body: JSON.stringify({
      workspace_id: fixture.workspaceId,
      document_id: fixture.documentId,
      base_document_version_id: fixture.documentVersionId,
      base_revision_number: baseRevisionNumber,
      operations: [{ source_block_id: fixture.blockId, operation: "edit", patch: { text: "人工修正的正文" } }],
    }),
  });

  const created = await authenticated(request(fixture.ownerId, "owner-revision-1", 0));
  assert.equal(created.status, 201, await created.clone().text());
  const createdBody = await created.json();
  assert.equal(createdBody.data.revision_number, 1);
  assert.equal(createdBody.meta.idempotent_replay, false);
  assert.match(created.headers.get("set-cookie") ?? "", /HttpOnly/);
  console.log("  ✓ owner 以当前修订号创建 append-only Block 修订");

  const replayed = await authenticated(request(fixture.ownerId, "owner-revision-1", 0));
  assert.equal(replayed.status, 200, await replayed.clone().text());
  const replayedBody = await replayed.json();
  assert.equal(replayedBody.data.id, createdBody.data.id);
  assert.equal(replayedBody.meta.idempotent_replay, true);
  assert.equal((await admin.query("SELECT id FROM document_revisions")).rows.length, 1);
  console.log("  ✓ 相同 Idempotency-Key 仅返回同一修订，不重复写入");

  const stale = await authenticated(request(fixture.ownerId, "owner-revision-stale", 0));
  assert.equal(stale.status, 409, await stale.clone().text());
  assert.equal((await stale.json()).error.code, "document_revision_conflict");
  assert.equal((await admin.query("SELECT id FROM document_revisions")).rows.length, 1);
  console.log("  ✓ 过期 base_revision_number 不会覆盖新修订");

  const viewer = await authenticated(request(fixture.viewerId, "viewer-revision-2", 1));
  assert.equal(viewer.status, 403, await viewer.clone().text());
  assert.equal((await viewer.json()).error.code, "editor_permission_required");
  console.log("  ✓ viewer 不能创建修订");

  const outsider = await authenticated(request(fixture.outsiderId, "outsider-revision-2", 1));
  assert.equal(outsider.status, 404, await outsider.clone().text());
  assert.equal((await outsider.json()).error.code, "document_revision_base_not_found");
  console.log("  ✓ 外部 Workspace 猜测请求只获得防枚举 404");

  await runtime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

async function ensureWebRole(admin: Pool) {
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_web_test') THEN
      CREATE ROLE sushua_web_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END $$`);
  await admin.query("GRANT USAGE ON SCHEMA public TO sushua_web_test");
  await admin.query("GRANT SELECT ON workspace_members, documents, document_versions, blocks, document_revisions TO sushua_web_test");
  await admin.query("GRANT INSERT ON document_revisions, document_revision_blocks TO sushua_web_test");
}

async function seedFixture(admin: Pool) {
  const ownerId = uuidv7();
  const viewerId = uuidv7();
  const outsiderId = uuidv7();
  const workspaceId = uuidv7();
  const documentId = uuidv7();
  const documentVersionId = uuidv7();
  const pageId = uuidv7();
  const blockId = uuidv7();
  const now = new Date("2026-09-04T00:00:00.000Z");
  await admin.query("INSERT INTO learners(id) VALUES($1),($2),($3)", [ownerId, viewerId, outsiderId]);
  await admin.query(
    "INSERT INTO workspaces(id,slug,title,visibility,created_by_learner_id) VALUES($1,$2,'修订 API','private',$3)",
    [workspaceId, `revision-api-${workspaceId.slice(0, 8)}`, ownerId],
  );
  await admin.query(
    "INSERT INTO workspace_members(workspace_id,learner_id,role) VALUES($1,$2,'owner'),($1,$3,'viewer')",
    [workspaceId, ownerId, viewerId],
  );
  await admin.query(
    `INSERT INTO documents(
      id,workspace_id,filename,mime_type,sha256,parse_status,idempotency_key,request_hash,created_at,updated_at
    ) VALUES($1,$2,'revision.pdf','application/pdf',$3,'ready','revision-api',$4,$5,$5)`,
    [documentId, workspaceId, "a".repeat(64), "d".repeat(64), now],
  );
  await admin.query(
    `INSERT INTO document_versions(
      id,workspace_id,document_id,version,source_object_key,content_hash,status,created_at
    ) VALUES($1,$2,$3,1,$4,$5,'ready',$6)`,
    [documentVersionId, workspaceId, documentId, `tenant/${workspaceId}/${documentId}/${documentVersionId}/source/original`, "b".repeat(64), now],
  );
  await admin.query("UPDATE documents SET current_version_id=$1 WHERE id=$2", [documentVersionId, documentId]);
  await admin.query(
    "INSERT INTO pages(id,workspace_id,document_version_id,page_number,width,height) VALUES($1,$2,$3,1,612,792)",
    [pageId, workspaceId, documentVersionId],
  );
  await admin.query(
    `INSERT INTO blocks(
      id,workspace_id,document_version_id,page_id,block_type,text,bbox,reading_order,confidence,source_hash
    ) VALUES($1,$2,$3,$4,'text','原始正文','[0,0,1,0.5]'::jsonb,0,0.9,$5)`,
    [blockId, workspaceId, documentVersionId, pageId, "c".repeat(64)],
  );
  return { ownerId, viewerId, outsiderId, workspaceId, documentId, documentVersionId, blockId };
}

function roleUrl(source: string): string {
  const url = new URL(source);
  url.username = "sushua_web_test";
  url.password = "integration-only";
  return url.toString();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
