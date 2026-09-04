import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { Pool } from "pg";
import { v7 as uuidv7 } from "uuid";

import { applyPostgresMigrations } from "../src/db/postgres/migrate";
import { createPostgresRuntime } from "../src/db/postgres/runtime";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) throw new Error("TEST_DATABASE_URL is required");
const databaseUrl: string = configuredDatabaseUrl;

async function main() {
  const indexerModule = await import("../src/features/documents/document-ir-indexer");
  const admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await reset(admin);
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sushua_ir_worker_test') THEN
      CREATE ROLE sushua_ir_worker_test LOGIN PASSWORD 'integration-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END $$`);
  await admin.query("GRANT USAGE ON SCHEMA public TO sushua_ir_worker_test");
  await admin.query(
    "GRANT EXECUTE ON FUNCTION index_document_ir_v1(uuid,integer,text,jsonb,timestamptz) TO sushua_ir_worker_test",
  );

  console.log("Document IR indexing module");
  const unindexed = await seedParse(admin, "ir-index-required");
  const unindexedResult = resultFor(unindexed, Buffer.from(JSON.stringify(validIr(unindexed))));
  await assert.rejects(
    () => admin.query(
      "SELECT record_document_parse_v1($1,'ready',$2,$3,$4,$5,$6,NULL,$7)",
      [
        unindexed.target.jobId,
        unindexedResult.irObjectKey,
        unindexedResult.irSha256,
        unindexedResult.parser,
        unindexedResult.parserVersion,
        unindexedResult.pageCount,
        new Date(),
      ],
    ),
    /document_ir_index_required/,
  );
  console.log("  ✓ 未经索引的 IR 不能把 DocumentVersion 标为 ready");

  const seed = await seedParse(admin, "ir-index-valid");
  const ir = validIr(seed);
  const bytes = Buffer.from(JSON.stringify(ir), "utf8");
  const result = {
    irObjectKey: `tenant/${seed.workspaceId}/${seed.documentId}/${seed.documentVersionId}/ir/document-ir.json`,
    irSha256: sha256(bytes),
    parser: "docling",
    parserVersion: "2.123.1",
    pageCount: 2,
    irSchemaVersion: "sushua.document-ir.v1" as const,
  };
  const indexer = indexerModule.createDocumentIrIndexingModule(
    createPostgresRuntime({ connectionString: roleUrl(databaseUrl) }),
    { reader: readerFor(bytes) },
  );

  const first = await indexer.index({
    target: seed.target,
    expectedAttempt: 1,
    result,
    signal: new AbortController().signal,
  });
  assert.deepEqual(first, { pageCount: 2, blockCount: 3, replayed: false });
  assert.deepEqual(await indexedRows(admin, seed.documentVersionId), {
    pages: 2,
    blocks: 3,
    indexedSha256: result.irSha256,
  });
  console.log("  ✓ 有效的两页 IR 经 SHA 验证后原子写入 Page/Block 和索引证据");

  const directWorker = new Pool({ connectionString: roleUrl(databaseUrl), max: 1 });
  await assert.rejects(
    () => directWorker.query(
      "INSERT INTO pages(id,workspace_id,document_version_id,page_number,width,height) VALUES($1,$2,$3,9,1,1)",
      [uuidv7(), seed.workspaceId, seed.documentVersionId],
    ),
  );
  await directWorker.end();
  console.log("  ✓ Worker 无表写权限，只能经受限索引函数写入");

  const replay = await indexer.index({
    target: seed.target,
    expectedAttempt: 1,
    result,
    signal: new AbortController().signal,
  });
  assert.deepEqual(replay, { pageCount: 2, blockCount: 3, replayed: true });
  assert.deepEqual(await indexedRows(admin, seed.documentVersionId), {
    pages: 2,
    blocks: 3,
    indexedSha256: result.irSha256,
  });
  console.log("  ✓ 同一经验证 IR 重放不复制不可变 Page/Block");

  const pythonFloatBbox = await seedParse(admin, "ir-index-python-float-bbox");
  const pythonFloatIr = validIr(pythonFloatBbox);
  const pythonFloatBlock = pythonFloatIr.document.pages[0].blocks[0];
  pythonFloatBlock.bbox = [0, 0.05, 0.8, 0.1];
  pythonFloatBlock.sourceHash = sha256(
    Buffer.from(`2.123.1\n${pythonFloatBlock.text}\n0.0,0.05,0.8,0.1\n${"a".repeat(64)}`),
  );
  const pythonFloatBytes = Buffer.from(JSON.stringify(pythonFloatIr), "utf8");
  const pythonFloatResult = await indexWithBytes(indexerModule, pythonFloatBbox, pythonFloatBytes);
  assert.deepEqual(pythonFloatResult, { pageCount: 2, blockCount: 3, replayed: false });
  console.log("  ✓ Python Docling 的零值浮点 bbox source hash 可跨运行时验证");

  const hashMismatch = await seedParse(admin, "ir-index-hash-mismatch");
  await assert.rejects(
    () => indexWithBytes(indexerModule, hashMismatch, Buffer.from(JSON.stringify(validIr(hashMismatch))), {
      irSha256: "f".repeat(64),
    }),
    /document_ir_hash_mismatch/,
  );
  assert.deepEqual(await indexedRows(admin, hashMismatch.documentVersionId), {
    pages: 0,
    blocks: 0,
    indexedSha256: null,
  });

  const foreignIdentity = await seedParse(admin, "ir-index-foreign-identity");
  const foreignIr = validIr(foreignIdentity);
  foreignIr.document.workspaceId = uuidv7();
  await assert.rejects(
    () => indexWithBytes(indexerModule, foreignIdentity, Buffer.from(JSON.stringify(foreignIr))),
    /document_ir_identity_mismatch/,
  );
  assert.deepEqual(await indexedRows(admin, foreignIdentity.documentVersionId), {
    pages: 0,
    blocks: 0,
    indexedSha256: null,
  });

  const malformedBbox = await seedParse(admin, "ir-index-malformed-bbox");
  const malformedIr = validIr(malformedBbox);
  malformedIr.document.pages[0].blocks[0].bbox = [0, 0, 1.1, 1];
  await assert.rejects(
    () => indexWithBytes(indexerModule, malformedBbox, Buffer.from(JSON.stringify(malformedIr))),
    /invalid_document_ir_bbox/,
  );
  assert.deepEqual(await indexedRows(admin, malformedBbox.documentVersionId), {
    pages: 0,
    blocks: 0,
    indexedSha256: null,
  });
  console.log("  ✓ SHA、租户身份和 bbox 任何一项异常均拒绝且不留下部分写入");

  await indexer.close();
  await admin.end();
}

function validIr(seed: ParseSeed) {
  return {
    schemaVersion: "sushua.document-ir.v1",
    document: {
      id: seed.documentId,
      workspaceId: seed.workspaceId,
      documentVersionId: seed.documentVersionId,
      source: {
        assetId: seed.sourceAssetId,
        objectKey: seed.sourceObjectKey,
        sha256: "a".repeat(64),
        sizeBytes: 23,
        mimeType: "application/pdf",
      },
      parseConfig: { mode: "study_material" },
      parser: { name: "docling", version: "2.123.1" },
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          blocks: [
            block("heading-1", "heading", "第一章", 0, 1),
            block("text-1", "text", "第一段资料", 1),
          ],
        },
        {
          pageNumber: 2,
          width: 612,
          height: 792,
          blocks: [block("text-2", "text", "第二页资料", 0)],
        },
      ],
    },
  };
}

function block(
  blockId: string,
  blockType: "heading" | "text",
  text: string,
  readingOrder: number,
  headingLevel?: number,
) {
  const bbox = [0, 0, 1, 1];
  return {
    blockId,
    blockType,
    text,
    markdown: blockType === "heading" ? `# ${text}` : text,
    bbox,
    readingOrder,
    confidence: 0.95,
    ...(headingLevel ? { headingLevel } : {}),
    sourceHash: sha256(Buffer.from(`2.123.1\n${text}\n0,0,1,1\n${"a".repeat(64)}`)),
  };
}

function readerFor(bytes: Uint8Array) {
  return {
    async read() {
      return {
        async *[Symbol.asyncIterator]() {
          yield bytes.subarray(0, Math.ceil(bytes.byteLength / 2));
          yield bytes.subarray(Math.ceil(bytes.byteLength / 2));
        },
      };
    },
  };
}

async function indexWithBytes(
  indexerModule: typeof import("../src/features/documents/document-ir-indexer"),
  seed: ParseSeed,
  bytes: Buffer,
  overrides: Partial<{
    irSha256: string;
    parser: string;
    parserVersion: string;
    pageCount: number;
  }> = {},
) {
  const result = { ...resultFor(seed, bytes), ...overrides };
  const indexer = indexerModule.createDocumentIrIndexingModule(
    createPostgresRuntime({ connectionString: roleUrl(databaseUrl) }),
    { reader: readerFor(bytes) },
  );
  try {
    return await indexer.index({ target: seed.target, expectedAttempt: 1, result, signal: new AbortController().signal });
  } finally {
    await indexer.close();
  }
}

function resultFor(seed: ParseSeed, bytes: Buffer) {
  return {
    irObjectKey: `tenant/${seed.workspaceId}/${seed.documentId}/${seed.documentVersionId}/ir/document-ir.json`,
    irSha256: sha256(bytes),
    parser: "docling",
    parserVersion: "2.123.1",
    pageCount: 2,
    irSchemaVersion: "sushua.document-ir.v1" as const,
  };
}

async function indexedRows(admin: Pool, documentVersionId: string) {
  const result = await admin.query<{
    pages: string;
    blocks: string;
    ir_indexed_sha256: string | null;
  }>(
    `SELECT
       (SELECT count(*)::text FROM pages WHERE document_version_id = $1) AS pages,
       (SELECT count(*)::text FROM blocks WHERE document_version_id = $1) AS blocks,
       ir_indexed_sha256
     FROM document_versions WHERE id = $1`,
    [documentVersionId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("indexed_version_missing");
  return { pages: Number(row.pages), blocks: Number(row.blocks), indexedSha256: row.ir_indexed_sha256 };
}

type ParseSeed = {
  workspaceId: string;
  documentId: string;
  documentVersionId: string;
  sourceAssetId: string;
  sourceObjectKey: string;
  target: {
    jobId: string;
    workspaceId: string;
    documentId: string;
    documentVersionId: string;
    sourceAssetId: string;
    sourceObjectKey: string;
    sourceSha256: string;
    sizeBytes: number;
    mimeType: string;
    parseConfig: Record<string, unknown>;
    irSchemaVersion: "sushua.document-ir.v1";
    parseStatus: "parsing";
  };
};

async function seedParse(admin: Pool, slug: string): Promise<ParseSeed> {
  const learnerId = uuidv7();
  const workspaceId = uuidv7();
  const documentId = uuidv7();
  const documentVersionId = uuidv7();
  const sourceAssetId = uuidv7();
  const jobId = uuidv7();
  const sourceObjectKey = `tenant/${workspaceId}/${documentId}/${documentVersionId}/source/${sourceAssetId}`;
  const now = new Date();
  await admin.query("INSERT INTO learners(id) VALUES($1)", [learnerId]);
  await admin.query(
    "INSERT INTO workspaces(id,slug,title,visibility,created_by_learner_id) VALUES($1,$2,$2,'private',$3)",
    [workspaceId, slug, learnerId],
  );
  await admin.query("INSERT INTO workspace_members(workspace_id,learner_id,role) VALUES($1,$2,'owner')", [workspaceId, learnerId]);
  await admin.query(
    `INSERT INTO documents(id,workspace_id,filename,mime_type,sha256,parse_status,idempotency_key,request_hash,created_at,updated_at)
     VALUES($1,$2,'source.pdf','application/pdf',$3,'parsing',$4,$5,$6,$6)`,
    [documentId, workspaceId, "a".repeat(64), `${slug}-document`, "b".repeat(64), now],
  );
  await admin.query(
    `INSERT INTO jobs(id,resource_id,type,workspace_id,idempotency_key,request_hash,schema_version,trace_id,priority,budget,
      state,progress,attempt,max_attempts,run_after,requested_at,started_at,updated_at)
     VALUES($1,$2,'document.parse',$3,$4,$5,1,$6,0,'{}','running',$7,1,3,$8,$8,$8,$8)`,
    [jobId, documentVersionId, workspaceId, `${slug}-parse`, "c".repeat(64), uuidv7(),
      { phase: "document_parse", percent: 10, updatedAt: now.toISOString() }, now],
  );
  await admin.query(
    `INSERT INTO document_versions(id,workspace_id,document_id,version,source_object_key,content_hash,parse_config,status,parse_job_id,created_at)
     VALUES($1,$2,$3,1,$4,$5,$6,'parsing',$7,$8)`,
    [documentVersionId, workspaceId, documentId, sourceObjectKey, "a".repeat(64), { mode: "study_material" }, jobId, now],
  );
  await admin.query("UPDATE documents SET current_version_id=$1 WHERE id=$2", [documentVersionId, documentId]);
  await admin.query(
    `INSERT INTO source_assets(
       id,workspace_id,document_version_id,kind,object_key,mime_type,size_bytes,sha256,
       scan_status,scan_job_id,scanned_sha256,scanned_at,created_at
     ) VALUES($1,$2,$3,'original',$4,'application/pdf',23,$5,'clean',$6,$5,$7,$7)`,
    [sourceAssetId, workspaceId, documentVersionId, sourceObjectKey, "a".repeat(64), jobId, now],
  );
  return {
    workspaceId,
    documentId,
    documentVersionId,
    sourceAssetId,
    sourceObjectKey,
    target: {
      jobId,
      workspaceId,
      documentId,
      documentVersionId,
      sourceAssetId,
      sourceObjectKey,
      sourceSha256: "a".repeat(64),
      sizeBytes: 23,
      mimeType: "application/pdf",
      parseConfig: { mode: "study_material" },
      irSchemaVersion: "sushua.document-ir.v1",
      parseStatus: "parsing",
    },
  };
}

async function reset(admin: Pool) {
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
  await admin.query("CREATE SCHEMA public");
  await admin.query("GRANT ALL ON SCHEMA public TO CURRENT_USER");
  await applyPostgresMigrations(admin);
}

function roleUrl(source: string) {
  const url = new URL(source);
  url.username = "sushua_ir_worker_test";
  url.password = "integration-only";
  return url.toString();
}

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
