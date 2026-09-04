import assert from "node:assert/strict";

import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";

import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;

type RevisionModule = {
  createDocumentRevisionModule: (runtime: ReturnType<typeof createPostgresRuntime>) => {
    createRevision: (actor: { learnerId: string; workspaceId: string }, input: {
      revisionId: string;
      documentId: string;
      baseDocumentVersionId: string;
      revisionNumber: number;
      operations: Array<{
        sourceBlockId: string;
        operation: "edit" | "delete" | "split" | "merge";
        patch: Record<string, unknown>;
      }>;
    }) => Promise<{
      id: string;
      workspaceId: string;
      documentId: string;
      baseDocumentVersionId: string;
      revisionNumber: number;
      operations: Array<{
        sourceBlockId: string;
        operation: "edit" | "delete" | "split" | "merge";
        patch: Record<string, unknown>;
      }>;
    }>;
  };
};

async function main() {
  const imported = await import("../src/features/documents/document-revision-module")
    .catch(() => null) as RevisionModule | null;
  assert.ok(imported, "Document revision module must exist");

  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await admin.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(admin);
  await ensureWebRole(admin);

  const fixture = await seedFixture(admin);
  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const revisions = imported.createDocumentRevisionModule(runtime);

  console.log("Document revision module");
  const created = await revisions.createRevision(
    { learnerId: fixture.ownerId, workspaceId: fixture.workspaceId },
    {
      revisionId: fixture.revisionId,
      documentId: fixture.documentId,
      baseDocumentVersionId: fixture.documentVersionId,
      revisionNumber: 1,
      operations: [
        { sourceBlockId: fixture.firstBlockId, operation: "edit", patch: { text: "人工修改后内容" } },
        { sourceBlockId: fixture.secondBlockId, operation: "split", patch: { at: 6 } },
      ],
    },
  );
  assert.deepEqual(created, {
    id: fixture.revisionId,
    workspaceId: fixture.workspaceId,
    documentId: fixture.documentId,
    baseDocumentVersionId: fixture.documentVersionId,
    revisionNumber: 1,
    operations: [
      { sourceBlockId: fixture.firstBlockId, operation: "edit", patch: { text: "人工修改后内容" } },
      { sourceBlockId: fixture.secondBlockId, operation: "split", patch: { at: 6 } },
    ],
  });
  const persisted = await admin.query<{
    revision_number: number;
    source_block_id: string;
    operation: string;
    patch: Record<string, unknown>;
  }>(
    `SELECT dr.revision_number, drb.source_block_id, drb.operation, drb.patch
       FROM document_revisions dr
       JOIN document_revision_blocks drb ON drb.revision_id = dr.id
      WHERE dr.id = $1
      ORDER BY drb.source_block_id`,
    [fixture.revisionId],
  );
  assert.equal(persisted.rows.length, 2);
  assert.ok(persisted.rows.every((row) => row.revision_number === 1));
  assert.deepEqual(
    persisted.rows.map((row) => ({ sourceBlockId: row.source_block_id, operation: row.operation, patch: row.patch })),
    [
      { sourceBlockId: fixture.firstBlockId, operation: "edit", patch: { text: "人工修改后内容" } },
      { sourceBlockId: fixture.secondBlockId, operation: "split", patch: { at: 6 } },
    ].sort((a, b) => a.sourceBlockId.localeCompare(b.sourceBlockId)),
  );
  console.log("  ✓ owner 的多个操作在单个 append-only 修订中原子持久化");

  const badRevisionId = uuidv7();
  await assert.rejects(
    () => revisions.createRevision(
      { learnerId: fixture.ownerId, workspaceId: fixture.workspaceId },
      {
        revisionId: badRevisionId,
        documentId: fixture.documentId,
        baseDocumentVersionId: fixture.documentVersionId,
        revisionNumber: 2,
        operations: [{ sourceBlockId: fixture.sameWorkspaceOtherDocumentBlockId, operation: "edit", patch: { text: "越权" } }],
      },
    ),
    /document_revision_source_blocks_not_found/,
  );
  const absent = await admin.query("SELECT id FROM document_revisions WHERE id=$1", [badRevisionId]);
  assert.deepEqual(absent.rows, []);
  console.log("  ✓ 同 Workspace 的其他 Document Block 在写入前被拒绝，且不会留下半成品");

  await assert.rejects(
    () => revisions.createRevision(
      { learnerId: fixture.ownerId, workspaceId: fixture.workspaceId },
      {
        revisionId: uuidv7(),
        documentId: fixture.documentId,
        baseDocumentVersionId: fixture.documentVersionId,
        revisionNumber: 2,
        operations: [
          { sourceBlockId: fixture.firstBlockId, operation: "edit", patch: { text: "一次" } },
          { sourceBlockId: fixture.firstBlockId, operation: "delete", patch: {} },
        ],
      },
    ),
    /invalid_document_revision_operations/,
  );
  console.log("  ✓ 同一 Block 的冲突操作在写入前被拒绝");

  await assert.rejects(
    () => revisions.createRevision(
      { learnerId: fixture.ownerId, workspaceId: fixture.workspaceId },
      {
        revisionId: uuidv7(),
        documentId: fixture.documentId,
        baseDocumentVersionId: fixture.documentVersionId,
        revisionNumber: 2,
        operations: [{ sourceBlockId: fixture.secondBlockId, operation: "edit", patch: { text: undefined } }],
      },
    ),
    /invalid_document_revision_operations/,
  );
  console.log("  ✓ 不能把会被 JSONB 静默丢弃的补丁字段写入修订");

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
  await admin.query("GRANT SELECT ON workspace_members, documents, document_versions, blocks TO sushua_web_test");
  await admin.query("GRANT INSERT ON document_revisions, document_revision_blocks TO sushua_web_test");
}

async function seedFixture(admin: Pool) {
  const ownerId = uuidv7();
  const workspaceId = uuidv7();
  const documentId = uuidv7();
  const documentVersionId = uuidv7();
  const pageId = uuidv7();
  const firstBlockId = uuidv7();
  const secondBlockId = uuidv7();
  const otherDocumentId = uuidv7();
  const otherDocumentVersionId = uuidv7();
  const otherPageId = uuidv7();
  const sameWorkspaceOtherDocumentBlockId = uuidv7();
  const now = new Date("2026-09-04T00:00:00.000Z");

  await admin.query("INSERT INTO learners(id) VALUES($1)", [ownerId]);
  await admin.query(
    "INSERT INTO workspaces(id,slug,title,visibility,created_by_learner_id) VALUES($1,$2,'修订模块','private',$3)",
    [workspaceId, `revision-module-${workspaceId.slice(0, 8)}`, ownerId],
  );
  await admin.query("INSERT INTO workspace_members(workspace_id,learner_id,role) VALUES($1,$2,'owner')", [workspaceId, ownerId]);
  await seedDocument(admin, {
    workspaceId,
    documentId,
    documentVersionId,
    pageId,
    blocks: [firstBlockId, secondBlockId],
    now,
    label: "target",
  });
  await seedDocument(admin, {
    workspaceId,
    documentId: otherDocumentId,
    documentVersionId: otherDocumentVersionId,
    pageId: otherPageId,
    blocks: [sameWorkspaceOtherDocumentBlockId],
    now,
    label: "other",
  });

  return {
    ownerId,
    workspaceId,
    documentId,
    documentVersionId,
    firstBlockId,
    secondBlockId,
    sameWorkspaceOtherDocumentBlockId,
    revisionId: uuidv7(),
  };
}

async function seedDocument(admin: Pool, input: {
  workspaceId: string;
  documentId: string;
  documentVersionId: string;
  pageId: string;
  blocks: string[];
  now: Date;
  label: string;
}) {
  await admin.query(
    `INSERT INTO documents(
      id,workspace_id,filename,mime_type,sha256,parse_status,idempotency_key,request_hash,created_at,updated_at
    ) VALUES($1,$2,$3,'application/pdf',$4,'ready',$5,$6,$7,$7)`,
    [input.documentId, input.workspaceId, `${input.label}.pdf`, "a".repeat(64), `revision-module-${input.label}`, "b".repeat(64), input.now],
  );
  await admin.query(
    `INSERT INTO document_versions(
      id,workspace_id,document_id,version,source_object_key,content_hash,status,created_at
    ) VALUES($1,$2,$3,1,$4,$5,'scanned',$6)`,
    [input.documentVersionId, input.workspaceId, input.documentId, `tenant/${input.workspaceId}/${input.documentId}/${input.documentVersionId}/source/original`, "c".repeat(64), input.now],
  );
  await admin.query("UPDATE documents SET current_version_id=$1 WHERE id=$2", [input.documentVersionId, input.documentId]);
  await admin.query(
    "INSERT INTO pages(id,workspace_id,document_version_id,page_number,width,height) VALUES($1,$2,$3,1,612,792)",
    [input.pageId, input.workspaceId, input.documentVersionId],
  );
  for (const [readingOrder, blockId] of input.blocks.entries()) {
    await admin.query(
      `INSERT INTO blocks(
        id,workspace_id,document_version_id,page_id,block_type,text,bbox,reading_order,confidence,source_hash
      ) VALUES($1,$2,$3,$4,'text',$5,'[0,0,1,0.5]'::jsonb,$6,0.9,$7)`,
      [blockId, input.workspaceId, input.documentVersionId, input.pageId, `${input.label}-${readingOrder}`, readingOrder, "d".repeat(64)],
    );
  }
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
