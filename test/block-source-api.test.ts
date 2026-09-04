import assert from "node:assert/strict";

import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";

import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;

type BlockSourceModule = {
  createBlockSourceModule: (runtime: ReturnType<typeof createPostgresRuntime>, storage: {
    stat(ref: { key: string }): Promise<{ ref: { key: string }; sizeBytes: number; sha256: string; mimeType: string }>;
    createReadUrl(ref: { key: string }, ttlSeconds: number): Promise<string>;
  }) => {
    getSource: (actor: { learnerId: string }, blockId: string) => Promise<unknown>;
  };
};

type BlockSourceApi = {
  createDocumentSourceHandlers: (input: {
    enabled: boolean;
    identity: { resolve(request: Request): Promise<{ learnerId: string; kind: "guest"; setCookie: string } | { learnerId: string; userId: string; kind: "user" }> };
    source: ReturnType<BlockSourceModule["createBlockSourceModule"]>;
  }) => { GET_BLOCK_SOURCE: (request: Request, blockId: string) => Promise<Response> };
};

async function main() {
  const sourceModule = await import("../src/features/documents/block-source-module")
    .catch(() => null) as BlockSourceModule | null;
  assert.ok(sourceModule, "Block source Module must exist");
  const sourceApi = await import("../src/features/documents/source-api")
    .catch(() => null) as BlockSourceApi | null;
  assert.ok(sourceApi, "Block source HTTP handler must exist");

  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await admin.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(admin);
  await ensureWebRole(admin);

  const owner = uuidv7();
  const viewer = uuidv7();
  const outsider = uuidv7();
  const deletedOwner = uuidv7();
  const source = await seedSource(admin, "owner", owner, viewer);
  const other = await seedSource(admin, "outsider", outsider);
  const deleted = await seedSource(admin, "deleted", deletedOwner);
  const storage = createStorageDouble(source);
  const runtime = createPostgresRuntime({ connectionString: roleUrl(databaseUrl), maxConnections: 2 });
  const sources = sourceModule.createBlockSourceModule(runtime, storage);
  const handlers = sourceApi.createDocumentSourceHandlers({
    enabled: true,
    source: sources,
    identity: {
      async resolve(incoming) {
        const learnerId = incoming.headers.get("x-test-learner");
        if (!learnerId) throw new Error("missing_test_identity");
        return learnerId === owner
          ? { learnerId, kind: "guest" as const, setCookie: "sushua.guest=signed; HttpOnly; Secure" }
          : { learnerId, userId: uuidv7(), kind: "user" as const };
      },
    },
  });

  console.log("Block 来源定位 HTTP API");
  const authorized = await handlers.GET_BLOCK_SOURCE(request(owner, source.blockId), source.blockId);
  assert.equal(authorized.status, 200, await authorized.clone().text());
  const authorizedBody = await authorized.json();
  assert.deepEqual(authorizedBody.data.block, {
    id: source.blockId,
    block_type: "text",
    bbox: [0.1, 0.2, 0.3, 0.1],
    confidence: 0.95,
    source_hash: "d".repeat(64),
  });
  assert.deepEqual(authorizedBody.data.page, {
    id: source.pageId,
    document_version_id: source.versionId,
    page_number: 1,
    width: 612,
    height: 792,
  });
  assert.deepEqual(authorizedBody.data.document_version, {
    id: source.versionId,
    document_id: source.documentId,
  });
  assert.equal(authorizedBody.data.source_quote.length, 1000);
  assert.equal(authorizedBody.data.source_quote.startsWith("资料内可定位的一段正文"), true);
  assert.equal(authorizedBody.data.source_url, `https://objects.test/read/${encodeURIComponent(source.objectKey)}?ttl=300`);
  assert.equal(authorizedBody.data.source_url_expires_in_seconds, 300);
  assert.match(authorized.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.deepEqual(storage.stats, [source.objectKey]);
  assert.deepEqual(storage.signatures, [{ key: source.objectKey, ttlSeconds: 300 }]);
  console.log("  ✓ 授权成员获得 Block、Page、DocumentVersion、截断引用与固定五分钟原文链接");

  storage.reset();
  storage.setObjectAvailable(false);
  const missingObject = await handlers.GET_BLOCK_SOURCE(request(owner, source.blockId), source.blockId);
  assert.equal(missingObject.status, 503);
  const missingObjectBody = await missingObject.json();
  assert.equal(missingObjectBody.error.code, "source_unavailable");
  assert.equal(JSON.stringify(missingObjectBody).includes(source.objectKey), false);
  assert.equal(JSON.stringify(missingObjectBody).includes("资料内可定位"), false);
  assert.deepEqual(storage.stats, [source.objectKey]);
  assert.deepEqual(storage.signatures, []);
  storage.setObjectAvailable(true);
  console.log("  ✓ 存储对象不存在时在签名前停止，并且只返回安全错误");

  storage.reset();
  const viewerResult = await handlers.GET_BLOCK_SOURCE(request(viewer, source.blockId), source.blockId);
  assert.equal(viewerResult.status, 200);
  assert.deepEqual(storage.signatures, [{ key: source.objectKey, ttlSeconds: 300 }]);
  storage.reset();
  const outsiderResult = await handlers.GET_BLOCK_SOURCE(request(outsider, source.blockId), source.blockId);
  assert.equal(outsiderResult.status, 404);
  assert.equal((await outsiderResult.json()).error.code, "block_not_found");
  assert.deepEqual(storage.stats, []);
  assert.deepEqual(storage.signatures, []);
  const guessedOther = await handlers.GET_BLOCK_SOURCE(request(owner, other.blockId), other.blockId);
  assert.equal(guessedOther.status, 404);
  assert.deepEqual(storage.stats, []);
  assert.deepEqual(storage.signatures, []);
  console.log("  ✓ 跨 Workspace 猜测 Block 返回防枚举 404，且绝不查询或签名对象");

  await admin.query("UPDATE documents SET deleted_at = now() WHERE id = $1", [deleted.documentId]);
  storage.reset();
  const deletedDocument = await handlers.GET_BLOCK_SOURCE(request(deletedOwner, deleted.blockId), deleted.blockId);
  assert.equal(deletedDocument.status, 404);
  assert.equal((await deletedDocument.json()).error.code, "block_not_found");
  assert.deepEqual(storage.stats, []);
  assert.deepEqual(storage.signatures, []);
  console.log("  ✓ 删除资料会立即撤销 Block 原文访问，未触及对象存储");

  await admin.query("DELETE FROM source_assets WHERE document_version_id = $1", [source.versionId]);
  storage.reset();
  const missingAsset = await handlers.GET_BLOCK_SOURCE(request(owner, source.blockId), source.blockId);
  assert.equal(missingAsset.status, 503);
  const missingAssetBody = await missingAsset.json();
  assert.equal(missingAssetBody.error.code, "source_unavailable");
  assert.equal(JSON.stringify(missingAssetBody).includes(source.objectKey), false);
  assert.equal(JSON.stringify(missingAssetBody).includes("资料内可定位"), false);
  assert.deepEqual(storage.stats, []);
  assert.deepEqual(storage.signatures, []);
  console.log("  ✓ 缺少原始对象记录时只返回安全错误，不泄露对象键、签名或资料正文");

  await runtime.close();
  await admin.end();
  console.log("\n全部通过 ✓");
}

function request(learnerId: string, blockId: string) {
  return new Request(`https://sushua.test/api/v1/blocks/${blockId}/source`, { headers: { "x-test-learner": learnerId } });
}

function createStorageDouble(source: { objectKey: string }) {
  const stats: string[] = [];
  const signatures: Array<{ key: string; ttlSeconds: number }> = [];
  let objectAvailable = true;
  return {
    stats,
    signatures,
    reset() {
      stats.length = 0;
      signatures.length = 0;
    },
    setObjectAvailable(value: boolean) {
      objectAvailable = value;
    },
    async stat(ref: { key: string }) {
      stats.push(ref.key);
      if (ref.key !== source.objectKey || !objectAvailable) throw new Error("storage_object_not_found");
      return { ref, sizeBytes: 23, sha256: "a".repeat(64), mimeType: "application/pdf" };
    },
    async createReadUrl(ref: { key: string }, ttlSeconds: number) {
      signatures.push({ key: ref.key, ttlSeconds });
      if (ref.key !== source.objectKey) throw new Error("storage_object_not_found");
      return `https://objects.test/read/${encodeURIComponent(ref.key)}?ttl=${ttlSeconds}`;
    },
  };
}

async function ensureWebRole(admin: Pool) {
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_web_test') THEN
      CREATE ROLE sushua_web_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END $$`);
  await admin.query("GRANT USAGE ON SCHEMA public TO sushua_web_test");
  await admin.query("GRANT SELECT ON documents, document_versions, pages, blocks, source_assets, workspace_members TO sushua_web_test");
}

async function seedSource(admin: Pool, suffix: string, owner: string, viewer?: string) {
  const workspaceId = uuidv7();
  const documentId = uuidv7();
  const versionId = uuidv7();
  const pageId = uuidv7();
  const blockId = uuidv7();
  const assetId = uuidv7();
  const scanJobId = uuidv7();
  const scanTraceId = uuidv7();
  const objectKey = `tenant/${workspaceId}/${documentId}/${versionId}/source/original`;
  const createdAt = new Date("2026-09-04T00:00:00.000Z");
  await admin.query("INSERT INTO learners(id) VALUES($1)", [owner]);
  if (viewer) await admin.query("INSERT INTO learners(id) VALUES($1)", [viewer]);
  await admin.query(
    `INSERT INTO workspaces(id,slug,title,visibility,created_by_learner_id)
     VALUES($1,$2,$2,'private',$3)`,
    [workspaceId, `source-location-${suffix}-${workspaceId.slice(0, 8)}`, owner],
  );
  await admin.query("INSERT INTO workspace_members(workspace_id,learner_id,role) VALUES($1,$2,'owner')", [workspaceId, owner]);
  if (viewer) await admin.query("INSERT INTO workspace_members(workspace_id,learner_id,role) VALUES($1,$2,'viewer')", [workspaceId, viewer]);
  await admin.query(
    `INSERT INTO documents(id,workspace_id,filename,mime_type,sha256,parse_status,idempotency_key,request_hash,created_at,updated_at)
     VALUES($1,$2,$3,'application/pdf',$4,'ready',$5,$6,$7,$7)`,
    [documentId, workspaceId, `${suffix}.pdf`, "a".repeat(64), `source-location-${suffix}`, "b".repeat(64), createdAt],
  );
  await admin.query(
    `INSERT INTO document_versions(
       id,workspace_id,document_id,version,source_object_key,content_hash,status,created_at,
       ir_object_key,ir_sha256,parser,parser_version,page_count,parsed_at,ir_schema_version,ir_indexed_sha256,ir_indexed_at
     ) VALUES($1,$2,$3,1,$4,$5,'ready',$6,$7,$8,'docling','2.123.1',1,$6,'sushua.document-ir.v1',$8,$6)`,
    [versionId, workspaceId, documentId, objectKey, "a".repeat(64), createdAt,
      `tenant/${workspaceId}/${documentId}/${versionId}/ir/document-ir.json`, "c".repeat(64)],
  );
  await admin.query("UPDATE documents SET current_version_id=$1 WHERE id=$2", [versionId, documentId]);
  await admin.query(
    "INSERT INTO pages(id,workspace_id,document_version_id,page_number,width,height) VALUES($1,$2,$3,1,612,792)",
    [pageId, workspaceId, versionId],
  );
  await admin.query(
    `INSERT INTO blocks(id,workspace_id,document_version_id,page_id,block_type,text,bbox,reading_order,confidence,source_hash)
     VALUES($1,$2,$3,$4,'text',$5,'[0.1,0.2,0.3,0.1]'::jsonb,0,0.95,$6)`,
    [blockId, workspaceId, versionId, pageId, `资料内可定位的一段正文${"片".repeat(1100)}`, "d".repeat(64)],
  );
  await admin.query(
    `INSERT INTO jobs(
       id,resource_id,type,workspace_id,learner_id,idempotency_key,request_hash,schema_version,trace_id,priority,budget,
       state,progress,attempt,max_attempts,run_after,requested_at,finished_at,updated_at
     ) VALUES($1,$2,'file.scan',$3,$4,$5,$6,1,$7,0,'{}','succeeded','{}',1,2,$8,$8,$8,$8)`,
    [scanJobId, assetId, workspaceId, owner, `scan-${suffix}`, "e".repeat(64), scanTraceId, createdAt],
  );
  await admin.query(
    `INSERT INTO source_assets(
       id,workspace_id,document_version_id,kind,object_key,mime_type,size_bytes,sha256,scan_status,
       scan_job_id,scanned_sha256,scanned_at,created_at
     ) VALUES($1,$2,$3,'original',$4,'application/pdf',23,$5,'clean',$6,$5,$7,$7)`,
    [assetId, workspaceId, versionId, objectKey, "a".repeat(64), scanJobId, createdAt],
  );
  return { workspaceId, documentId, versionId, pageId, blockId, objectKey };
}

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_web_test";
  url.password = "integration-only";
  return url.toString();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
