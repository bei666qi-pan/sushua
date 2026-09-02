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
const abortSignature = "abort_source_upload_v1(uuid,uuid,timestamp with time zone)";

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_web_test";
  url.password = "integration-only";
  return url.toString();
}

function request(learnerId: string, url: string, key?: string) {
  const headers = new Headers({ "x-test-learner": learnerId });
  if (key) headers.set("idempotency-key", key);
  return new Request(url, { method: "DELETE", headers });
}

async function main() {
  const uploadModule = await import("../src/features/uploads/upload-module");
  const uploadApi = await import("../src/features/uploads/api");
  assert.equal(typeof uploadApi.createUploadCancelHandler, "function");

  const admin = new Pool({ connectionString: databaseUrl, max: 3 });
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await admin.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(admin);
  assert.equal((await admin.query("SELECT to_regprocedure($1)::text AS name", [abortSignature])).rows[0]?.name, abortSignature);
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_web_test') THEN
      CREATE ROLE sushua_web_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END $$`);
  await admin.query("GRANT USAGE ON SCHEMA public TO sushua_web_test");
  await admin.query("GRANT SELECT, INSERT, UPDATE ON documents, document_versions, source_assets, workspace_members TO sushua_web_test");
  assert.equal((await admin.query(
    "SELECT has_function_privilege('sushua_web_test',$1,'EXECUTE') AS allowed",
    [abortSignature],
  )).rows[0]?.allowed, false);
  await admin.query(`GRANT EXECUTE ON FUNCTION ${abortSignature} TO sushua_web_test`);

  const owner = uuidv7();
  const viewer = uuidv7();
  const outsider = uuidv7();
  const workspace = uuidv7();
  await admin.query("INSERT INTO learners (id) VALUES ($1),($2),($3)", [owner, viewer, outsider]);
  await admin.query(
    "INSERT INTO workspaces (id,slug,title,visibility,created_by_learner_id) VALUES ($1,'cancel-upload','Cancel Upload','private',$2)",
    [workspace, owner],
  );
  await admin.query(
    "INSERT INTO workspace_members (workspace_id,learner_id,role) VALUES ($1,$2,'owner'),($1,$3,'viewer')",
    [workspace, owner, viewer],
  );

  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 3 });
  let uploadIndex = 0;
  const storage = createMemoryStorageAdapter({ newId: () => `cancel-upload-${++uploadIndex}` });
  const documents = createDocumentModule(runtime, { now: () => new Date("2026-09-02T16:00:00.000Z") });
  const uploads = uploadModule.createUploadModule({ documents, storage, newId: uuidv7 });
  assert.equal(typeof uploads.cancel, "function");
  let identityCalls = 0;
  const identity = {
    async resolve(incoming: Request) {
      identityCalls += 1;
      const learnerId = incoming.headers.get("x-test-learner");
      if (!learnerId) throw new Error("missing_test_identity");
      return learnerId === owner
        ? { learnerId, kind: "guest" as const, setCookie: "sushua.guest=signed; HttpOnly; Secure" }
        : { learnerId, userId: uuidv7(), kind: "user" as const };
    },
  };
  const init = uploadApi.createUploadInitHandler({ enabled: true, identity, uploads });
  const cancel = uploadApi.createUploadCancelHandler({ enabled: true, identity, uploads });
  const initResponse = await init(new Request("https://sushua.test/api/v1/uploads", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "cancel-init-001", "x-test-learner": owner },
    body: JSON.stringify({
      workspace_id: workspace,
      filename: "cancel-me.pdf",
      size: 1024,
      mime_type: "application/pdf",
      sha256: "a".repeat(64),
    }),
  }));
  assert.equal(initResponse.status, 201, await initResponse.clone().text());
  const initialized = await initResponse.json();
  const assetId = initialized.data.asset_id as string;
  const uploadId = initialized.data.upload.upload_id as string;
  const cancelUrl = `https://sushua.test/api/v1/uploads/${assetId}`;

  console.log("上传取消 API");
  const beforeMissingKey = identityCalls;
  const missingKey = await cancel(request(owner, cancelUrl), assetId);
  assert.equal(missingKey.status, 400);
  assert.equal((await missingKey.json()).error.code, "idempotency_key_required");
  assert.equal(identityCalls, beforeMissingKey);
  console.log("  ✓ 缺 Idempotency-Key 在身份和存储访问前失败");

  const cancelled = await cancel(request(owner, cancelUrl, "cancel-001"), assetId);
  assert.equal(cancelled.status, 200, await cancelled.clone().text());
  const cancelledBody = await cancelled.json();
  assert.equal(cancelledBody.data.asset_id, assetId);
  assert.equal(cancelledBody.data.state, "aborted");
  assert.equal(cancelledBody.meta.idempotent_replay, false);
  assert.match(cancelled.headers.get("set-cookie") ?? "", /HttpOnly/);
  const persisted = (await admin.query(`SELECT sa.upload_state,d.deleted_at,d.parse_status,dv.status,dv.error_code
    FROM source_assets sa JOIN document_versions dv ON dv.id=sa.document_version_id
    JOIN documents d ON d.id=dv.document_id WHERE sa.id=$1`, [assetId])).rows[0];
  assert.equal(persisted.upload_state, "aborted");
  assert.equal(persisted.parse_status, "failed");
  assert.equal(persisted.status, "failed");
  assert.equal(persisted.error_code, "upload_cancelled");
  assert.equal(persisted.deleted_at.toISOString(), "2026-09-02T16:00:00.000Z");
  await assert.rejects(() => storage.resumeUpload({
    ref: { key: `tenant/${workspace}/${initialized.data.document_id}/${initialized.data.document_version_id}/source/${assetId}` },
    mimeType: "application/pdf", sizeBytes: 1024, sha256: "a".repeat(64),
  }, uploadId), /storage_upload_not_found/);
  console.log("  ✓ owner 取消后原子撤销访问并中止 multipart");

  const replay = await cancel(request(owner, cancelUrl, "cancel-001"), assetId);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).meta.idempotent_replay, true);
  console.log("  ✓ 取消请求可幂等重放，已清理的 multipart 不伪造失败");

  const secondInit = await init(new Request("https://sushua.test/api/v1/uploads", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "cancel-init-002", "x-test-learner": owner },
    body: JSON.stringify({ workspace_id: workspace, filename: "keep.pdf", size: 1024, mime_type: "application/pdf", sha256: "b".repeat(64) }),
  }));
  const second = await secondInit.json();
  const secondAsset = second.data.asset_id as string;
  const secondUrl = `https://sushua.test/api/v1/uploads/${secondAsset}`;
  assert.equal((await cancel(request(viewer, secondUrl, "viewer-cancel"), secondAsset)).status, 404);
  assert.equal((await cancel(request(outsider, secondUrl, "outsider-cancel"), secondAsset)).status, 404);
  assert.equal((await admin.query("SELECT upload_state FROM source_assets WHERE id=$1", [secondAsset])).rows[0]?.upload_state, "initiated");
  console.log("  ✓ viewer 与外部租户都不能取消，且不暴露资源存在性");

  await runtime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
