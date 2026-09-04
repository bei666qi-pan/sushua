import assert from "node:assert/strict";

import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";

import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;

async function main() {
  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await admin.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(admin);

  console.log("Question and concept schema");
  const tables = await admin.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname='public'
        AND tablename IN ('concepts','concept_sources','questions','question_versions','question_sources','question_concepts')
      ORDER BY tablename`,
  );
  assert.deepEqual(tables.rows.map((row) => row.tablename), [
    "concept_sources",
    "concepts",
    "question_concepts",
    "question_sources",
    "question_versions",
    "questions",
  ]);

  const expectedPolicies = [
    "concept_sources_editor_insert", "concept_sources_member_select", "concepts_editor_insert", "concepts_member_select",
    "question_concepts_editor_insert", "question_concepts_member_select", "question_sources_editor_insert", "question_sources_member_select",
    "question_versions_editor_insert", "question_versions_member_select", "questions_editor_insert", "questions_editor_update", "questions_member_select",
  ];
  const policies = await admin.query<{ policyname: string }>(
    `SELECT policyname FROM pg_policies
      WHERE schemaname='public'
        AND tablename IN ('concepts','concept_sources','questions','question_versions','question_sources','question_concepts')
      ORDER BY policyname`,
  );
  assert.deepEqual(policies.rows.map((row) => row.policyname), expectedPolicies);
  console.log("  ✓ 概念、题目、版本与来源证据表均受 RLS 保护");

  await ensureWebRole(admin);
  const fixture = await seedFixture(admin);
  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });

  const conceptId = uuidv7();
  const questionId = uuidv7();
  const versionId = uuidv7();
  await runtime.withTenant({ learnerId: fixture.ownerId, workspaceId: fixture.workspaceId }, async ({ query }) => {
    await query(
      `INSERT INTO concepts(id,workspace_id,name,normalized_name,description,status,created_by_learner_id)
       VALUES($1,$2,'牛顿第二定律','牛顿第二定律','力、质量与加速度的关系','ready',$3)`,
      [conceptId, fixture.workspaceId, fixture.ownerId],
    );
    await query(
      `INSERT INTO concept_sources(concept_id,workspace_id,document_version_id,block_id,relation,confidence)
       VALUES($1,$2,$3,$4,'defines',0.98)`,
      [conceptId, fixture.workspaceId, fixture.documentVersionId, fixture.blockId],
    );
    await query(
      `INSERT INTO questions(id,workspace_id,origin,type,status,created_by_learner_id)
       VALUES($1,$2,'ai','single_choice','draft',$3)`,
      [questionId, fixture.workspaceId, fixture.ownerId],
    );
    await query(
      `INSERT INTO question_versions(
        id,workspace_id,question_id,version,stem,options,answer,rubric,explanation,
        difficulty,cognitive_level,confidence,created_by_learner_id
      ) VALUES($1,$2,$3,1,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,3,'apply',0.91,$9)`,
      [
        versionId, fixture.workspaceId, questionId, "依据牛顿第二定律，质量不变时力增大，加速度会如何变化？",
        JSON.stringify([{ id: "A", text: "增大" }, { id: "B", text: "减小" }]), JSON.stringify(["A"]),
        JSON.stringify({ scoring: "exact" }), "F=ma，因此加速度随力增大。", fixture.ownerId,
      ],
    );
    await query("UPDATE questions SET current_version_id=$1 WHERE id=$2", [versionId, questionId]);
    await query(
      `INSERT INTO question_sources(
        question_version_id,workspace_id,document_version_id,page_id,block_id,bbox,source_quote,source_hash,relation
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'supports_stem')`,
      [versionId, fixture.workspaceId, fixture.documentVersionId, fixture.pageId, fixture.blockId, "[0.1,0.2,0.5,0.2]", "牛顿第二定律 F=ma", fixture.blockSourceHash],
    );
    await query(
      `INSERT INTO question_sources(
        question_version_id,workspace_id,document_version_id,page_id,block_id,bbox,source_quote,source_hash,relation
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'supports_answer')`,
      [versionId, fixture.workspaceId, fixture.documentVersionId, fixture.pageId, fixture.blockId, "[0.1,0.2,0.5,0.2]", "牛顿第二定律 F=ma", fixture.blockSourceHash],
    );
    await query(
      "INSERT INTO question_concepts(question_version_id,workspace_id,concept_id,weight,is_primary) VALUES($1,$2,$3,1,true)",
      [versionId, fixture.workspaceId, conceptId],
    );
  });
  console.log("  ✓ 同 Workspace 的题目版本可同时保存题干、答案、概念和 stem/answer 证据");

  await assert.rejects(
    () => runtime.withTenant({ learnerId: fixture.ownerId, workspaceId: fixture.workspaceId }, ({ query }) => query(
      `INSERT INTO question_sources(
        question_version_id,workspace_id,document_version_id,page_id,block_id,bbox,source_quote,source_hash,relation
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'supports_stem')`,
      [versionId, fixture.workspaceId, fixture.otherDocumentVersionId, fixture.otherPageId, fixture.otherBlockId, "[0.1,0.2,0.5,0.2]", "越权来源", fixture.otherBlockSourceHash],
    )),
    (error: unknown) => isPostgresError(error, "23503"),
  );
  console.log("  ✓ 跨 Workspace 的来源 Block 不能附加到题目版本");

  await assert.rejects(
    () => runtime.withTenant({ learnerId: fixture.ownerId, workspaceId: fixture.workspaceId }, ({ query }) => query(
      `INSERT INTO question_sources(
        question_version_id,workspace_id,document_version_id,page_id,block_id,bbox,source_quote,source_hash,relation
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'supports_stem')`,
      [versionId, fixture.workspaceId, fixture.documentVersionId, fixture.pageId, fixture.sameWorkspaceOtherBlockId, "[0.1,0.2,0.5,0.2]", "错配页块", fixture.sameWorkspaceOtherBlockSourceHash],
    )),
    (error: unknown) => isPostgresError(error, "23503"),
  );
  console.log("  ✓ 同 Workspace 的不同页 Block 也不能伪造来源定位");

  await assert.rejects(
    () => runtime.withTenant({ learnerId: fixture.ownerId, workspaceId: fixture.workspaceId }, ({ query }) => query(
      `INSERT INTO question_sources(
        question_version_id,workspace_id,document_version_id,page_id,block_id,bbox,source_quote,source_hash,relation
      ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'supports_explanation')`,
      [versionId, fixture.workspaceId, fixture.documentVersionId, fixture.pageId, fixture.blockId, "[0.1,0.2,0.5,0.2]", "漂移 hash", "f".repeat(64)],
    )),
    (error: unknown) => isPostgresError(error, "23503"),
  );
  console.log("  ✓ 引用的 source hash 必须等于对应 Block 的证据 hash");

  await assert.rejects(
    () => runtime.withTenant({ learnerId: fixture.ownerId, workspaceId: fixture.workspaceId }, ({ query }) => query(
      "INSERT INTO questions(id,workspace_id,parent_question_id,origin,type,status,created_by_learner_id) VALUES($1,$2,$3,'variant','single_choice','draft',$4)",
      [uuidv7(), fixture.workspaceId, fixture.otherQuestionId, fixture.ownerId],
    )),
    (error: unknown) => isPostgresError(error, "23503"),
  );
  console.log("  ✓ 变式题父题不能跨 Workspace");

  await runtime.withTenant({ learnerId: fixture.viewerId, workspaceId: fixture.workspaceId }, async ({ query }) => {
    const visible = await query<{ id: string }>("SELECT id FROM question_versions WHERE id=$1", [versionId]);
    assert.deepEqual(visible.rows, [{ id: versionId }]);
  });
  await runtime.withTenant({ learnerId: fixture.outsiderId, workspaceId: fixture.otherWorkspaceId }, async ({ query }) => {
    const hidden = await query<{ id: string }>("SELECT id FROM question_versions WHERE id=$1", [versionId]);
    assert.deepEqual(hidden.rows, []);
  });
  console.log("  ✓ 同 Workspace 成员可读，其他租户不能枚举题目版本");

  const update = await runtime.withTenant(
    { learnerId: fixture.ownerId, workspaceId: fixture.workspaceId },
    ({ query }) => query("UPDATE question_versions SET stem='篡改' WHERE id=$1", [versionId]),
  );
  const deletion = await runtime.withTenant(
    { learnerId: fixture.ownerId, workspaceId: fixture.workspaceId },
    ({ query }) => query("DELETE FROM question_versions WHERE id=$1", [versionId]),
  );
  assert.equal(update.rowCount, 0);
  assert.equal(deletion.rowCount, 0);
  console.log("  ✓ QuestionVersion 没有更新或删除 policy，保持不可变");

  await runtime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

async function ensureWebRole(pool: Pool) {
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_question_test') THEN
      CREATE ROLE sushua_question_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END $$`);
  await pool.query("GRANT USAGE ON SCHEMA public TO sushua_question_test");
  await pool.query("GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_members, concepts, concept_sources, questions, question_versions, question_sources, question_concepts TO sushua_question_test");
}

async function seedFixture(pool: Pool) {
  const ownerId = uuidv7();
  const viewerId = uuidv7();
  const outsiderId = uuidv7();
  const workspaceId = uuidv7();
  const otherWorkspaceId = uuidv7();
  const ownDocument = await seedDocument(pool, { workspaceId, label: "own" });
  const otherDocument = await seedDocument(pool, { workspaceId: otherWorkspaceId, label: "other" });
  const sameWorkspaceOtherPageId = uuidv7();
  const sameWorkspaceOtherBlockId = uuidv7();
  const sameWorkspaceOtherBlockSourceHash = "b".repeat(64);
  const otherQuestionId = uuidv7();

  await pool.query("INSERT INTO learners(id) VALUES($1),($2),($3)", [ownerId, viewerId, outsiderId]);
  await pool.query(
    `INSERT INTO workspaces(id,slug,title,visibility,created_by_learner_id) VALUES
      ($1,$2,'题目来源测试','private',$3),($4,$5,'其他题目来源测试','private',$6)`,
    [workspaceId, `questions-${workspaceId.slice(0, 8)}`, ownerId, otherWorkspaceId, `questions-other-${otherWorkspaceId.slice(0, 8)}`, outsiderId],
  );
  await pool.query(
    `INSERT INTO workspace_members(workspace_id,learner_id,role) VALUES
      ($1,$2,'owner'),($1,$3,'viewer'),($4,$5,'owner')`,
    [workspaceId, ownerId, viewerId, otherWorkspaceId, outsiderId],
  );

  await finalizeDocument(pool, ownDocument, workspaceId, sameWorkspaceOtherPageId, sameWorkspaceOtherBlockId, sameWorkspaceOtherBlockSourceHash);
  await finalizeDocument(pool, otherDocument, otherWorkspaceId);
  await pool.query(
    "INSERT INTO questions(id,workspace_id,origin,type,status,created_by_learner_id) VALUES($1,$2,'user','single_choice','draft',$3)",
    [otherQuestionId, otherWorkspaceId, outsiderId],
  );
  return {
    ownerId, viewerId, outsiderId, workspaceId, otherWorkspaceId,
    documentVersionId: ownDocument.versionId, pageId: ownDocument.pageId, blockId: ownDocument.blockId, blockSourceHash: ownDocument.blockSourceHash,
    otherDocumentVersionId: otherDocument.versionId, otherPageId: otherDocument.pageId, otherBlockId: otherDocument.blockId, otherBlockSourceHash: otherDocument.blockSourceHash,
    sameWorkspaceOtherBlockId, sameWorkspaceOtherBlockSourceHash, otherQuestionId,
  };
}

async function seedDocument(pool: Pool, input: { workspaceId: string; label: string }) {
  return {
    documentId: uuidv7(), versionId: uuidv7(), pageId: uuidv7(), blockId: uuidv7(), blockSourceHash: "a".repeat(64), label: input.label, workspaceId: input.workspaceId,
  };
}

async function finalizeDocument(
  pool: Pool,
  document: Awaited<ReturnType<typeof seedDocument>>,
  workspaceId: string,
  extraPageId?: string,
  extraBlockId?: string,
  extraBlockSourceHash?: string,
) {
  const now = new Date("2026-09-04T00:00:00.000Z");
  await pool.query(
    `INSERT INTO documents(id,workspace_id,filename,mime_type,sha256,parse_status,idempotency_key,request_hash,created_at,updated_at)
     VALUES($1,$2,$3,'application/pdf',$4,'ready',$5,$6,$7,$7)`,
    [document.documentId, workspaceId, `${document.label}.pdf`, "a".repeat(64), `question-${document.label}`, "b".repeat(64), now],
  );
  await pool.query(
    `INSERT INTO document_versions(id,workspace_id,document_id,version,source_object_key,content_hash,status,created_at)
     VALUES($1,$2,$3,1,$4,$5,'ready',$6)`,
    [document.versionId, workspaceId, document.documentId, `tenant/${workspaceId}/${document.documentId}/${document.versionId}/source/original`, "c".repeat(64), now],
  );
  await pool.query("UPDATE documents SET current_version_id=$1 WHERE id=$2", [document.versionId, document.documentId]);
  await pool.query("INSERT INTO pages(id,workspace_id,document_version_id,page_number,width,height) VALUES($1,$2,$3,1,612,792)", [document.pageId, workspaceId, document.versionId]);
  await pool.query(
    `INSERT INTO blocks(id,workspace_id,document_version_id,page_id,block_type,text,bbox,reading_order,confidence,source_hash)
     VALUES($1,$2,$3,$4,'text','牛顿第二定律 F=ma','[0.1,0.2,0.5,0.2]'::jsonb,0,0.99,$5)`,
    [document.blockId, workspaceId, document.versionId, document.pageId, document.blockSourceHash],
  );
  if (extraPageId && extraBlockId && extraBlockSourceHash) {
    await pool.query("INSERT INTO pages(id,workspace_id,document_version_id,page_number,width,height) VALUES($1,$2,$3,2,612,792)", [extraPageId, workspaceId, document.versionId]);
    await pool.query(
      `INSERT INTO blocks(id,workspace_id,document_version_id,page_id,block_type,text,bbox,reading_order,confidence,source_hash)
       VALUES($1,$2,$3,$4,'text','同资料另一页','[0.1,0.2,0.5,0.2]'::jsonb,0,0.99,$5)`,
      [extraBlockId, workspaceId, document.versionId, extraPageId, extraBlockSourceHash],
    );
  }
}

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_question_test";
  url.password = "integration-only";
  return url.toString();
}

function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
