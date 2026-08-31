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

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_web_test";
  url.password = "integration-only";
  return url.toString();
}

function request(learnerId: string, body: unknown, key?: string) {
  const headers = new Headers({ "content-type": "application/json", "x-test-learner": learnerId });
  if (key) headers.set("idempotency-key", key);
  return new Request("https://sushua.test/api/v1/uploads", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function main() {
  const uploadModule = await import("../src/features/uploads/upload-module").catch(() => null);
  const uploadApi = await import("../src/features/uploads/api").catch(() => null);
  assert.ok(uploadModule && uploadApi, "Upload Module and HTTP handler must exist");

  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await admin.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(admin);
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_web_test') THEN
      CREATE ROLE sushua_web_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END $$`);
  await admin.query("GRANT USAGE ON SCHEMA public TO sushua_web_test");
  await admin.query("GRANT SELECT, INSERT, UPDATE ON documents, document_versions, source_assets, workspace_members TO sushua_web_test");

  const owner = uuidv7();
  const viewer = uuidv7();
  const outsider = uuidv7();
  const workspace = uuidv7();
  const otherWorkspace = uuidv7();
  await admin.query("INSERT INTO learners (id) VALUES ($1),($2),($3)", [owner, viewer, outsider]);
  await admin.query(
    `INSERT INTO workspaces (id,slug,title,visibility,created_by_learner_id) VALUES
       ($1,'upload-owner','上传空间','private',$2),
       ($3,'upload-outsider','其他空间','private',$4)`,
    [workspace, owner, otherWorkspace, outsider],
  );
  await admin.query(
    `INSERT INTO workspace_members (workspace_id,learner_id,role) VALUES
       ($1,$2,'owner'),($1,$3,'viewer'),($4,$5,'owner')`,
    [workspace, owner, viewer, otherWorkspace, outsider],
  );

  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const resourceIds = Array.from({ length: 9 }, () => uuidv7());
  let resourceIndex = 0;
  let uploadIndex = 0;
  const storage = createMemoryStorageAdapter({
    now: () => new Date("2026-09-01T13:00:00.000Z"),
    newId: () => `memory-upload-${String(++uploadIndex).padStart(3, "0")}`,
  });
  const documents = createDocumentModule(runtime, { now: () => new Date("2026-09-01T13:00:00.000Z") });
  const uploads = uploadModule.createUploadModule({
    documents,
    storage,
    newId: () => {
      const id = resourceIds[resourceIndex++];
      if (!id) throw new Error("test_resource_ids_exhausted");
      return id;
    },
  });
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
  const handler = uploadApi.createUploadInitHandler({ enabled: true, identity, uploads });
  const body = {
    workspace_id: workspace,
    filename: "高等数学.pdf",
    size: 11 * 1024 * 1024,
    mime_type: "application/pdf",
    sha256: "a".repeat(64),
    mode: "study_material",
  };

  console.log("上传初始化 API");
  const callsBeforeMissingKey = identityCalls;
  const missingKey = await handler(request(owner, body));
  assert.equal(missingKey.status, 400);
  assert.equal((await missingKey.json()).error.code, "idempotency_key_required");
  assert.equal(identityCalls, callsBeforeMissingKey);
  console.log("  ✓ 缺 Idempotency-Key 在初始化身份和存储前失败");

  const created = await handler(request(owner, body, "upload-math-001"));
  assert.equal(created.status, 201, await created.clone().text());
  const createdBody = await created.json();
  assert.equal(createdBody.data.workspace_id, workspace);
  assert.match(createdBody.data.document_id, /^[0-9a-f-]{36}$/);
  assert.match(createdBody.data.document_version_id, /^[0-9a-f-]{36}$/);
  assert.match(createdBody.data.asset_id, /^[0-9a-f-]{36}$/);
  assert.equal(createdBody.data.upload.parts.length, 3);
  assert.equal(createdBody.data.upload.part_size_bytes, 5 * 1024 * 1024);
  assert.equal(createdBody.data.upload.expires_at, "2026-09-01T13:05:00.000Z");
  assert.equal(createdBody.meta.schema_version, "sushua.api.v1");
  assert.match(created.headers.get("set-cookie") ?? "", /HttpOnly/);
  const persisted = await admin.query<{
    storage_upload_id: string;
    upload_expires_at: Date;
    upload_state: string;
  }>("SELECT storage_upload_id,upload_expires_at,upload_state FROM source_assets");
  assert.deepEqual(persisted.rows.map((row) => ({
    storage_upload_id: row.storage_upload_id,
    upload_expires_at: row.upload_expires_at.toISOString(),
    upload_state: row.upload_state,
  })), [{
    storage_upload_id: createdBody.data.upload.upload_id,
    upload_expires_at: "2026-09-01T13:05:00.000Z",
    upload_state: "initiated",
  }]);
  console.log("  ✓ owner 原子持久上传草稿与 multipart 身份，并返回游客 Cookie");

  const replay = await handler(request(owner, body, "upload-math-001"));
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.data.document_id, createdBody.data.document_id);
  assert.equal(replayBody.data.upload.upload_id, createdBody.data.upload.upload_id);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM documents")).rows[0]?.count, 1);
  console.log("  ✓ 同键同正文重放原 Document 和 upload ID，不重复建档");

  const conflict = await handler(request(owner, { ...body, filename: "另一份.pdf" }, "upload-math-001"));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "idempotency_conflict");
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM documents")).rows[0]?.count, 1);
  console.log("  ✓ 同键不同正文明确冲突");

  const viewerResponse = await handler(request(viewer, { ...body, filename: "viewer.pdf" }, "viewer-upload"));
  assert.equal(viewerResponse.status, 404);
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM documents")).rows[0]?.count, 1);
  await assert.rejects(() => storage.resumeUpload({
    ref: { key: `tenant/${workspace}/${resourceIds[3]}/${resourceIds[4]}/source/${resourceIds[5]}` },
    mimeType: body.mime_type,
    sizeBytes: body.size,
    sha256: body.sha256,
  }, "memory-upload-002"), /storage_upload_not_found/);
  console.log("  ✓ viewer 不能创建上传草稿，RLS 失败回滚数据库并中止候选 multipart");

  const outsiderResponse = await handler(request(outsider, body, "outsider-upload"));
  assert.equal(outsiderResponse.status, 404);
  await assert.rejects(() => storage.resumeUpload({
    ref: { key: `tenant/${workspace}/${resourceIds[6]}/${resourceIds[7]}/source/${resourceIds[8]}` },
    mimeType: body.mime_type,
    sizeBytes: body.size,
    sha256: body.sha256,
  }, "memory-upload-003"), /storage_upload_not_found/);
  console.log("  ✓ 其他租户猜测 Workspace 只获得防枚举 404，候选 multipart 已中止");

  const raceBaseStorage = createMemoryStorageAdapter({
    now: () => new Date("2026-09-01T13:00:00.000Z"),
    newId: (() => {
      let index = 0;
      return () => `race-upload-${String(++index).padStart(3, "0")}`;
    })(),
  });
  const raceIntents = new Map<string, Parameters<typeof raceBaseStorage.createUpload>[0]>();
  let releaseCreate!: () => void;
  const bothCreated = new Promise<void>((resolve) => { releaseCreate = resolve; });
  let createdCandidates = 0;
  const raceStorage = {
    ...raceBaseStorage,
    async createUpload(intent: Parameters<typeof raceBaseStorage.createUpload>[0]) {
      const plan = await raceBaseStorage.createUpload(intent);
      raceIntents.set(plan.uploadId, intent);
      createdCandidates += 1;
      if (createdCandidates === 2) releaseCreate();
      await bothCreated;
      return plan;
    },
  };
  const raceResourceIds = Array.from({ length: 6 }, () => uuidv7());
  let raceResourceIndex = 0;
  const raceUploads = uploadModule.createUploadModule({
    documents,
    storage: raceStorage,
    newId: () => {
      const id = raceResourceIds[raceResourceIndex++];
      if (!id) throw new Error("test_race_resource_ids_exhausted");
      return id;
    },
  });
  const raceHandler = uploadApi.createUploadInitHandler({ enabled: true, identity, uploads: raceUploads });
  const raceBody = { ...body, filename: "并发上传.pdf" };
  const raceResponses = await Promise.all([
    raceHandler(request(owner, raceBody, "upload-race-001")),
    raceHandler(request(owner, raceBody, "upload-race-001")),
  ]);
  assert.deepEqual(raceResponses.map((response) => response.status).sort(), [200, 201]);
  const [raceFirst, raceSecond] = await Promise.all(raceResponses.map((response) => response.json()));
  assert.equal(raceFirst.data.document_id, raceSecond.data.document_id);
  assert.equal(raceFirst.data.upload.upload_id, raceSecond.data.upload.upload_id);
  assert.deepEqual(
    [raceFirst.meta.idempotent_replay, raceSecond.meta.idempotent_replay].sort(),
    [false, true],
  );
  assert.equal((await admin.query("SELECT COUNT(*)::int AS count FROM documents")).rows[0]?.count, 2);
  const winnerUploadId = raceFirst.data.upload.upload_id as string;
  const loserUploadId = ["race-upload-001", "race-upload-002"].find((id) => id !== winnerUploadId);
  assert.ok(loserUploadId);
  const winnerIntent = raceIntents.get(winnerUploadId);
  const loserIntent = raceIntents.get(loserUploadId);
  assert.ok(winnerIntent && loserIntent);
  assert.equal((await raceBaseStorage.resumeUpload(winnerIntent, winnerUploadId)).uploadId, winnerUploadId);
  await assert.rejects(
    () => raceBaseStorage.resumeUpload(loserIntent, loserUploadId),
    /storage_upload_not_found/,
  );
  console.log("  ✓ 同键并发只持久化赢家，输家中止自己的 multipart 并重放赢家计划");

  await runtime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
