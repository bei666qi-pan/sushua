import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { Queue, QueueEvents } from "bullmq";
import { v7 as uuidv7 } from "uuid";

import { createJobWorkerRuntime } from "../apps/job-worker/src/runtime";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createBullMqJobDispatcher, redisConnectionFromUrl } from "../src/features/jobs/bullmq-job-dispatcher";

const databaseUrl = required("TEST_DATABASE_URL");
const redisUrl = required("TEST_REDIS_URL");
const clamavHost = required("TEST_CLAMAV_HOST");
const clamavPort = Number(required("TEST_CLAMAV_PORT"));

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_worker_test";
  url.password = "integration-only";
  return url.toString();
}

async function main() {
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
  await admin.query("GRANT EXECUTE ON FUNCTION claim_job_v1(uuid,integer,timestamptz) TO sushua_worker_test");
  await admin.query(
    "GRANT EXECUTE ON FUNCTION transition_job_v1(uuid,text,jsonb,jsonb,text,timestamptz,timestamptz) TO sushua_worker_test",
  );
  await admin.query("GRANT EXECUTE ON FUNCTION read_source_asset_scan_target_v1(uuid) TO sushua_worker_test");
  await admin.query(
    "GRANT EXECUTE ON FUNCTION record_source_asset_scan_v1(uuid,text,text,text,text,timestamptz) TO sushua_worker_test",
  );
  await admin.query(
    "GRANT EXECUTE ON FUNCTION schedule_document_parse_v1(uuid,uuid,uuid,text,timestamptz) TO sushua_worker_test",
  );
  await admin.query("GRANT EXECUTE ON FUNCTION start_document_parse_v1(uuid,timestamptz) TO sushua_worker_test");
  await admin.query(
    "GRANT EXECUTE ON FUNCTION record_document_parse_v1(uuid,text,text,text,text,text,integer,text,timestamptz) TO sushua_worker_test",
  );

  const cleanBytes = Buffer.from("queue to clean asset");
  const eicarBytes = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
  const clean = await seed(admin, "worker-clean", cleanBytes);
  const infected = await seed(admin, "worker-infected", eicarBytes);
  const entries = new Map([clean, infected].map((item) => [item.objectKey, item]));
  const queueName = `sushua-file-scan-${uuidv7()}`;
  const workerErrors: Error[] = [];
  const runtime = createJobWorkerRuntime({
    databaseUrl: roleUrl(databaseUrl),
    redisUrl,
    queueName,
    concurrency: 1,
    leaseSeconds: 60,
    clamav: { host: clamavHost, port: clamavPort },
    documentService: {
      baseUrl: "http://document-worker.invalid",
      token: "integration-only-document-token-0001",
    },
    s3: {
      bucket: "integration-only",
      clientConfig: {
        region: "integration-only",
        credentials: { accessKeyId: "integration-only", secretAccessKey: "integration-only" },
      },
    },
  }, (error) => workerErrors.push(error), {
    storage: {
      async stat(ref) {
        const entry = entries.get(ref.key);
        if (!entry) throw new Error("not_found");
        return { ref, sizeBytes: entry.bytes.byteLength, sha256: entry.sha256, mimeType: "application/pdf" };
      },
    },
    reader: {
      async read(ref) {
        const entry = entries.get(ref.key);
        if (!entry) throw new Error("not_found");
        return chunks(entry.bytes);
      },
    },
    parser: {
      async parse(target) {
        return {
          irObjectKey: `tenant/${target.workspaceId}/${target.documentId}/${target.documentVersionId}/ir/document-ir.json`,
          irSha256: "b".repeat(64),
          parser: "docling",
          parserVersion: "2.123.1",
          pageCount: 2,
          irSchemaVersion: "sushua.document-ir.v1",
        };
      },
    },
  });
  const dispatcher = createBullMqJobDispatcher({ queueName, redisUrl });
  const queueConnection = redisConnectionFromUrl(redisUrl);
  const eventsConnection = redisConnectionFromUrl(redisUrl);
  const queue = new Queue(queueName, { connection: queueConnection });
  const events = new QueueEvents(queueName, { connection: eventsConnection });

  try {
    await Promise.all([runtime.waitUntilReady(), events.waitUntilReady()]);
    console.log("apps/job-worker file.scan 因果链");

    await dispatcher.dispatch(clean.envelope);
    const cleanQueueJob = await queue.getJob(clean.jobId);
    assert.ok(cleanQueueJob);
    assert.deepEqual(await cleanQueueJob.waitUntilFinished(events, 10_000), { state: "succeeded" });
    assert.deepEqual(await persisted(admin, clean.jobId, clean.assetId), {
      job_state: "succeeded",
      job_error_code: null,
      scan_status: "clean",
      scan_error_code: null,
    });
    console.log("  ✓ Redis Job 被实际 Worker 消费，真实 clamd clean 后 Job/Asset 同时落入成功终态");

    const parse = await scheduledParseJob(admin, clean.versionId);
    assert.ok(parse, "clean scan must atomically schedule document.parse");
    const parseQueueJob = await queue.getJob(parse.jobId);
    assert.ok(parseQueueJob);
    assert.deepEqual(await parseQueueJob.waitUntilFinished(events, 10_000), { state: "succeeded" });
    assert.deepEqual(await persistedParse(admin, clean.versionId), {
      version_status: "ready",
      document_status: "ready",
      parser: "docling",
      page_count: 2,
    });
    console.log("  ✓ 同一实际 Worker 消费 document.parse，IR 证据落库后 Job 才成功");

    await dispatcher.dispatch(infected.envelope);
    const infectedQueueJob = await queue.getJob(infected.jobId);
    assert.ok(infectedQueueJob);
    await assert.rejects(() => infectedQueueJob.waitUntilFinished(events, 10_000), /malware_detected/);
    assert.deepEqual(await persisted(admin, infected.jobId, infected.assetId), {
      job_state: "failed",
      job_error_code: "malware_detected",
      scan_status: "infected",
      scan_error_code: "malware_detected",
    });
    assert.equal(await scheduledParseJob(admin, infected.versionId), undefined);
    assert.deepEqual(workerErrors, []);
    console.log("  ✓ EICAR 经同一队列链写 infected，Job 明确 failed 且无未处理 Worker 错误");
  } finally {
    await runtime.close();
    await queue.obliterate({ force: true }).catch(() => undefined);
    await events.close();
    await queue.close();
    await eventsConnection.quit().catch(() => undefined);
    await queueConnection.quit().catch(() => undefined);
    await dispatcher.close();
    await admin.end();
  }
  console.log("\n全部通过 ✓");
}

async function seed(admin: Pool, suffix: string, bytes: Buffer) {
  const learnerId = uuidv7();
  const workspaceId = uuidv7();
  const documentId = uuidv7();
  const versionId = uuidv7();
  const assetId = uuidv7();
  const jobId = uuidv7();
  const traceId = uuidv7();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const objectKey = `tenant/${workspaceId}/${documentId}/${versionId}/source/${assetId}`;
  const now = new Date();
  await admin.query("INSERT INTO learners(id) VALUES($1)", [learnerId]);
  await admin.query(
    "INSERT INTO workspaces(id,slug,title,visibility,created_by_learner_id) VALUES($1,$2,$2,'private',$3)",
    [workspaceId, suffix, learnerId],
  );
  await admin.query("INSERT INTO workspace_members(workspace_id,learner_id,role) VALUES($1,$2,'owner')", [workspaceId, learnerId]);
  await admin.query(
    `INSERT INTO documents(id,workspace_id,filename,mime_type,sha256,parse_status,idempotency_key,request_hash,created_at,updated_at)
     VALUES($1,$2,$3,'application/pdf',$4,'scan_pending',$5,$6,$7,$7)`,
    [documentId, workspaceId, `${suffix}.pdf`, sha256, suffix, "b".repeat(64), now],
  );
  await admin.query(
    `INSERT INTO document_versions(id,workspace_id,document_id,version,source_object_key,content_hash,status,created_at)
     VALUES($1,$2,$3,1,$4,$5,'scan_pending',$6)`,
    [versionId, workspaceId, documentId, objectKey, sha256, now],
  );
  await admin.query("UPDATE documents SET current_version_id=$1 WHERE id=$2", [versionId, documentId]);
  await admin.query(
    `INSERT INTO source_assets(id,workspace_id,document_version_id,kind,object_key,mime_type,size_bytes,sha256,scan_status,
      storage_upload_id,upload_expires_at,upload_state,upload_completed_at,completion_idempotency_key,completion_request_hash,created_at)
     VALUES($1,$2,$3,'original',$4,'application/pdf',$5,$6,'pending',$7,$8,'uploaded',$9,$10,$11,$9)`,
    [assetId, workspaceId, versionId, objectKey, bytes.byteLength, sha256, `upload-${suffix}`,
      new Date(now.getTime() + 300_000), now, `complete-${suffix}`, "c".repeat(64)],
  );
  const progress = { phase: "queued", percent: 0, updatedAt: now.toISOString() };
  await admin.query(
    `INSERT INTO jobs(id,resource_id,type,workspace_id,idempotency_key,request_hash,schema_version,trace_id,priority,budget,
      state,progress,attempt,max_attempts,run_after,requested_at,updated_at)
     VALUES($1,$2,'file.scan',$3,$4,$5,1,$6,0,'{}','queued',$7,0,2,$8,$8,$8)`,
    [jobId, assetId, workspaceId, `file.scan:${assetId}`, "d".repeat(64), traceId, progress, now],
  );
  return {
    jobId, assetId, objectKey, sha256, bytes, workspaceId, documentId, versionId,
    envelope: {
      schemaVersion: 1 as const,
      id: jobId,
      type: "file.scan" as const,
      workspaceId,
      learnerId,
      resourceId: assetId,
      idempotencyKey: `file.scan:${assetId}`,
      traceId,
      requestedAt: now.toISOString(),
      priority: 0,
      budget: {},
    },
  };
}

function chunks(value: Buffer): AsyncIterable<Uint8Array> {
  return { async *[Symbol.asyncIterator]() { yield value; } };
}

async function scheduledParseJob(admin: Pool, versionId: string) {
  const result = await admin.query(
    `SELECT id AS "jobId" FROM jobs
     WHERE resource_id=$1 AND type='document.parse' ORDER BY requested_at,id LIMIT 1`,
    [versionId],
  );
  return result.rows[0] as { jobId: string } | undefined;
}

async function persisted(admin: Pool, jobId: string, assetId: string) {
  const result = await admin.query(
    `SELECT j.state AS job_state,j.error_code AS job_error_code,
      sa.scan_status,sa.scan_error_code FROM jobs j JOIN source_assets sa ON sa.id=$2 WHERE j.id=$1`,
    [jobId, assetId],
  );
  return result.rows[0];
}

async function persistedParse(admin: Pool, versionId: string) {
  const result = await admin.query(
    `SELECT dv.status AS version_status,d.parse_status AS document_status,dv.parser,dv.page_count
     FROM document_versions dv JOIN documents d ON d.id=dv.document_id WHERE dv.id=$1`,
    [versionId],
  );
  return result.rows[0];
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
