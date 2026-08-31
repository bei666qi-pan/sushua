import assert from "node:assert/strict";
import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_web_test";
  url.password = "integration-only";
  return url.toString();
}

async function main() {
  const documentModule = await import("../src/features/documents/document-module").catch(() => null);
  assert.ok(documentModule, "Document persistence Module must exist");
  assert.equal(typeof documentModule.createDocumentModule, "function");

  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await admin.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(admin);
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_web_test') THEN
      CREATE ROLE sushua_web_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END $$`);
  await admin.query("GRANT USAGE ON SCHEMA public TO sushua_web_test");
  await admin.query("GRANT SELECT, INSERT, UPDATE ON documents, document_versions, source_assets, workspace_members TO sushua_web_test");

  const owner = uuidv7();
  const viewer = uuidv7();
  const outsider = uuidv7();
  const workspace = uuidv7();
  const otherWorkspace = uuidv7();
  await admin.query("INSERT INTO learners (id) VALUES ($1), ($2), ($3)", [owner, viewer, outsider]);
  await admin.query(
    `INSERT INTO workspaces (id, slug, title, visibility, created_by_learner_id) VALUES
       ($1, 'document-owner', '文档空间', 'private', $2),
       ($3, 'document-outsider', '其他空间', 'private', $4)`,
    [workspace, owner, otherWorkspace, outsider],
  );
  await admin.query(
    `INSERT INTO workspace_members (workspace_id, learner_id, role) VALUES
       ($1, $2, 'owner'), ($1, $3, 'viewer'), ($4, $5, 'owner')`,
    [workspace, owner, viewer, otherWorkspace, outsider],
  );

  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const documents = documentModule.createDocumentModule(runtime, {
    now: () => new Date("2026-09-01T10:00:00.000Z"),
  });
  const documentId = uuidv7();
  const versionId = uuidv7();
  const assetId = uuidv7();
  const request = {
    documentId,
    versionId,
    assetId,
    filename: "高等数学讲义.pdf",
    mimeType: "application/pdf",
    size: 1_024_000,
    sha256: "a".repeat(64),
    objectKey: `tenant/${workspace}/${documentId}/${versionId}/source/${assetId}`,
    manualMode: "study_material" as const,
    idempotencyKey: "upload-math-001",
    requestHash: "b".repeat(64),
  };

  console.log("Document 持久化 Module");
  const created = await documents.createUploadDraft({ learnerId: owner, workspaceId: workspace }, request);
  assert.equal(created.status, "created");
  assert.deepEqual(created.document, {
    id: documentId,
    workspaceId: workspace,
    filename: "高等数学讲义.pdf",
    mimeType: "application/pdf",
    sha256: "a".repeat(64),
    parseStatus: "uploading",
    currentVersionId: versionId,
    version: 1,
    versionStatus: "uploading",
    assetId,
    objectKey: request.objectKey,
    scanStatus: "pending",
    createdAt: "2026-09-01T10:00:00.000Z",
  });
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM documents")).rows[0]?.count, 1);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM document_versions")).rows[0]?.count, 1);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM source_assets")).rows[0]?.count, 1);
  console.log("  ✓ 一个事务创建 Document、不可变 Version 与待扫描 SourceAsset");

  const replay = await documents.createUploadDraft({ learnerId: owner, workspaceId: workspace }, request);
  assert.equal(replay.status, "replayed");
  assert.equal(replay.document.id, documentId);
  const conflictDocumentId = uuidv7();
  const conflictVersionId = uuidv7();
  const conflictAssetId = uuidv7();
  await assert.rejects(
    () => documents.createUploadDraft(
      { learnerId: owner, workspaceId: workspace },
      {
        ...request,
        documentId: conflictDocumentId,
        versionId: conflictVersionId,
        assetId: conflictAssetId,
        objectKey: `tenant/${workspace}/${conflictDocumentId}/${conflictVersionId}/source/${conflictAssetId}`,
        requestHash: "c".repeat(64),
      },
    ),
    /document_idempotency_conflict/,
  );
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM documents")).rows[0]?.count, 1);
  console.log("  ✓ 同键同请求重放原资源，同键不同正文冲突且不留半成品");

  assert.equal((await documents.read({ learnerId: viewer }, documentId))?.id, documentId);
  assert.equal(await documents.read({ learnerId: outsider }, documentId), undefined);
  const viewerDocumentId = uuidv7();
  const viewerVersionId = uuidv7();
  const viewerAssetId = uuidv7();
  await assert.rejects(
    () => documents.createUploadDraft(
      { learnerId: viewer, workspaceId: workspace },
      {
        ...request,
        documentId: viewerDocumentId,
        versionId: viewerVersionId,
        assetId: viewerAssetId,
        objectKey: `tenant/${workspace}/${viewerDocumentId}/${viewerVersionId}/source/${viewerAssetId}`,
        idempotencyKey: "viewer-upload",
        requestHash: "d".repeat(64),
      },
    ),
  );
  console.log("  ✓ viewer 只读，其他租户不可见，写入由 FORCE RLS 拒绝");

  await assert.rejects(
    () => documents.createUploadDraft(
      { learnerId: owner, workspaceId: workspace },
      {
        ...request,
        documentId: uuidv7(),
        versionId: uuidv7(),
        assetId: uuidv7(),
        objectKey: `tenant/${otherWorkspace}/escape/source`,
        idempotencyKey: "bad-object-key",
        requestHash: "e".repeat(64),
      },
    ),
    /invalid_document_object_key/,
  );
  console.log("  ✓ 对象键必须绑定 tenant/workspace/document/version 前缀");

  const rls = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
    SELECT relname, relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE relname IN ('documents', 'document_versions', 'source_assets')
    ORDER BY relname
  `);
  assert.equal(rls.rows.length, 3);
  assert.ok(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
  console.log("  ✓ 三张新租户表全部启用并 FORCE RLS");

  await runtime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
