import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";

import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";
import { JobExecutionError } from "../src/features/jobs/bullmq-job-worker";
import { createClamAvAdapter } from "../src/features/security/clamav-adapter";
import { createSourceAssetScanModule } from "../src/features/security/source-asset-scan";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
const clamHost = requiredEnvironment("TEST_CLAMAV_HOST");
const clamPort = Number(process.env.TEST_CLAMAV_PORT);
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
if (!Number.isInteger(clamPort) || clamPort < 1 || clamPort > 65_535) {
  throw new Error("TEST_CLAMAV_PORT is required");
}
const databaseUrl: string = configuredDatabaseUrl;
const eventAt = new Date("2026-09-01T04:00:00.000Z");

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_worker_test";
  url.password = "integration-only";
  return url.toString();
}

async function main() {
  const handlerModule = await import("../src/features/security/file-scan-handler").catch(() => null);
  assert.ok(handlerModule, "file.scan handler must exist");

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
  await admin.query("GRANT EXECUTE ON FUNCTION read_source_asset_scan_target_v1(uuid) TO sushua_worker_test");
  await admin.query(
    "GRANT EXECUTE ON FUNCTION record_source_asset_scan_v1(uuid,text,text,text,text,timestamptz) TO sushua_worker_test",
  );

  const cleanBytes = Buffer.from("SuShua integration test");
  const tamperedBytes = Buffer.from("tampered object bytes!!!");
  const eicarBytes = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
  const clean = await seedScan(admin, "handler-clean", cleanBytes);
  const tampered = await seedScan(admin, "handler-tampered", Buffer.from("expected object bytes!!!"));
  const infected = await seedScan(admin, "handler-infected", eicarBytes);
  const transient = await seedScan(admin, "handler-transient", cleanBytes, 2);

  const worker = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const scans = createSourceAssetScanModule(worker, { now: () => eventAt });
  const scanner = createClamAvAdapter({ host: clamHost, port: clamPort, timeoutMs: 30_000 });
  const bodies = new Map([
    [clean.objectKey, cleanBytes],
    [tampered.objectKey, tamperedBytes],
    [infected.objectKey, eicarBytes],
  ]);
  const metadata = new Map([clean, tampered, infected, transient].map((item) => [item.objectKey, {
    ref: { key: item.objectKey },
    sizeBytes: item.sizeBytes,
    sha256: item.sha256,
    mimeType: "application/pdf",
  }]));
  const handler = handlerModule.createFileScanHandler({
    scans,
    scanner,
    storage: {
      async stat(ref: { key: string }) {
        const value = metadata.get(ref.key);
        if (!value) throw new Error("storage_object_not_found");
        return value;
      },
    },
    reader: {
      async read(ref: { key: string }) {
        const value = bodies.get(ref.key);
        if (!value) throw new Error("storage_object_not_found");
        return chunks(value.subarray(0, 7), value.subarray(7));
      },
    },
  });

  console.log("file.scan Handler");
  const progress: Array<{ phase: string; percent: number }> = [];
  assert.deepEqual(await handler({
    job: clean.job,
    signal: new AbortController().signal,
    reportProgress: async (value: { phase: string; percent: number }) => { progress.push(value); },
  }), { checkpoint: { scanStatus: "clean", assetId: clean.assetId, sha256: clean.sha256 } });
  assert.equal((await assetStatus(admin, clean.assetId)).scan_status, "clean");
  assert.deepEqual(progress.map((item) => item.percent), [10, 40, 100]);
  console.log("  ✓ 真实 clamd 返回 clean 且流式字节 SHA256/长度一致后才持久化 clean");

  await assert.rejects(
    () => handler({
      job: tampered.job,
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
    }),
    (error: unknown) => error instanceof JobExecutionError
      && error.code === "object_integrity_mismatch"
      && !error.retryable,
  );
  assert.deepEqual(await assetStatus(admin, tampered.assetId), {
    scan_status: "failed",
    scan_error_code: "object_integrity_mismatch",
  });
  console.log("  ✓ 对象正文被调包时即使 stat 元数据正确也不能写 clean");

  await assert.rejects(
    () => handler({
      job: infected.job,
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
    }),
    (error: unknown) => error instanceof JobExecutionError
      && error.code === "malware_detected"
      && !error.retryable,
  );
  assert.deepEqual(await assetStatus(admin, infected.assetId), {
    scan_status: "infected",
    scan_error_code: "malware_detected",
  });
  console.log("  ✓ 真实标准 EICAR 回包写 infected，并以永久错误阻断 Job");

  const unavailable = handlerModule.createFileScanHandler({
    scans,
    scanner,
    storage: { stat: async () => { throw new Error("private storage detail"); } },
    reader: { read: async () => { throw new Error("must_not_read"); } },
  });
  await assert.rejects(
    () => unavailable({
      job: transient.job,
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
    }),
    (error: unknown) => error instanceof JobExecutionError
      && error.code === "storage_read_failed"
      && error.retryable
      && !error.message.includes("private"),
  );
  assert.equal((await assetStatus(admin, transient.assetId)).scan_status, "pending");
  await assert.rejects(
    () => unavailable({
      job: { ...transient.job, attempt: 2 },
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
    }),
    (error: unknown) => error instanceof JobExecutionError && error.code === "storage_read_failed",
  );
  assert.deepEqual(await assetStatus(admin, transient.assetId), {
    scan_status: "failed",
    scan_error_code: "storage_read_failed",
  });
  console.log("  ✓ 临时存储故障可重试，只有最后一次尝试才把 Asset 明确标为 failed");

  await worker.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

function chunks(...values: Buffer[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) yield value;
    },
  };
}

async function seedScan(admin: Pool, suffix: string, expectedBytes: Buffer, maxAttempts = 2) {
  const learnerId = uuidv7();
  const workspaceId = uuidv7();
  const documentId = uuidv7();
  const versionId = uuidv7();
  const assetId = uuidv7();
  const jobId = uuidv7();
  const traceId = uuidv7();
  const objectKey = `tenant/${workspaceId}/${documentId}/${versionId}/source/${assetId}`;
  const sha256 = createHash("sha256").update(expectedBytes).digest("hex");
  await admin.query("INSERT INTO learners (id) VALUES ($1)", [learnerId]);
  await admin.query(
    "INSERT INTO workspaces (id,slug,title,visibility,created_by_learner_id) VALUES ($1,$2,$3,'private',$4)",
    [workspaceId, suffix, suffix, learnerId],
  );
  await admin.query("INSERT INTO workspace_members (workspace_id,learner_id,role) VALUES ($1,$2,'owner')", [
    workspaceId,
    learnerId,
  ]);
  await admin.query(
    `INSERT INTO documents (
       id,workspace_id,filename,mime_type,sha256,parse_status,idempotency_key,request_hash,created_at,updated_at
     ) VALUES ($1,$2,$3,'application/pdf',$4,'scan_pending',$5,$6,$7,$7)`,
    [documentId, workspaceId, `${suffix}.pdf`, sha256, `document-${suffix}`, "b".repeat(64), eventAt],
  );
  await admin.query(
    `INSERT INTO document_versions (
       id,workspace_id,document_id,version,source_object_key,content_hash,status,created_at
     ) VALUES ($1,$2,$3,1,$4,$5,'scan_pending',$6)`,
    [versionId, workspaceId, documentId, objectKey, sha256, eventAt],
  );
  await admin.query("UPDATE documents SET current_version_id=$1 WHERE id=$2", [versionId, documentId]);
  await admin.query(
    `INSERT INTO source_assets (
       id,workspace_id,document_version_id,kind,object_key,mime_type,size_bytes,sha256,scan_status,
       storage_upload_id,upload_expires_at,upload_state,upload_completed_at,
       completion_idempotency_key,completion_request_hash,created_at
     ) VALUES ($1,$2,$3,'original',$4,'application/pdf',$5,$6,'pending',$7,$8,'uploaded',$9,$10,$11,$9)`,
    [
      assetId,
      workspaceId,
      versionId,
      objectKey,
      expectedBytes.byteLength,
      sha256,
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
     ) VALUES ($1,$2,'file.scan',$3,$4,$5,1,$6,0,'{}','running',$7,1,$8,$9,$10,$9,$9,$9)`,
    [
      jobId,
      assetId,
      workspaceId,
      `file.scan:${assetId}`,
      "d".repeat(64),
      traceId,
      { phase: "running", percent: 0, updatedAt: eventAt.toISOString() },
      maxAttempts,
      eventAt,
      new Date(eventAt.getTime() + 300_000),
    ],
  );
  return {
    assetId,
    objectKey,
    sizeBytes: expectedBytes.byteLength,
    sha256,
    job: {
      id: jobId,
      workspaceId,
      resourceId: assetId,
      type: "file.scan" as const,
      state: "running" as const,
      progress: { phase: "running", percent: 0, updatedAt: eventAt.toISOString() },
      attempt: 1,
      maxAttempts,
      runAfter: eventAt.toISOString(),
      timeoutAt: new Date(eventAt.getTime() + 300_000).toISOString(),
    },
  };
}

async function assetStatus(admin: Pool, assetId: string) {
  const result = await admin.query(
    "SELECT scan_status,scan_error_code FROM source_assets WHERE id=$1",
    [assetId],
  );
  return result.rows[0];
}

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
