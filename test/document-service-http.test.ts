import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createDocumentServiceClient } from "../src/features/documents/document-service-client";

const TOKEN = "document-service-integration-token-0001";
const IDS = {
  jobId: "019c9e68-62b6-7f58-a10b-7bbd5532cdd1",
  workspaceId: "019c9e68-62b6-7f58-a10b-7bbd5532cdd2",
  documentId: "019c9e68-62b6-7f58-a10b-7bbd5532cdd3",
  documentVersionId: "019c9e68-62b6-7f58-a10b-7bbd5532cdd4",
  sourceAssetId: "019c9e68-62b6-7f58-a10b-7bbd5532cdd5",
};
const SOURCE_TEXT = "第一章 细胞结构\n细胞膜控制物质进出细胞。\n";

async function main() {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "sushua-document-service-"));
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const sourceObjectKey = (
    `tenant/${IDS.workspaceId}/${IDS.documentId}/${IDS.documentVersionId}/source/${IDS.sourceAssetId}`
  );
  const sourcePath = path.join(storageRoot, ...sourceObjectKey.split("/"));
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, SOURCE_TEXT, "utf8");
  const sourceBytes = Buffer.from(SOURCE_TEXT, "utf8");
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const service = startService({ port, storageRoot });
  let output = "";
  service.stdout.on("data", (chunk) => { output += chunk.toString(); });
  service.stderr.on("data", (chunk) => { output += chunk.toString(); });

  try {
    await waitUntilReady(baseUrl, service, () => output);
    console.log("FastAPI Document Service HTTP contract");

    assert.deepEqual(await getJson(`${baseUrl}/health/live`), {
      schemaVersion: 1,
      status: "live",
    });
    assert.deepEqual(await getJson(`${baseUrl}/health/ready`), {
      schemaVersion: 1,
      status: "ready",
    });
    console.log("  ✓ live 与 ready 使用稳定、最小且不泄露内部配置的响应");

    const target = {
      ...IDS,
      sourceObjectKey,
      sourceSha256,
      sizeBytes: sourceBytes.byteLength,
      mimeType: "text/plain",
      parseConfig: { mode: "study_material" },
      irSchemaVersion: "sushua.document-ir.v1" as const,
      parseStatus: "parsing" as const,
    };
    const client = createDocumentServiceClient({ baseUrl, token: TOKEN, timeoutMs: 5_000 });
    const result = await client.parse(target, new AbortController().signal);
    assert.deepEqual(result, {
      irObjectKey: `tenant/${IDS.workspaceId}/${IDS.documentId}/${IDS.documentVersionId}/ir/document-ir.json`,
      irSha256: result.irSha256,
      parser: "plain-text",
      parserVersion: "1.0.0",
      pageCount: 1,
      irSchemaVersion: "sushua.document-ir.v1",
    });

    const irBytes = await readFile(path.join(storageRoot, ...result.irObjectKey.split("/")));
    assert.equal(createHash("sha256").update(irBytes).digest("hex"), result.irSha256);
    assert.deepEqual(JSON.parse(irBytes.toString("utf8")), {
      schemaVersion: "sushua.document-ir.v1",
      document: {
        id: IDS.documentId,
        workspaceId: IDS.workspaceId,
        documentVersionId: IDS.documentVersionId,
        source: {
          assetId: IDS.sourceAssetId,
          objectKey: sourceObjectKey,
          sha256: sourceSha256,
          sizeBytes: sourceBytes.byteLength,
          mimeType: "text/plain",
        },
        parseConfig: { mode: "study_material" },
        parser: { name: "plain-text", version: "1.0.0" },
        pages: [{
          pageNumber: 1,
          width: 1,
          height: 1,
          blocks: [{
            blockId: "block-1",
            blockType: "text",
            text: SOURCE_TEXT.trimEnd(),
            markdown: SOURCE_TEXT.trimEnd(),
            bbox: [0, 0, 1, 1],
            readingOrder: 0,
            confidence: 1,
            sourceHash: createHash("sha256")
              .update(`1.0.0\n${SOURCE_TEXT.trimEnd()}\n0,0,1,1\n${sourceSha256}`)
              .digest("hex"),
          }],
        }],
      },
    });
    console.log("  ✓ 真实服务读取租户对象、验证 hash/长度并写回可校验的 Document IR v1");

    const unauthorized = await fetch(`${baseUrl}/v1/parse`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
      body: JSON.stringify(requestBody(target)),
    });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), {
      error: { code: "invalid_service_token", message: "request rejected", retryable: false },
      schemaVersion: 1,
    });
    console.log("  ✓ 无效服务 token 失败关闭且不回显 token");

    const extraField = await fetch(`${baseUrl}/v1/parse`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ...requestBody(target), unexpected: true }),
    });
    assert.equal(extraField.status, 422);
    assert.equal((await extraField.json() as { error: { code: string } }).error.code, "invalid_request");

    const foreignObject = await fetch(`${baseUrl}/v1/parse`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        ...requestBody(target),
        source: { ...requestBody(target).source, objectKey: "tenant/other-workspace/source/notes.txt" },
      }),
    });
    assert.equal(foreignObject.status, 422);
    assert.equal((await foreignObject.json() as { error: { code: string } }).error.code, "invalid_object_key");
    console.log("  ✓ 严格 Schema 与对象键租户前缀拒绝多余字段和跨租户路径");

    const integrityMismatch = await fetch(`${baseUrl}/v1/parse`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        ...requestBody(target),
        source: { ...requestBody(target).source, sha256: "f".repeat(64) },
      }),
    });
    assert.equal(integrityMismatch.status, 409);
    assert.equal(
      (await integrityMismatch.json() as { error: { code: string } }).error.code,
      "source_integrity_mismatch",
    );
    console.log("  ✓ 声明 SHA 与实际对象不一致时拒绝解析和伪造 IR 成功");
  } finally {
    service.kill("SIGTERM");
    await waitForExit(service);
    await rm(storageRoot, { recursive: true, force: true });
  }
  assert.equal(output.includes(SOURCE_TEXT.trim()), false, "service logs must not contain document text");
  assert.equal(output.includes(TOKEN), false, "service logs must not contain service tokens");
  console.log("  ✓ 服务日志不包含资料正文或服务 token");
}

function requestBody(target: {
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
  irSchemaVersion: string;
}) {
  return {
    schemaVersion: 1,
    jobId: target.jobId,
    traceId: target.jobId,
    workspaceId: target.workspaceId,
    documentId: target.documentId,
    documentVersionId: target.documentVersionId,
    source: {
      assetId: target.sourceAssetId,
      objectKey: target.sourceObjectKey,
      sha256: target.sourceSha256,
      sizeBytes: target.sizeBytes,
      mimeType: target.mimeType,
    },
    parseConfig: target.parseConfig,
    irSchemaVersion: target.irSchemaVersion,
  };
}

function startService(input: { port: number; storageRoot: string }) {
  return spawn(
    "uv",
    [
      "run",
      "--frozen",
      "--project",
      "services/document-worker",
      "uvicorn",
      "document_worker.app:app",
      "--app-dir",
      "services/document-worker",
      "--host",
      "127.0.0.1",
      "--port",
      String(input.port),
      "--no-access-log",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DOCUMENT_SERVICE_TOKEN: TOKEN,
        DOCUMENT_STORAGE_ROOT: input.storageRoot,
        PYTHONDONTWRITEBYTECODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function waitUntilReady(
  baseUrl: string,
  service: ReturnType<typeof startService>,
  output: () => string,
) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (service.exitCode !== null) {
      assert.fail(`Document Service exited before ready (${service.exitCode}): ${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) return;
    } catch {
      // The real process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Document Service did not become ready: ${output()}`);
}

async function getJson(url: string) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
}

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForExit(process: ReturnType<typeof startService>) {
  if (process.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => process.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (process.exitCode === null) process.kill("SIGKILL");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
