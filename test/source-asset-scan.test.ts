import assert from "node:assert/strict";
import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";

import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;
const eventAt = new Date("2026-09-01T04:00:00.000Z");

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_worker_test";
  url.password = "integration-only";
  return url.toString();
}

async function main() {
  const scanModule = await import("../src/features/security/source-asset-scan").catch(() => null);
  assert.ok(scanModule, "SourceAsset scan transaction Module must exist");

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

  const clean = await seedScan(admin, "clean");
  const infected = await seedScan(admin, "infected");
  const failed = await seedScan(admin, "failed");
  const worker = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const scans = scanModule.createSourceAssetScanModule(worker, { now: () => eventAt });

  console.log("SourceAsset 扫描事务");
  await assert.rejects(() => scans.getTarget(clean.jobId), /permission denied/);
  await assert.rejects(
    () => worker.withTenant({ learnerId: uuidv7() }, ({ query }) => query("SELECT * FROM source_assets")),
    /permission denied|row-level security/,
  );
  console.log("  ✓ Worker 未显式授权时既不能调用扫描函数，也不能直接读取租户表");

  await admin.query("GRANT EXECUTE ON FUNCTION read_source_asset_scan_target_v1(uuid) TO sushua_worker_test");
  await admin.query(
    "GRANT EXECUTE ON FUNCTION record_source_asset_scan_v1(uuid,text,text,text,text,timestamptz) TO sushua_worker_test",
  );
  await admin.query(
    "GRANT EXECUTE ON FUNCTION schedule_document_parse_v1(uuid,uuid,uuid,text,timestamptz) TO sushua_worker_test",
  );
  assert.deepEqual(await scans.getTarget(clean.jobId), {
    jobId: clean.jobId,
    workspaceId: clean.workspaceId,
    assetId: clean.assetId,
    objectKey: clean.objectKey,
    sizeBytes: 23,
    sha256: "a".repeat(64),
    mimeType: "application/pdf",
    scanStatus: "pending",
  });
  console.log("  ✓ 只凭 job_id 从 PostgreSQL 权威 Job 推导 Workspace、Asset 与对象元数据");

  await assert.rejects(
    () => scans.record(clean.jobId, { status: "clean", actualSha256: "b".repeat(64) }),
    /scan_hash_mismatch/,
  );
  assert.equal((await assetState(admin, clean.assetId)).scan_status, "pending");
  console.log("  ✓ 实际对象哈希不符时数据库拒绝 clean，且三层状态均不推进");

  const scheduled = await scans.record(clean.jobId, { status: "clean", actualSha256: "a".repeat(64) });
  assert.equal(scheduled.status, "clean");
  assert.equal(scheduled.replayed, false);
  assert.equal(scheduled.nextJob?.type, "document.parse");
  assert.equal(scheduled.nextJob?.resourceId, clean.versionId);
  assert.equal(scheduled.nextJob?.workspaceId, clean.workspaceId);
  assert.deepEqual(await assetState(admin, clean.assetId), {
    scan_status: "clean",
    scan_job_id: clean.jobId,
    scanned_sha256: "a".repeat(64),
    scan_signature: null,
    scan_error_code: null,
    version_status: "scanned",
    version_error_code: null,
    parse_status: "scan_pending",
  });
  const replayed = await scans.record(clean.jobId, { status: "clean", actualSha256: "a".repeat(64) });
  assert.equal(replayed.status, "clean");
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.nextJob?.id, scheduled.nextJob?.id);
  await assert.rejects(
    () => scans.record(clean.jobId, { status: "failed", errorCode: "scanner_protocol_error" }),
    /scan_result_conflict/,
  );
  console.log("  ✓ clean 与 document.parse Job 同事务落库；重放返回同一 Job，冲突结果被拒绝");

  assert.deepEqual(await scans.record(infected.jobId, {
    status: "infected",
    actualSha256: "a".repeat(64),
    signature: "Win.Test.EICAR_HDB-1",
  }), { status: "infected", replayed: false });
  assert.deepEqual(await assetState(admin, infected.assetId), {
    scan_status: "infected",
    scan_job_id: infected.jobId,
    scanned_sha256: "a".repeat(64),
    scan_signature: "Win.Test.EICAR_HDB-1",
    scan_error_code: "malware_detected",
    version_status: "failed",
    version_error_code: "malware_detected",
    parse_status: "failed",
  });
  console.log("  ✓ infected 明确保存受限签名并阻断 Version/Document 后续解析");

  assert.deepEqual(await scans.record(failed.jobId, {
    status: "failed",
    errorCode: "clamav_protocol_error",
  }), { status: "failed", replayed: false });
  assert.deepEqual(await assetState(admin, failed.assetId), {
    scan_status: "failed",
    scan_job_id: failed.jobId,
    scanned_sha256: null,
    scan_signature: null,
    scan_error_code: "clamav_protocol_error",
    version_status: "failed",
    version_error_code: "clamav_protocol_error",
    parse_status: "failed",
  });
  console.log("  ✓ 扫描协议失败保留安全错误码，不伪装 clean 或部分成功");

  await worker.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

async function seedScan(admin: Pool, suffix: string) {
  const learnerId = uuidv7();
  const workspaceId = uuidv7();
  const documentId = uuidv7();
  const versionId = uuidv7();
  const assetId = uuidv7();
  const jobId = uuidv7();
  const traceId = uuidv7();
  const objectKey = `tenant/${workspaceId}/${documentId}/${versionId}/source/${assetId}`;
  await admin.query("INSERT INTO learners (id) VALUES ($1)", [learnerId]);
  await admin.query(
    "INSERT INTO workspaces (id,slug,title,visibility,created_by_learner_id) VALUES ($1,$2,$3,'private',$4)",
    [workspaceId, `scan-${suffix}`, `Scan ${suffix}`, learnerId],
  );
  await admin.query("INSERT INTO workspace_members (workspace_id,learner_id,role) VALUES ($1,$2,'owner')", [
    workspaceId,
    learnerId,
  ]);
  await admin.query(
    `INSERT INTO documents (
       id,workspace_id,filename,mime_type,sha256,parse_status,idempotency_key,request_hash,created_at,updated_at
     ) VALUES ($1,$2,$3,'application/pdf',$4,'scan_pending',$5,$6,$7,$7)`,
    [documentId, workspaceId, `${suffix}.pdf`, "a".repeat(64), `document-${suffix}`, "b".repeat(64), eventAt],
  );
  await admin.query(
    `INSERT INTO document_versions (
       id,workspace_id,document_id,version,source_object_key,content_hash,status,created_at
     ) VALUES ($1,$2,$3,1,$4,$5,'scan_pending',$6)`,
    [versionId, workspaceId, documentId, objectKey, "a".repeat(64), eventAt],
  );
  await admin.query("UPDATE documents SET current_version_id=$1 WHERE id=$2", [versionId, documentId]);
  await admin.query(
    `INSERT INTO source_assets (
       id,workspace_id,document_version_id,kind,object_key,mime_type,size_bytes,sha256,scan_status,
       storage_upload_id,upload_expires_at,upload_state,upload_completed_at,
       completion_idempotency_key,completion_request_hash,created_at
     ) VALUES ($1,$2,$3,'original',$4,'application/pdf',23,$5,'pending',$6,$7,'uploaded',$8,$9,$10,$8)`,
    [
      assetId,
      workspaceId,
      versionId,
      objectKey,
      "a".repeat(64),
      `upload-${suffix}`,
      new Date(eventAt.getTime() + 300_000),
      eventAt,
      `complete-${suffix}`,
      "c".repeat(64),
    ],
  );
  await admin.query(
    `INSERT INTO jobs (
       id,resource_id,type,workspace_id,idempotency_key,request_hash,schema_version,trace_id,priority,budget,
       state,progress,attempt,max_attempts,run_after,timeout_at,requested_at,started_at,updated_at
     ) VALUES ($1,$2,'file.scan',$3,$4,$5,1,$6,0,'{}','running',$7,1,2,$8,$9,$8,$8,$8)`,
    [
      jobId,
      assetId,
      workspaceId,
      `file.scan:${assetId}`,
      "d".repeat(64),
      traceId,
      { phase: "running", percent: 0, updatedAt: eventAt.toISOString() },
      eventAt,
      new Date(eventAt.getTime() + 300_000),
    ],
  );
  return { workspaceId, documentId, versionId, assetId, jobId, objectKey };
}

async function assetState(admin: Pool, assetId: string) {
  const result = await admin.query(
    `SELECT sa.scan_status,sa.scan_job_id,sa.scanned_sha256,sa.scan_signature,sa.scan_error_code,
       dv.status AS version_status,dv.error_code AS version_error_code,d.parse_status
     FROM source_assets sa
     JOIN document_versions dv ON dv.id=sa.document_version_id
     JOIN documents d ON d.id=dv.document_id
     WHERE sa.id=$1`,
    [assetId],
  );
  return result.rows[0];
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
