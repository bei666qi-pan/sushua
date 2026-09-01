import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const TOKEN = "docling-service-integration-token-0001";
const IDS = {
  traceId: "019c9e68-62b6-7f58-a10b-7bbd5532de01",
  workspaceId: "019c9e68-62b6-7f58-a10b-7bbd5532de02",
  documentId: "019c9e68-62b6-7f58-a10b-7bbd5532de03",
  documentVersionId: "019c9e68-62b6-7f58-a10b-7bbd5532de04",
  sourceAssetId: "019c9e68-62b6-7f58-a10b-7bbd5532de05",
};

async function main() {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "sushua-docling-service-"));
  await chmod(storageRoot, 0o755);
  const sourceObjectKey = (
    `tenant/${IDS.workspaceId}/${IDS.documentId}/${IDS.documentVersionId}/source/${IDS.sourceAssetId}`
  );
  const sourcePath = path.join(storageRoot, ...sourceObjectKey.split("/"));
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await createDocx(sourcePath);
  const source = await readFile(sourcePath);
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const service = startService({ port, storageRoot });
  let output = "";
  service.stdout.on("data", (chunk) => { output += chunk.toString(); });
  service.stderr.on("data", (chunk) => { output += chunk.toString(); });

  const request = {
    schemaVersion: 1,
    traceId: IDS.traceId,
    workspaceId: IDS.workspaceId,
    documentId: IDS.documentId,
    documentVersionId: IDS.documentVersionId,
    source: {
      assetId: IDS.sourceAssetId,
      objectKey: sourceObjectKey,
      sha256: sourceSha256,
      sizeBytes: source.byteLength,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    parseConfig: { mode: "study_material", ocr: false },
    outputSchemaVersion: "sushua.docling-output.v1",
  };

  try {
    await waitUntilReady(baseUrl, service, () => output);
    console.log("Docling conversion service HTTP contract");
    assert.deepEqual(await getJson(`${baseUrl}/health/live`), {
      schemaVersion: 1,
      status: "live",
    });
    assert.deepEqual(await getJson(`${baseUrl}/health/ready`), {
      schemaVersion: 1,
      status: "ready",
    });

    const response = await post(baseUrl, request, TOKEN);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      schemaVersion: number;
      result: {
        conversionObjectKey: string;
        conversionSha256: string;
        parser: string;
        parserVersion: string;
        outputSchemaVersion: string;
      };
    };
    assert.deepEqual(body, {
      schemaVersion: 1,
      result: {
        conversionObjectKey: `tenant/${IDS.workspaceId}/${IDS.documentId}/${IDS.documentVersionId}/conversion/docling.json`,
        conversionSha256: body.result.conversionSha256,
        parser: "docling",
        parserVersion: "2.124.0",
        outputSchemaVersion: "sushua.docling-output.v1",
      },
    });
    const convertedBytes = await readFile(
      path.join(storageRoot, ...body.result.conversionObjectKey.split("/")),
    );
    assert.equal(createHash("sha256").update(convertedBytes).digest("hex"), body.result.conversionSha256);
    const converted = JSON.parse(convertedBytes.toString("utf8")) as {
      schemaVersion: string;
      document: { source: { objectKey: string }; content: unknown };
    };
    assert.equal(converted.schemaVersion, "sushua.docling-output.v1");
    assert.equal(converted.document.source.objectKey, sourceObjectKey);
    assert.match(JSON.stringify(converted.document.content), /Cell membrane/);
    assert.match(JSON.stringify(converted.document.content), /controls transport/);
    console.log("  ✓ 真实 DOCX 按对象引用转换并写回可校验的版本化结果");

    const unauthorized = await post(baseUrl, request, "wrong-token");
    assert.equal(unauthorized.status, 401);
    assert.equal((await errorCode(unauthorized)), "invalid_service_token");

    const foreignObject = await post(baseUrl, {
      ...request,
      source: { ...request.source, objectKey: "tenant/other-workspace/source/document.docx" },
    }, TOKEN);
    assert.equal(foreignObject.status, 422);
    assert.equal((await errorCode(foreignObject)), "invalid_object_key");

    const integrityMismatch = await post(baseUrl, {
      ...request,
      source: { ...request.source, sha256: "f".repeat(64) },
    }, TOKEN);
    assert.equal(integrityMismatch.status, 409);
    assert.equal((await errorCode(integrityMismatch)), "source_integrity_mismatch");

    const unsupported = await post(baseUrl, {
      ...request,
      source: { ...request.source, mimeType: "text/html" },
    }, TOKEN);
    assert.equal(unsupported.status, 415);
    assert.equal((await errorCode(unsupported)), "unsupported_media_type");

    const arbitraryLocation = await post(baseUrl, {
      ...request,
      sourceUrl: "https://example.invalid/private.docx",
      sourcePath: "/etc/passwd",
    }, TOKEN);
    assert.equal(arbitraryLocation.status, 422);
    assert.equal((await errorCode(arbitraryLocation)), "invalid_request");
    console.log("  ✓ token、租户键、完整性、MIME 与严格 Schema 均失败关闭");
  } finally {
    service.kill("SIGTERM");
    await waitForExit(service);
    await rm(storageRoot, { recursive: true, force: true });
  }
  assert.equal(output.includes("Cell membrane"), false, "logs must not contain source content");
  assert.equal(output.includes(TOKEN), false, "logs must not contain service token");
  console.log("  ✓ 服务日志不包含资料正文或服务 token");
}

function startService(input: { port: number; storageRoot: string }) {
  return spawn("uv", [
    "run", "--frozen", "--project", "services/docling-worker",
    "uvicorn", "docling_service.app:app", "--app-dir", "services/docling-worker",
    "--host", "127.0.0.1", "--port", String(input.port), "--no-access-log",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DOCLING_SERVICE_TOKEN: TOKEN,
      STORAGE_DRIVER: "local",
      DOCUMENT_STORAGE_ROOT: input.storageRoot,
      PYTHONDONTWRITEBYTECODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function post(baseUrl: string, body: unknown, token: string) {
  return fetch(`${baseUrl}/v1/convert`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function errorCode(response: Response) {
  const body = await response.json() as { error: { code: string } };
  return body.error.code;
}

async function getJson(url: string) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
}

async function waitUntilReady(
  baseUrl: string,
  service: ReturnType<typeof startService>,
  output: () => string,
) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (service.exitCode !== null) {
      assert.fail(`Docling service exited before ready (${service.exitCode}): ${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) return;
    } catch {
      // The real service may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Docling service did not become ready: ${output()}`);
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

async function createDocx(target: string) {
  const script = [
    "from docx import Document",
    "import os",
    "document = Document()",
    "document.add_heading('Cell membrane', level=1)",
    "document.add_paragraph('The cell membrane controls transport.')",
    "document.save(os.environ['TARGET'])",
  ].join("; ");
  const result = spawnSync("uv", [
    "run", "--frozen", "--project", "services/document-worker", "python", "-c", script,
  ], { cwd: process.cwd(), env: { ...process.env, TARGET: target }, encoding: "utf8" });
  assert.equal(result.status, 0, `DOCX fixture creation failed: ${result.stderr}`);
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
