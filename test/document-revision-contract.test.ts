import assert from "node:assert/strict";
import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";

import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const url: string = configuredDatabaseUrl;

async function main() {
  const pool = new Pool({ connectionString: url });
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await applyPostgresMigrations(pool);
  const tables = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('document_revisions','document_revision_blocks') ORDER BY tablename",
  );
  assert.deepEqual(tables.rows.map((row) => row.tablename), ["document_revision_blocks", "document_revisions"]);
  const policies = await pool.query<{ policyname: string }>("SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename IN ('document_revisions','document_revision_blocks') ORDER BY policyname");
  assert.deepEqual(policies.rows.map((row) => row.policyname), ["document_revision_blocks_editor_insert", "document_revision_blocks_member_select", "document_revisions_editor_insert", "document_revisions_member_select"]);
  const indexes = await pool.query<{ indexname: string }>(
    `SELECT indexname
       FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'document_revisions_created_by_learner_idx',
          'document_revisions_document_base_version_idx',
          'document_revision_blocks_revision_idx',
          'document_revision_blocks_source_idx'
        )
      ORDER BY indexname`,
  );
  assert.deepEqual(indexes.rows.map((row) => row.indexname), [
    "document_revision_blocks_revision_idx",
    "document_revision_blocks_source_idx",
    "document_revisions_created_by_learner_idx",
    "document_revisions_document_base_version_idx",
  ]);

  await ensureWebRole(pool);
  const fixture = await seedRevisionFixture(pool);
  const crossDocumentRevisionId = uuidv7();
  await pool.query(
    `INSERT INTO document_revisions(
      id, workspace_id, document_id, base_document_version_id, revision_number, created_by_learner_id
    ) VALUES($1,$2,$3,$4,99,$5)`,
    [crossDocumentRevisionId, fixture.workspaceId, fixture.documentId, fixture.documentVersionId, fixture.ownerId],
  );
  await assert.rejects(
    () => pool.query(
      `INSERT INTO document_revision_blocks(
        revision_id, workspace_id, base_document_version_id, source_block_id, operation, patch
      ) VALUES($1,$2,$3,$4,'edit',$5::jsonb)`,
      [
        crossDocumentRevisionId,
        fixture.workspaceId,
        fixture.documentVersionId,
        fixture.sameWorkspaceOtherSourceBlockId,
        JSON.stringify({ text: "跨文档篡改" }),
      ],
    ),
    (error: unknown) => isPostgresError(error, "23503"),
  );
  console.log("  ✓ 同一 Workspace 的不同 Document Block 也不能附加到修订");
  const runtime = createPostgresRuntime({ connectionString: roleUrl(url), maxConnections: 2 });

  const revisionId = uuidv7();
  await runtime.withTenant({ learnerId: fixture.ownerId, workspaceId: fixture.workspaceId }, async ({ query }) => {
    await query(
      `INSERT INTO document_revisions(
        id, workspace_id, document_id, base_document_version_id, revision_number, created_by_learner_id
      ) VALUES($1,$2,$3,$4,1,$5)`,
      [revisionId, fixture.workspaceId, fixture.documentId, fixture.documentVersionId, fixture.ownerId],
    );
    await query(
      `INSERT INTO document_revision_blocks(
        revision_id, workspace_id, base_document_version_id, source_block_id, operation, patch
      ) VALUES($1,$2,$3,$4,'edit',$5::jsonb)`,
      [revisionId, fixture.workspaceId, fixture.documentVersionId, fixture.sourceBlockId, JSON.stringify({ text: "人工核对后的正文" })],
    );
  });
  console.log("  ✓ owner 能以同租户 Block 创建 append-only 修订");

  await runtime.withTenant({ learnerId: fixture.viewerId, workspaceId: fixture.workspaceId }, async ({ query }) => {
    const visible = await query<{ id: string }>("SELECT id FROM document_revisions WHERE id=$1", [revisionId]);
    assert.deepEqual(visible.rows.map((row) => row.id), [revisionId]);
  });
  await runtime.withTenant({ learnerId: fixture.outsiderId, workspaceId: fixture.otherWorkspaceId }, async ({ query }) => {
    const hidden = await query<{ id: string }>("SELECT id FROM document_revisions WHERE id=$1", [revisionId]);
    assert.deepEqual(hidden.rows, []);
  });
  console.log("  ✓ 仅 Workspace member 能读取修订，外部租户无法枚举");

  await assert.rejects(
    () => runtime.withTenant({ learnerId: fixture.viewerId, workspaceId: fixture.workspaceId }, ({ query }) => query(
      `INSERT INTO document_revisions(
        id, workspace_id, document_id, base_document_version_id, revision_number, created_by_learner_id
      ) VALUES($1,$2,$3,$4,2,$5)`,
      [uuidv7(), fixture.workspaceId, fixture.documentId, fixture.documentVersionId, fixture.viewerId],
    )),
    (error: unknown) => isPostgresError(error, "42501"),
  );
  console.log("  ✓ viewer 不能创建修订");

  await assert.rejects(
    () => runtime.withTenant({ learnerId: fixture.ownerId, workspaceId: fixture.workspaceId }, ({ query }) => query(
      `INSERT INTO document_revision_blocks(
        revision_id, workspace_id, base_document_version_id, source_block_id, operation, patch
      ) VALUES($1,$2,$3,$4,'edit',$5::jsonb)`,
      [revisionId, fixture.workspaceId, fixture.documentVersionId, fixture.otherSourceBlockId, JSON.stringify({ text: "跨租户篡改" })],
    )),
    (error: unknown) => isPostgresError(error, "23503"),
  );
  await assert.rejects(
    () => runtime.withTenant({ learnerId: fixture.ownerId, workspaceId: fixture.workspaceId }, ({ query }) => query(
      `INSERT INTO document_revisions(
        id, workspace_id, document_id, base_document_version_id, revision_number, created_by_learner_id
      ) VALUES($1,$2,$3,$4,2,$5)`,
      [uuidv7(), fixture.workspaceId, fixture.documentId, fixture.otherDocumentVersionId, fixture.ownerId],
    )),
    (error: unknown) => isPostgresError(error, "23503"),
  );
  console.log("  ✓ 复合外键拒绝跨 Workspace Block 与不匹配的基础版本");

  await assert.rejects(
    () => runtime.withTenant({ learnerId: fixture.ownerId, workspaceId: fixture.workspaceId }, ({ query }) => query(
      `INSERT INTO document_revisions(
        id, workspace_id, document_id, base_document_version_id, revision_number, created_by_learner_id
      ) VALUES($1,$2,$3,$4,1,$5)`,
      [uuidv7(), fixture.workspaceId, fixture.documentId, fixture.documentVersionId, fixture.ownerId],
    )),
    (error: unknown) => isPostgresError(error, "23505"),
  );
  console.log("  ✓ 同一 Document 的 revision number 不能重复");

  const update = await runtime.withTenant(
    { learnerId: fixture.ownerId, workspaceId: fixture.workspaceId },
    ({ query }) => query(
      "UPDATE document_revisions SET revision_number=9 WHERE id=$1",
      [revisionId],
    ),
  );
  assert.equal(update.rowCount, 0);
  const deletion = await runtime.withTenant(
    { learnerId: fixture.ownerId, workspaceId: fixture.workspaceId },
    ({ query }) => query(
      "DELETE FROM document_revisions WHERE id=$1",
      [revisionId],
    ),
  );
  assert.equal(deletion.rowCount, 0);
  const immutable = await pool.query<{ revision_number: number }>(
    "SELECT revision_number FROM document_revisions WHERE id=$1",
    [revisionId],
  );
  assert.deepEqual(immutable.rows, [{ revision_number: 1 }]);
  console.log("  ✓ 即使角色具备 SQL 写权限，修订仍因缺少 RLS policy 而不可更新或删除");

  await runtime.close();
  await pool.end();
  console.log("Document revision persistence contract\n  ✓ immutable revision tables exist\n\n全部通过 ✓");
}

async function ensureWebRole(pool: Pool) {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_web_test') THEN
      CREATE ROLE sushua_web_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END $$`);
  await pool.query("GRANT USAGE ON SCHEMA public TO sushua_web_test");
  await pool.query("GRANT SELECT ON workspace_members, document_revisions, document_revision_blocks TO sushua_web_test");
  await pool.query("GRANT INSERT, UPDATE, DELETE ON document_revisions, document_revision_blocks TO sushua_web_test");
}

async function seedRevisionFixture(pool: Pool) {
  const ownerId = uuidv7();
  const viewerId = uuidv7();
  const outsiderId = uuidv7();
  const workspaceId = uuidv7();
  const otherWorkspaceId = uuidv7();
  const documentId = uuidv7();
  const documentVersionId = uuidv7();
  const otherDocumentId = uuidv7();
  const otherDocumentVersionId = uuidv7();
  const sameWorkspaceOtherDocumentId = uuidv7();
  const sameWorkspaceOtherDocumentVersionId = uuidv7();
  const pageId = uuidv7();
  const otherPageId = uuidv7();
  const sameWorkspaceOtherPageId = uuidv7();
  const sourceBlockId = uuidv7();
  const otherSourceBlockId = uuidv7();
  const sameWorkspaceOtherSourceBlockId = uuidv7();
  if (!sameWorkspaceOtherSourceBlockId) throw new Error("uuidv7 did not generate a block id");
  const now = new Date("2026-09-04T00:00:00.000Z");

  await pool.query("INSERT INTO learners(id) VALUES($1),($2),($3)", [ownerId, viewerId, outsiderId]);
  await pool.query(
    `INSERT INTO workspaces(id,slug,title,visibility,created_by_learner_id) VALUES
      ($1,$2,'修订测试','private',$3), ($4,$5,'其他租户','private',$6)`,
    [workspaceId, `revision-${workspaceId.slice(0, 8)}`, ownerId, otherWorkspaceId, `other-${otherWorkspaceId.slice(0, 8)}`, outsiderId],
  );
  await pool.query(
    `INSERT INTO workspace_members(workspace_id,learner_id,role) VALUES
      ($1,$2,'owner'),($1,$3,'viewer'),($4,$5,'owner')`,
    [workspaceId, ownerId, viewerId, otherWorkspaceId, outsiderId],
  );
  await seedDocument(pool, { workspaceId, documentId, documentVersionId, pageId, blockId: sourceBlockId, now, label: "owner" });
  await seedDocument(pool, { workspaceId: otherWorkspaceId, documentId: otherDocumentId, documentVersionId: otherDocumentVersionId, pageId: otherPageId, blockId: otherSourceBlockId, now, label: "outsider" });
  await seedDocument(pool, {
    workspaceId,
    documentId: sameWorkspaceOtherDocumentId,
    documentVersionId: sameWorkspaceOtherDocumentVersionId,
    pageId: sameWorkspaceOtherPageId,
    blockId: sameWorkspaceOtherSourceBlockId,
    now,
    label: "same-workspace-other-document",
  });

  return {
    ownerId,
    viewerId,
    outsiderId,
    workspaceId,
    otherWorkspaceId,
    documentId,
    documentVersionId,
    otherDocumentVersionId,
    sourceBlockId,
    otherSourceBlockId,
    sameWorkspaceOtherSourceBlockId,
  };
}

async function seedDocument(pool: Pool, input: {
  workspaceId: string;
  documentId: string;
  documentVersionId: string;
  pageId: string;
  blockId: string;
  now: Date;
  label: string;
}) {
  await pool.query(
    `INSERT INTO documents(
      id,workspace_id,filename,mime_type,sha256,parse_status,idempotency_key,request_hash,created_at,updated_at
    ) VALUES($1,$2,$3,'application/pdf',$4,'ready',$5,$6,$7,$7)`,
    [input.documentId, input.workspaceId, `${input.label}.pdf`, "a".repeat(64), `revision-${input.label}`, "b".repeat(64), input.now],
  );
  await pool.query(
    `INSERT INTO document_versions(
      id,workspace_id,document_id,version,source_object_key,content_hash,status,created_at
    ) VALUES($1,$2,$3,1,$4,$5,'scanned',$6)`,
    [input.documentVersionId, input.workspaceId, input.documentId, `tenant/${input.workspaceId}/${input.documentId}/${input.documentVersionId}/source/original`, "c".repeat(64), input.now],
  );
  await pool.query("UPDATE documents SET current_version_id=$1 WHERE id=$2", [input.documentVersionId, input.documentId]);
  await pool.query(
    "INSERT INTO pages(id,workspace_id,document_version_id,page_number,width,height) VALUES($1,$2,$3,1,612,792)",
    [input.pageId, input.workspaceId, input.documentVersionId],
  );
  await pool.query(
    `INSERT INTO blocks(
      id,workspace_id,document_version_id,page_id,block_type,text,bbox,reading_order,confidence,source_hash
    ) VALUES($1,$2,$3,$4,'text','待修订正文','[0,0,1,0.5]'::jsonb,0,0.9,$5)`,
    [input.blockId, input.workspaceId, input.documentVersionId, input.pageId, "d".repeat(64)],
  );
}

function roleUrl(source: string): string {
  const role = new URL(source);
  role.username = "sushua_web_test";
  role.password = "integration-only";
  return role.toString();
}

function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
main().catch((error) => { console.error(error); process.exit(1); });
