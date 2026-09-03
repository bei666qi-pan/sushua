import assert from "node:assert/strict";

import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";

import { applyPostgresMigrations } from "../src/db/postgres/migrate";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;

async function main() {
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await admin.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(admin);

  console.log("Document IR schema");
  const tables = await admin.query<{ name: string | null }>(
    "SELECT to_regclass($1)::text AS name UNION ALL SELECT to_regclass($2)::text",
    ["public.pages", "public.blocks"],
  );
  assert.deepEqual(tables.rows.map((row) => row.name), ["pages", "blocks"]);
  console.log("  ✓ DocumentVersion has persisted Page and Block relations");

  const ownerA = uuidv7();
  const ownerB = uuidv7();
  const documentA = await seedDocument(admin, "a", ownerA);
  const documentB = await seedDocument(admin, "b", ownerB);
  const pageA = uuidv7();
  await admin.query(
    `INSERT INTO pages(id,workspace_id,document_version_id,page_number,width,height)
     VALUES($1,$2,$3,1,612,792)`,
    [pageA, documentA.workspaceId, documentA.versionId],
  );
  await admin.query(
    `INSERT INTO blocks(
       id,workspace_id,document_version_id,page_id,block_type,text,markdown,bbox,
       reading_order,confidence,source_hash
     ) VALUES($1,$2,$3,$4,'text','来源文字','来源文字','[0,0,1,1]'::jsonb,0,0.99,$5)`,
    [uuidv7(), documentA.workspaceId, documentA.versionId, pageA, "a".repeat(64)],
  );

  await assert.rejects(
    () => admin.query(
      `INSERT INTO pages(id,workspace_id,document_version_id,page_number,width,height)
       VALUES($1,$2,$3,2,0,792)`,
      [uuidv7(), documentA.workspaceId, documentA.versionId],
    ),
    /pages_dimensions_positive/,
  );
  await assert.rejects(
    () => admin.query(
      `INSERT INTO blocks(
         id,workspace_id,document_version_id,page_id,block_type,bbox,reading_order,confidence,source_hash
       ) VALUES($1,$2,$3,$4,'unknown','[0,0,1.1,1]'::jsonb,1,0.5,$5)`,
      [uuidv7(), documentA.workspaceId, documentA.versionId, pageA, "b".repeat(64)],
    ),
    /blocks_bbox_normalized/,
  );
  await assert.rejects(
    () => admin.query(
      `INSERT INTO pages(id,workspace_id,document_version_id,page_number,width,height)
       VALUES($1,$2,$3,1,612,792)`,
      [uuidv7(), documentA.workspaceId, documentB.versionId],
    ),
    /pages_version_fk/,
  );
  console.log("  ✓ Page dimensions, normalized bbox and Workspace-scoped version relation reject invalid writes");

  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_ir_reader_test') THEN
      CREATE ROLE sushua_ir_reader_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END $$`);
  await admin.query("GRANT USAGE ON SCHEMA public TO sushua_ir_reader_test");
  await admin.query("GRANT SELECT ON pages, blocks, workspace_members TO sushua_ir_reader_test");
  const reader = new Pool({ connectionString: roleUrl(databaseUrl), max: 1 });
  assert.equal(await visiblePageCount(reader, ownerA), 1);
  assert.equal(await visiblePageCount(reader, ownerB), 0);
  console.log("  ✓ RLS exposes Pages only to a Workspace member");

  await reader.end();
  await admin.end();
}

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_ir_reader_test";
  url.password = "integration-only";
  return url.toString();
}

async function visiblePageCount(pool: Pool, learnerId: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.learner_id',$1,true)", [learnerId]);
    const result = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM pages");
    await client.query("COMMIT");
    return Number(result.rows[0]?.count);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedDocument(admin: Pool, suffix: string, learnerId: string) {
  const workspaceId = uuidv7();
  const documentId = uuidv7();
  const versionId = uuidv7();
  const createdAt = new Date();
  await admin.query("INSERT INTO learners(id) VALUES($1)", [learnerId]);
  await admin.query(
    `INSERT INTO workspaces(id,slug,title,visibility,created_by_learner_id)
     VALUES($1,$2,$2,'private',$3)`,
    [workspaceId, `ir-${suffix}-${workspaceId.slice(0, 8)}`, learnerId],
  );
  await admin.query(
    "INSERT INTO workspace_members(workspace_id,learner_id,role) VALUES($1,$2,'owner')",
    [workspaceId, learnerId],
  );
  await admin.query(
    `INSERT INTO documents(
       id,workspace_id,filename,mime_type,sha256,parse_status,idempotency_key,request_hash,created_at,updated_at
     ) VALUES($1,$2,$3,'application/pdf',$4,'parsing',$5,$6,$7,$7)`,
    [documentId, workspaceId, `${suffix}.pdf`, "a".repeat(64), `ir-${suffix}`, "b".repeat(64), createdAt],
  );
  await admin.query(
    `INSERT INTO document_versions(
       id,workspace_id,document_id,version,source_object_key,content_hash,status,created_at
     ) VALUES($1,$2,$3,1,$4,$5,'parsing',$6)`,
    [versionId, workspaceId, documentId,
      `tenant/${workspaceId}/${documentId}/${versionId}/source/original`, "a".repeat(64), createdAt],
  );
  await admin.query("UPDATE documents SET current_version_id=$1 WHERE id=$2", [versionId, documentId]);
  return { workspaceId, versionId };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
