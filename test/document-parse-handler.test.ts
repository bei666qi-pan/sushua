import assert from "node:assert/strict";
import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";

import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";
import { DocumentServiceError } from "../src/features/documents/document-service-client";
import { createDocumentParseModule } from "../src/features/documents/document-parse";
import { JobExecutionError } from "../src/features/jobs/bullmq-job-worker";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;
const eventAt = new Date();

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_worker_test";
  url.password = "integration-only";
  return url.toString();
}

async function main() {
  const handlerModule = await import("../src/features/documents/document-parse-handler").catch(() => null);
  assert.ok(handlerModule, "document.parse handler must exist");

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
  await admin.query("GRANT EXECUTE ON FUNCTION start_document_parse_v1(uuid,timestamptz) TO sushua_worker_test");
  await admin.query(
    "GRANT EXECUTE ON FUNCTION record_document_parse_v1(uuid,text,text,text,text,text,integer,text,timestamptz) TO sushua_worker_test",
  );
  await admin.query("GRANT EXECUTE ON FUNCTION assert_job_attempt_v1(uuid,integer,text) TO sushua_worker_test");

  const success = await seedParse(admin, "handler-success", 3);
  const retry = await seedParse(admin, "handler-retry", 3);
  const rejected = await seedParse(admin, "handler-rejected", 3);
  const replay = await seedParse(admin, "handler-replay", 3);
  const worker = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const parses = createDocumentParseModule(worker, { now: () => eventAt });
  const indexer = {
    async index(input: { target: { documentVersionId: string }; result: { irSha256: string } }) {
      await markIndexed(admin, input.target.documentVersionId, input.result.irSha256);
      return { pageCount: 4, blockCount: 0, replayed: false };
    },
  };

  console.log("document.parse Handler");
  const parsedTargets: string[] = [];
  const successResult = resultFor(success);
  const handler = handlerModule.createDocumentParseHandler({
    parses,
    indexer,
    parser: {
      async parse(target: { documentVersionId: string }) {
        parsedTargets.push(target.documentVersionId);
        return successResult;
      },
    },
  });
  const progress: number[] = [];
  assert.deepEqual(await handler({
    job: success.job,
    signal: new AbortController().signal,
    reportProgress: async (value: { percent: number }) => { progress.push(value.percent); },
  }), { checkpoint: checkpoint(success, successResult) });
  assert.deepEqual(parsedTargets, [success.versionId]);
  assert.deepEqual(progress, [10, 90, 100]);
  assert.deepEqual(await state(admin, success.versionId), {
    version_status: "ready",
    error_code: null,
    ir_object_key: successResult.irObjectKey,
    document_status: "ready",
  });
  console.log("  ✓ 真实状态 seam 启动解析，结果证据落库后才返回 ready checkpoint");

  const transient = handlerModule.createDocumentParseHandler({
    parses,
    indexer,
    parser: {
      async parse() {
        throw new DocumentServiceError("document_service_unavailable", true);
      },
    },
  });
  await assert.rejects(
    () => transient({
      job: retry.job,
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
    }),
    (error: unknown) => error instanceof JobExecutionError
      && error.code === "document_service_unavailable"
      && error.retryable,
  );
  assert.deepEqual(await state(admin, retry.versionId), {
    version_status: "parsing",
    error_code: null,
    ir_object_key: null,
    document_status: "parsing",
  });
  await admin.query("UPDATE jobs SET attempt=max_attempts WHERE id=$1", [retry.job.id]);
  await assert.rejects(
    () => transient({
      job: { ...retry.job, attempt: retry.job.maxAttempts },
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
    }),
    (error: unknown) => error instanceof JobExecutionError
      && error.code === "document_service_unavailable"
      && error.retryable,
  );
  assert.deepEqual(await state(admin, retry.versionId), {
    version_status: "failed",
    error_code: "document_service_unavailable",
    ir_object_key: null,
    document_status: "failed",
  });
  console.log("  ✓ 临时故障在最终尝试前保留 parsing，耗尽尝试后明确失败");

  const permanent = handlerModule.createDocumentParseHandler({
    parses,
    indexer,
    parser: {
      async parse() {
        throw new DocumentServiceError("document_request_rejected", false);
      },
    },
  });
  await assert.rejects(
    () => permanent({
      job: rejected.job,
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
    }),
    (error: unknown) => error instanceof JobExecutionError
      && error.code === "document_request_rejected"
      && !error.retryable,
  );
  assert.equal((await state(admin, rejected.versionId)).version_status, "failed");
  console.log("  ✓ 确定性服务拒绝立即失败，不盲目重试");

  const replayTarget = await parses.start(replay.job.id, replay.job.attempt);
  const replayResult = resultFor(replay);
  await markIndexed(admin, replay.versionId, replayResult.irSha256);
  await parses.succeed(replay.job.id, replay.job.attempt, replayResult);
  let duplicateCalls = 0;
  const recovery = handlerModule.createDocumentParseHandler({
    parses,
    indexer,
    parser: {
      async parse() {
        duplicateCalls += 1;
        throw new Error("must_not_reparse");
      },
    },
  });
  assert.equal(replayTarget.parseStatus, "parsing");
  assert.deepEqual(await recovery({
    job: replay.job,
    signal: new AbortController().signal,
    reportProgress: async () => undefined,
  }), { checkpoint: checkpoint(replay, replayResult) });
  assert.equal(duplicateCalls, 0);
  console.log("  ✓ IR 已落库但 Job 未来得及成功时，重放从证据恢复而不重复解析");

  await worker.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

async function markIndexed(admin: Pool, documentVersionId: string, irSha256: string) {
  await admin.query(
    "UPDATE document_versions SET ir_indexed_sha256=$1, ir_indexed_at=$2 WHERE id=$3",
    [irSha256, eventAt, documentVersionId],
  );
}

function resultFor(seed: Awaited<ReturnType<typeof seedParse>>) {
  return {
    irObjectKey: `tenant/${seed.workspaceId}/${seed.documentId}/${seed.versionId}/ir/document-ir.json`,
    irSha256: "b".repeat(64),
    parser: "docling",
    parserVersion: "2.123.1",
    pageCount: 4,
    irSchemaVersion: "sushua.document-ir.v1" as const,
  };
}

function checkpoint(seed: Awaited<ReturnType<typeof seedParse>>, result: ReturnType<typeof resultFor>) {
  return {
    parseStatus: "ready",
    documentVersionId: seed.versionId,
    irObjectKey: result.irObjectKey,
    irSha256: result.irSha256,
    parser: result.parser,
    parserVersion: result.parserVersion,
    pageCount: result.pageCount,
  };
}

async function seedParse(admin: Pool, suffix: string, maxAttempts: number) {
  const learnerId = uuidv7();
  const workspaceId = uuidv7();
  const documentId = uuidv7();
  const versionId = uuidv7();
  const assetId = uuidv7();
  const scanJobId = uuidv7();
  const parseJobId = uuidv7();
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
    [documentId, workspaceId, `${suffix}.pdf`, "a".repeat(64), `document-${suffix}`, "c".repeat(64), eventAt],
  );
  await admin.query(
    `INSERT INTO document_versions(id,workspace_id,document_id,version,source_object_key,content_hash,parse_config,status,created_at)
     VALUES($1,$2,$3,1,$4,$5,'{}','scanned',$6)`,
    [versionId, workspaceId, documentId, sourceObjectKey, "a".repeat(64), eventAt],
  );
  await admin.query("UPDATE documents SET current_version_id=$1 WHERE id=$2", [versionId, documentId]);
  await admin.query(
    `INSERT INTO jobs(id,resource_id,type,workspace_id,idempotency_key,request_hash,schema_version,trace_id,priority,budget,
       state,progress,attempt,max_attempts,run_after,requested_at,finished_at,updated_at)
     VALUES($1,$2,'file.scan',$3,$4,$5,1,$6,0,'{}','succeeded',$7,1,2,$8,$8,$8,$8)`,
    [
      scanJobId,
      assetId,
      workspaceId,
      `file.scan:${assetId}`,
      "d".repeat(64),
      uuidv7(),
      { phase: "succeeded", percent: 100, updatedAt: eventAt.toISOString() },
      eventAt,
    ],
  );
  await admin.query(
    `INSERT INTO source_assets(id,workspace_id,document_version_id,kind,object_key,mime_type,size_bytes,sha256,
       scan_status,storage_upload_id,upload_expires_at,upload_state,upload_completed_at,
       completion_idempotency_key,completion_request_hash,scan_job_id,scanned_sha256,scanned_at,created_at)
     VALUES($1,$2,$3,'original',$4,'application/pdf',23,$5,'clean',$6,$7,'uploaded',$8,$9,$10,$11,$5,$8,$8)`,
    [
      assetId,
      workspaceId,
      versionId,
      sourceObjectKey,
      "a".repeat(64),
      `upload-${suffix}`,
      new Date(eventAt.getTime() + 300_000),
      eventAt,
      `complete-${suffix}`,
      "e".repeat(64),
      scanJobId,
    ],
  );
  await admin.query(
    `INSERT INTO jobs(id,resource_id,type,workspace_id,idempotency_key,request_hash,schema_version,trace_id,priority,budget,
       state,progress,attempt,max_attempts,run_after,timeout_at,requested_at,started_at,updated_at)
     VALUES($1,$2,'document.parse',$3,$4,$5,1,$6,0,'{}','running',$7,1,$8,$9,$10,$9,$9,$9)`,
    [
      parseJobId,
      versionId,
      workspaceId,
      `document.parse:${versionId}`,
      "f".repeat(64),
      uuidv7(),
      { phase: "running", percent: 0, updatedAt: eventAt.toISOString() },
      maxAttempts,
      eventAt,
      new Date(eventAt.getTime() + 900_000),
    ],
  );
  return {
    workspaceId,
    documentId,
    versionId,
    job: {
      id: parseJobId,
      workspaceId,
      resourceId: versionId,
      type: "document.parse" as const,
      state: "running" as const,
      progress: { phase: "running", percent: 0, updatedAt: eventAt.toISOString() },
      attempt: 1,
      maxAttempts,
      runAfter: eventAt.toISOString(),
    },
  };
}

async function state(admin: Pool, versionId: string) {
  const result = await admin.query(
    `SELECT dv.status AS version_status,dv.error_code,dv.ir_object_key,d.parse_status AS document_status
     FROM document_versions dv JOIN documents d ON d.id=dv.document_id WHERE dv.id=$1`,
    [versionId],
  );
  return result.rows[0];
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
