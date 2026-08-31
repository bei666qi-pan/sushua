import assert from "node:assert/strict";
import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";
import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";
import { createDocumentModule } from "../src/features/documents/document-module";
import { createMemoryStorageAdapter } from "../src/features/storage/storage";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;
const completionSignature = "complete_source_upload_v1(uuid,uuid,uuid,text,bigint,text,text,text,text,text,uuid,uuid,timestamp with time zone)";

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_web_test";
  url.password = "integration-only";
  return url.toString();
}

function request(learnerId: string, url: string, body: unknown, key?: string) {
  const headers = new Headers({ "content-type": "application/json", "x-test-learner": learnerId });
  if (key) headers.set("idempotency-key", key);
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

function completedParts(partCount: number, suffix = "") {
  return Array.from({ length: partCount }, (_, index) => ({
    part_number: index + 1,
    etag: `\"part-${index + 1}${suffix}\"`,
  }));
}

async function main() {
  const uploadModule = await import("../src/features/uploads/upload-module");
  const uploadApi = await import("../src/features/uploads/api");
  assert.equal(typeof uploadApi.createUploadCompleteHandler, "function");

  const admin = new Pool({ connectionString: databaseUrl, max: 3 });
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await admin.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(admin);
  const completionFunction = await admin.query<{ function_name: string | null }>(
    "SELECT to_regprocedure($1)::text AS function_name",
    [completionSignature],
  );
  assert.equal(completionFunction.rows[0]?.function_name, completionSignature, "atomic upload completion function must exist");
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_web_test') THEN
      CREATE ROLE sushua_web_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END $$`);
  await admin.query("GRANT USAGE ON SCHEMA public TO sushua_web_test");
  await admin.query("GRANT SELECT, INSERT, UPDATE ON documents, document_versions, source_assets, workspace_members TO sushua_web_test");
  const defaultExecute = await admin.query<{ allowed: boolean }>(
    "SELECT has_function_privilege('sushua_web_test', $1, 'EXECUTE') AS allowed",
    [completionSignature],
  );
  assert.equal(defaultExecute.rows[0]?.allowed, false, "upload completion function must not be executable through PUBLIC");
  await admin.query(`GRANT EXECUTE ON FUNCTION ${completionSignature} TO sushua_web_test`);

  const owner = uuidv7();
  const viewer = uuidv7();
  const outsider = uuidv7();
  const workspace = uuidv7();
  const otherWorkspace = uuidv7();
  await admin.query("INSERT INTO learners (id) VALUES ($1),($2),($3)", [owner, viewer, outsider]);
  await admin.query(
    `INSERT INTO workspaces (id,slug,title,visibility,created_by_learner_id) VALUES
       ($1,'complete-owner','完成上传空间','private',$2),
       ($3,'complete-outsider','其他空间','private',$4)`,
    [workspace, owner, otherWorkspace, outsider],
  );
  await admin.query(
    `INSERT INTO workspace_members (workspace_id,learner_id,role) VALUES
       ($1,$2,'owner'),($1,$3,'viewer'),($4,$5,'owner')`,
    [workspace, owner, viewer, otherWorkspace, outsider],
  );

  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 3 });
  let uploadIndex = 0;
  const storage = createMemoryStorageAdapter({
    now: () => new Date("2026-09-01T14:00:00.000Z"),
    newId: () => `complete-upload-${++uploadIndex}`,
  });
  const documents = createDocumentModule(runtime, { now: () => new Date("2026-09-01T14:00:00.000Z") });
  const uploads = uploadModule.createUploadModule({ documents, storage, newId: uuidv7 });
  assert.equal(typeof uploads.complete, "function", "Upload Module must finalize multipart uploads");
  let identityCalls = 0;
  const identity = {
    resolve: async (incoming: Request) => {
      identityCalls += 1;
      const learnerId = incoming.headers.get("x-test-learner");
      if (!learnerId) throw new Error("missing_test_identity");
      return learnerId === owner
        ? { learnerId, kind: "guest" as const, setCookie: "sushua.guest=signed; HttpOnly; Secure" }
        : { learnerId, userId: uuidv7(), kind: "user" as const };
    },
  };
  const initHandler = uploadApi.createUploadInitHandler({ enabled: true, identity, uploads });
  const completeHandler = uploadApi.createUploadCompleteHandler({ enabled: true, identity, uploads });
  const uploadBody = {
    workspace_id: workspace,
    filename: "线性代数.pdf",
    size: 11 * 1024 * 1024,
    mime_type: "application/pdf",
    sha256: "a".repeat(64),
    mode: "study_material",
  };

  async function initialize(filename: string, key: string) {
    const response = await initHandler(request(owner, "https://sushua.test/api/v1/uploads", { ...uploadBody, filename }, key));
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  }

  console.log("上传完成 API");
  const initialized = await initialize("线性代数.pdf", "init-linear-001");
  const assetId = initialized.data.asset_id as string;
  const completeUrl = `https://sushua.test/api/v1/uploads/${assetId}/complete`;
  const completeBody = {
    upload_id: initialized.data.upload.upload_id,
    sha256: uploadBody.sha256,
    parts: completedParts(initialized.data.upload.parts.length),
  };

  const callsBeforeMissingKey = identityCalls;
  const missingKey = await completeHandler(request(owner, completeUrl, completeBody), assetId);
  assert.equal(missingKey.status, 400);
  assert.equal((await missingKey.json()).error.code, "idempotency_key_required");
  assert.equal(identityCalls, callsBeforeMissingKey);
  console.log("  ✓ 缺 Idempotency-Key 在身份与存储访问前失败");

  const callsBeforeInvalidParts = identityCalls;
  const invalidParts = await completeHandler(request(owner, completeUrl, {
    ...completeBody,
    parts: [
      { part_number: 1, etag: '"part-1"' },
      { part_number: 1, etag: '"duplicate"' },
    ],
  }, "complete-invalid-parts"), assetId);
  assert.equal(invalidParts.status, 400);
  assert.equal((await invalidParts.json()).error.code, "invalid_parts");
  assert.equal(identityCalls, callsBeforeInvalidParts);
  console.log("  ✓ 重复或缺号分片在身份与存储访问前失败");

  const completed = await completeHandler(request(owner, completeUrl, completeBody, "complete-linear-001"), assetId);
  assert.equal(completed.status, 202, await completed.clone().text());
  const completedBody = await completed.json();
  assert.equal(completedBody.data.resource_id, assetId);
  assert.equal(completedBody.data.type, "file.scan");
  assert.equal(completedBody.data.state, "queued");
  assert.match(completedBody.data.job_id, /^[0-9a-f-]{36}$/);
  assert.equal(completedBody.data.status_url, `/api/v1/jobs/${completedBody.data.job_id}`);
  assert.equal(completedBody.data.stream_url, `/api/v1/jobs/${completedBody.data.job_id}/stream`);
  assert.match(completed.headers.get("set-cookie") ?? "", /HttpOnly/);
  const persisted = await admin.query<{
    upload_state: string;
    upload_completed_at: Date;
    parse_status: string;
    version_status: string;
  }>(`SELECT sa.upload_state,sa.upload_completed_at,d.parse_status,dv.status AS version_status
      FROM source_assets sa
      JOIN document_versions dv ON dv.id=sa.document_version_id
      JOIN documents d ON d.id=dv.document_id
      WHERE sa.id=$1`, [assetId]);
  assert.deepEqual(persisted.rows.map((row) => ({
    upload_state: row.upload_state,
    upload_completed_at: row.upload_completed_at.toISOString(),
    parse_status: row.parse_status,
    version_status: row.version_status,
  })), [{
    upload_state: "uploaded",
    upload_completed_at: "2026-09-01T14:00:00.000Z",
    parse_status: "scan_pending",
    version_status: "scan_pending",
  }]);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM jobs")).rows[0]?.count, 1);
  console.log("  ✓ 对象校验后原子推进三层状态并创建 file.scan Job");

  const replay = await completeHandler(request(owner, completeUrl, completeBody, "complete-linear-001"), assetId);
  assert.equal(replay.status, 202);
  const replayBody = await replay.json();
  assert.equal(replayBody.data.job_id, completedBody.data.job_id);
  assert.equal(replayBody.meta.idempotent_replay, true);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM jobs")).rows[0]?.count, 1);
  console.log("  ✓ 相同完成请求重放原 Job，不重复入队");

  const conflict = await completeHandler(request(owner, completeUrl, {
    ...completeBody,
    parts: completedParts(initialized.data.upload.parts.length, "-changed"),
  }, "complete-linear-001"), assetId);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "idempotency_conflict");
  console.log("  ✓ 同键不同完成清单明确冲突");

  const viewerResponse = await completeHandler(request(viewer, completeUrl, completeBody, "viewer-complete"), assetId);
  assert.equal(viewerResponse.status, 404);
  const outsiderResponse = await completeHandler(request(outsider, completeUrl, completeBody, "outsider-complete"), assetId);
  assert.equal(outsiderResponse.status, 404);
  console.log("  ✓ viewer 与其他租户都不能完成上传，统一防枚举 404");

  const securityBoundary = (await admin.query<{
    storage_upload_id: string;
    size_bytes: string;
    sha256: string;
    mime_type: string;
    completion_idempotency_key: string;
    completion_request_hash: string;
    job_request_hash: string;
    upload_completed_at: Date;
  }>(`SELECT sa.storage_upload_id,sa.size_bytes,sa.sha256,sa.mime_type,
        sa.completion_idempotency_key,sa.completion_request_hash,j.request_hash AS job_request_hash,
        sa.upload_completed_at
      FROM source_assets sa
      JOIN jobs j ON j.resource_id=sa.id AND j.type='file.scan'
      WHERE sa.id=$1`, [assetId])).rows[0];
  assert.ok(securityBoundary);
  await assert.rejects(
    () => runtime.withTenant({ learnerId: viewer, workspaceId: workspace }, ({ query }) => query(
      "SELECT complete_source_upload_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [
        assetId,
        workspace,
        viewer,
        securityBoundary.storage_upload_id,
        Number(securityBoundary.size_bytes),
        securityBoundary.sha256,
        securityBoundary.mime_type,
        securityBoundary.completion_idempotency_key,
        securityBoundary.completion_request_hash,
        securityBoundary.job_request_hash,
        uuidv7(),
        uuidv7(),
        securityBoundary.upload_completed_at,
      ],
    )),
    /upload_not_found/,
  );
  console.log("  ✓ SECURITY DEFINER 函数自行拒绝 viewer，不能绕过 HTTP 前置授权");

  const mismatch = await initialize("错误摘要.pdf", "init-mismatch-001");
  const mismatchAssetId = mismatch.data.asset_id as string;
  const mismatchResponse = await completeHandler(request(owner,
    `https://sushua.test/api/v1/uploads/${mismatchAssetId}/complete`, {
      upload_id: mismatch.data.upload.upload_id,
      sha256: "b".repeat(64),
      parts: completedParts(mismatch.data.upload.parts.length),
    }, "complete-mismatch-001"), mismatchAssetId);
  assert.equal(mismatchResponse.status, 409);
  assert.equal((await mismatchResponse.json()).error.code, "upload_metadata_mismatch");
  const mismatchAsset = (await admin.query<{
    object_key: string;
    storage_upload_id: string;
    mime_type: string;
    size_bytes: string;
    sha256: string;
    upload_state: string;
  }>("SELECT object_key,storage_upload_id,mime_type,size_bytes,sha256,upload_state FROM source_assets WHERE id=$1", [mismatchAssetId])).rows[0];
  assert.ok(mismatchAsset);
  assert.equal(mismatchAsset.upload_state, "initiated");
  assert.equal((await storage.resumeUpload({
    ref: { key: mismatchAsset.object_key },
    mimeType: mismatchAsset.mime_type,
    sizeBytes: Number(mismatchAsset.size_bytes),
    sha256: mismatchAsset.sha256,
  }, mismatchAsset.storage_upload_id)).uploadId, mismatchAsset.storage_upload_id);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM jobs")).rows[0]?.count, 1);
  console.log("  ✓ 客户端 SHA 与草稿不符时不完成对象、不推进状态也不创建 Job");

  const recovery = await initialize("概率论.pdf", "init-recovery-001");
  const recoveryAssetId = recovery.data.asset_id as string;
  const recoveryUrl = `https://sushua.test/api/v1/uploads/${recoveryAssetId}/complete`;
  const recoveryBody = {
    upload_id: recovery.data.upload.upload_id,
    sha256: uploadBody.sha256,
    parts: completedParts(recovery.data.upload.parts.length),
  };
  await admin.query(`REVOKE EXECUTE ON FUNCTION ${completionSignature} FROM sushua_web_test`);
  const dbFailure = await completeHandler(request(owner, recoveryUrl, recoveryBody, "complete-recovery-001"), recoveryAssetId);
  assert.equal(dbFailure.status, 503);
  assert.equal((await admin.query("SELECT upload_state FROM source_assets WHERE id=$1", [recoveryAssetId])).rows[0]?.upload_state, "initiated");
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM jobs")).rows[0]?.count, 1);
  await admin.query(`GRANT EXECUTE ON FUNCTION ${completionSignature} TO sushua_web_test`);
  const recovered = await completeHandler(request(owner, recoveryUrl, recoveryBody, "complete-recovery-001"), recoveryAssetId);
  assert.equal(recovered.status, 202, await recovered.clone().text());
  assert.equal((await admin.query("SELECT upload_state FROM source_assets WHERE id=$1", [recoveryAssetId])).rows[0]?.upload_state, "uploaded");
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM jobs")).rows[0]?.count, 2);
  console.log("  ✓ 对象已完成但数据库失败时保持可重试，授权恢复后补齐状态与 Job");

  await runtime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
