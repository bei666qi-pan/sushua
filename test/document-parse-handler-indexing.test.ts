import assert from "node:assert/strict";
import { v7 as uuidv7 } from "uuid";

import { JobExecutionError } from "../src/features/jobs/bullmq-job-worker";
import { createDocumentParseHandler } from "../src/features/documents/document-parse-handler";

async function main() {
  console.log("Document parse handler indexing gate");
  const target = parseTarget();
  const result = parseResult(target);
  let succeedCalls = 0;
  const handler = createDocumentParseHandler({
    parses: {
      async start() { return target; },
      async succeed() { succeedCalls += 1; return { status: "ready" as const, replayed: false }; },
      async fail() { return { status: "failed" as const, replayed: false }; },
    },
    parser: { async parse() { return result; } },
    indexer: {
      async index() {
        throw new Error("document_ir_hash_mismatch");
      },
    },
  });

  await assert.rejects(
    () => handler({
      job: {
        id: target.jobId,
        type: "document.parse",
        workspaceId: target.workspaceId,
        resourceId: target.documentVersionId,
        attempt: 1,
        maxAttempts: 3,
        state: "running",
        progress: { phase: "document_parse", percent: 0, updatedAt: new Date().toISOString() },
        runAfter: new Date().toISOString(),
      },
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
    }),
    (error: unknown) => error instanceof JobExecutionError
      && error.code === "document_ir_index_failed"
      && !error.retryable,
  );
  assert.equal(succeedCalls, 0, "parse result must never be marked ready before IR indexing succeeds");
  console.log("  ✓ 索引失败阻止 parse.succeed，版本保持非 ready");

  const persistenceFailure = createDocumentParseHandler({
    parses: {
      async start() { return target; },
      async succeed() { throw new Error("database_temporarily_unavailable"); },
      async fail() { return { status: "failed" as const, replayed: false }; },
    },
    parser: { async parse() { return result; } },
    indexer: { async index() { return { pageCount: 1, blockCount: 1, replayed: false }; } },
  });
  await assert.rejects(
    () => persistenceFailure({
      job: jobFor(target),
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
    }),
    (error: unknown) => error instanceof JobExecutionError
      && error.code === "parse_persistence_failed"
      && error.retryable,
  );
  console.log("  ✓ IR 已索引后的瞬态持久化异常仍保留原有重试策略");

  const retryableIndexFailure = createDocumentParseHandler({
    parses: {
      async start() { return target; },
      async succeed() { return { status: "ready" as const, replayed: false }; },
      async fail() { return { status: "failed" as const, replayed: false }; },
    },
    parser: { async parse() { return result; } },
    indexer: {
      async index() {
        const error = Object.assign(new Error("document_ir_storage_unavailable"), {
          code: "document_ir_storage_unavailable",
          retryable: true,
        });
        throw error;
      },
    },
  });
  await assert.rejects(
    () => retryableIndexFailure({
      job: jobFor(target),
      signal: new AbortController().signal,
      reportProgress: async () => undefined,
    }),
    (error: unknown) => error instanceof JobExecutionError
      && error.code === "document_ir_storage_unavailable"
      && error.retryable,
  );
  console.log("  ✓ 明确的临时索引故障保留安全码并进入重试，而非永久失败");
}

function jobFor(target: ReturnType<typeof parseTarget>) {
  return {
    id: target.jobId,
    type: "document.parse" as const,
    workspaceId: target.workspaceId,
    resourceId: target.documentVersionId,
    attempt: 1,
    maxAttempts: 3,
    state: "running" as const,
    progress: { phase: "document_parse", percent: 0, updatedAt: new Date().toISOString() },
    runAfter: new Date().toISOString(),
  };
}

function parseTarget() {
  const workspaceId = uuidv7();
  const documentId = uuidv7();
  const documentVersionId = uuidv7();
  const sourceAssetId = uuidv7();
  return {
    jobId: uuidv7(),
    workspaceId,
    documentId,
    documentVersionId,
    sourceAssetId,
    sourceObjectKey: `tenant/${workspaceId}/${documentId}/${documentVersionId}/source/${sourceAssetId}`,
    sourceSha256: "a".repeat(64),
    sizeBytes: 23,
    mimeType: "application/pdf",
    parseConfig: {},
    irSchemaVersion: "sushua.document-ir.v1" as const,
    parseStatus: "parsing" as const,
  };
}

function parseResult(target: ReturnType<typeof parseTarget>) {
  return {
    irObjectKey: `tenant/${target.workspaceId}/${target.documentId}/${target.documentVersionId}/ir/document-ir.json`,
    irSha256: "b".repeat(64),
    parser: "docling",
    parserVersion: "2.123.1",
    pageCount: 1,
    irSchemaVersion: "sushua.document-ir.v1" as const,
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
