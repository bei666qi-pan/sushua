import assert from "node:assert/strict";
import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";

import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;
const eventAt = new Date("2026-09-01T05:00:00.000Z");

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_worker_test";
  url.password = "integration-only";
  return url.toString();
}

async function main() {
  const parseModule = await import("../src/features/documents/document-parse").catch(() => null);
  assert.ok(parseModule, "Document parse state Module must exist");

  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await admin.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(admin);
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_worker_test') THEN
      CREATE ROLE sushua_worker_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END $$`);
  await admin.query("GRANT USAGE ON SCHEMA public TO sushua_worker_test");

  const clean = await seedParse(admin, "parse-clean", "clean");
  const dirty = await seedParse(admin, "parse-dirty", "pending");
  const unsafe = await seedParse(admin, "parse-unsafe", "clean");
  const failed = await seedParse(admin, "parse-failed", "clean");
  const worker = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const parses = parseModule.createDocumentParseModule(worker, { now: () => eventAt });

  console.log("Document parse 持久化状态机");
  await assert.rejects(() => parses.start(clean.jobId), /permission denied/);
  await assert.rejects(
    () => worker.withTenant({ learnerId: uuidv7() }, ({ query }) => query("SELECT * FROM document_versions")),
    /permission denied|row-level security/,
  );
  console.log("  ✓ Worker 未显式授权时无法读写租户表或调用解析函数");

  await admin.query("GRANT EXECUTE ON FUNCTION start_document_parse_v1(uuid,timestamptz) TO sushua_worker_test");
  await admin.query(
    "GRANT EXECUTE ON FUNCTION record_document_parse_v1(uuid,text,text,text,text,text,integer,text,timestamptz) TO sushua_worker_test",
  );

  assert.deepEqual(await parses.start(clean.jobId), {
    jobId: clean.jobId,
    workspaceId: clean.workspaceId,
    documentId: clean.documentId,
    documentVersionId: clean.versionId,
    sourceAssetId: clean.assetId,
    sourceObjectKey: clean.sourceObjectKey,
    sourceSha256: "a".repeat(64),
    sizeBytes: 23,
    mimeType: "application/pdf",
    parseConfig: { mode: "unknown" },
    irSchemaVersion: "sushua.document-ir.v1" as const,
    parseStatus: "parsing",
  });
  assert.deepEqual(await versionState(admin, clean.versionId), {
    version_status: "parsing",
    parse_job_id: clean.jobId,
    version_error_code: null,
    document_status: "parsing",
  });
  assert.equal((await parses.start(clean.jobId)).parseStatus, "parsing");
  console.log("  ✓ 只凭持久 Job 推导已扫描资产，原子进入 parsing 且可幂等重放");

  await assert.rejects(() => parses.start(dirty.jobId), /parse_target_not_clean/);
  assert.deepEqual(await versionState(admin, dirty.versionId), {
    version_status: "scanned",
    parse_job_id: null,
    version_error_code: null,
    document_status: "scan_pending",
  });
  console.log("  ✓ 未通过病毒扫描的对象不能进入解析");

  const result = {
    irObjectKey: `tenant/${clean.workspaceId}/${clean.documentId}/${clean.versionId}/ir/document-ir.json`,
    irSha256: "b".repeat(64),
    parser: "docling",
    parserVersion: "2.123.1",
    pageCount: 4,
    irSchemaVersion: "sushua.document-ir.v1" as const,
  };
  assert.deepEqual(await parses.succeed(clean.jobId, result), { status: "ready", replayed: false });
  assert.deepEqual(await versionState(admin, clean.versionId), {
    version_status: "ready",
    parse_job_id: clean.jobId,
    version_error_code: null,
    document_status: "ready",
  });
  assert.deepEqual(await parseEvidence(admin, clean.versionId), {
    ir_object_key: result.irObjectKey,
    ir_sha256: result.irSha256,
    parser: result.parser,
    parser_version: result.parserVersion,
    page_count: 4,
    ir_schema_version: result.irSchemaVersion,
    parsed_at: eventAt,
  });
  assert.deepEqual(await parses.succeed(clean.jobId, result), { status: "ready", replayed: true });
  await assert.rejects(
    () => parses.succeed(clean.jobId, { ...result, irSha256: "c".repeat(64) }),
    /parse_result_conflict/,
  );
  const replayed = await parses.start(clean.jobId);
  assert.equal(replayed.parseStatus, "ready");
  assert.deepEqual(replayed.result, result);
  console.log("  ✓ IR 对象、哈希、Parser 版本和页数持久化，同结果可重放而冲突结果被拒绝");

  await parses.start(unsafe.jobId);
  await assert.rejects(
    () => parses.succeed(unsafe.jobId, {
      ...result,
      irObjectKey: `tenant/${unsafe.workspaceId}/${unsafe.documentId}/${unsafe.versionId}/ir/../source/original.pdf`,
    }),
    /invalid_parse_result/,
  );
  assert.deepEqual(await versionState(admin, unsafe.versionId), {
    version_status: "parsing",
    parse_job_id: unsafe.jobId,
    version_error_code: null,
    document_status: "parsing",
  });
  console.log("  ✓ IR 对象键中的路径逃逸在持久化前失败关闭");

  await parses.start(failed.jobId);
  assert.deepEqual(await parses.fail(failed.jobId, "document_service_unavailable"), {
    status: "failed",
    replayed: false,
  });
  assert.deepEqual(await parses.fail(failed.jobId, "document_service_unavailable"), {
    status: "failed",
    replayed: true,
  });
  await assert.rejects(() => parses.fail(failed.jobId, "different_error"), /parse_result_conflict/);
  assert.deepEqual(await versionState(admin, failed.versionId), {
    version_status: "failed",
    parse_job_id: failed.jobId,
    version_error_code: "document_service_unavailable",
    document_status: "failed",
  });
  console.log("  ✓ 最终失败使 DocumentVersion 与 Document 明确失败，不伪装 ready");

  await worker.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

async function seedParse(admin: Pool, suffix: string, scanStatus: "clean" | "pending") {
  const learnerId = uuidv7();
  const workspaceId = uuidv7();
  const documentId = uuidv7();
  const versionId = uuidv7();
  const assetId = uuidv7();
  const jobId = uuidv7();
  const traceId = uuidv7();
  const scanJobId = uuidv7();
  const scanTraceId = uuidv7();
  const sourceObjectKey = `tenant/${workspaceId}/${documentId}/${versionId}/source/${assetId}`;
  await admin.query("INSERT INTO learners(id) VALUES($1)", [learnerId]);
  await admin.query(
    "INSERT INTO workspaces(id,slug,title,visibility,created_by_learner_id) VALUES($1,$2,$2,'private',$3)",
    [workspaceId, suffix, learnerId],
  );
  await admin.query("INSERT INTO workspace_members(workspace_id,learner_id,role) VALUES($1,$2,'owner')", [
    workspaceId,
    learnerId,
  ]);
  await admin.query(
    `INSERT INTO documents(id,workspace_id,filename,mime_type,sha256,parse_status,idempotency_key,request_hash,created_at,updated_at)
     VALUES($1,$2,$3,'application/pdf',$4,'scan_pending',$5,$6,$7,$7)`,
    [documentId, workspaceId, `${suffix}.pdf`, "a".repeat(64), `document-${suffix}`, "b".repeat(64), eventAt],
  );
  await admin.query(
    `INSERT INTO document_versions(
       id,workspace_id,document_id,version,source_object_key,content_hash,parse_config,status,created_at
     ) VALUES($1,$2,$3,1,$4,$5,$6,'scanned',$7)`,
    [versionId, workspaceId, documentId, sourceObjectKey, "a".repeat(64), { mode: "unknown" }, eventAt],
  );
  await admin.query("UPDATE documents SET current_version_id=$1 WHERE id=$2", [versionId, documentId]);
  if (scanStatus === "clean") {
    await admin.query(
      `INSERT INTO jobs(
         id,resource_id,type,workspace_id,idempotency_key,request_hash,schema_version,trace_id,priority,budget,
         state,progress,attempt,max_attempts,run_after,requested_at,finished_at,updated_at
       ) VALUES($1,$2,'file.scan',$3,$4,$5,1,$6,0,'{}','succeeded',$7,1,2,$8,$8,$8,$8)`,
      [
        scanJobId,
        assetId,
        workspaceId,
        `file.scan:${assetId}`,
        "e".repeat(64),
        scanTraceId,
        { phase: "succeeded", percent: 100, updatedAt: eventAt.toISOString() },
        eventAt,
      ],
    );
  }
  await admin.query(
    `INSERT INTO source_assets(
       id,workspace_id,document_version_id,kind,object_key,mime_type,size_bytes,sha256,scan_status,
       storage_upload_id,upload_expires_at,upload_state,upload_completed_at,
       completion_idempotency_key,completion_request_hash,scan_job_id,scanned_sha256,scanned_at,created_at
     ) VALUES($1,$2,$3,'original',$4,'application/pdf',23,$5::char(64),$6::source_asset_scan_status,
       $7,$8,'uploaded',$9,$10,$11,
       CASE WHEN $6::text='clean' THEN $12::uuid ELSE NULL END,
       CASE WHEN $6::text='clean' THEN $5::char(64) ELSE NULL END,
       CASE WHEN $6::text='clean' THEN $9::timestamptz ELSE NULL END,$9)`,
    [
      assetId,
      workspaceId,
      versionId,
      sourceObjectKey,
      "a".repeat(64),
      scanStatus,
      `upload-${suffix}`,
      new Date(eventAt.getTime() + 300_000),
      eventAt,
      `complete-${suffix}`,
      "c".repeat(64),
      scanJobId,
    ],
  );
  await admin.query(
    `INSERT INTO jobs(
       id,resource_id,type,workspace_id,idempotency_key,request_hash,schema_version,trace_id,priority,budget,
       state,progress,attempt,max_attempts,run_after,timeout_at,requested_at,started_at,updated_at
     ) VALUES($1,$2,'document.parse',$3,$4,$5,1,$6,0,'{}','running',$7,1,3,$8,$9,$8,$8,$8)`,
    [
      jobId,
      versionId,
      workspaceId,
      `document.parse:${versionId}`,
      "d".repeat(64),
      traceId,
      { phase: "running", percent: 0, updatedAt: eventAt.toISOString() },
      eventAt,
      new Date(eventAt.getTime() + 900_000),
    ],
  );
  return { workspaceId, documentId, versionId, assetId, jobId, sourceObjectKey };
}

async function versionState(admin: Pool, versionId: string) {
  const result = await admin.query(
    `SELECT dv.status AS version_status,dv.parse_job_id,dv.error_code AS version_error_code,d.parse_status AS document_status
     FROM document_versions dv JOIN documents d ON d.id=dv.document_id WHERE dv.id=$1`,
    [versionId],
  );
  return result.rows[0];
}

async function parseEvidence(admin: Pool, versionId: string) {
  const result = await admin.query(
    `SELECT ir_object_key,ir_sha256,parser,parser_version,page_count,ir_schema_version,parsed_at
     FROM document_versions WHERE id=$1`,
    [versionId],
  );
  return result.rows[0];
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
