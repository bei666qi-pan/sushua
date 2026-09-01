import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDocumentServiceClient } from "../src/features/documents/document-service-client";

const DOCUMENT_TOKEN = "document-docling-adapter-token-0001";
const DOCLING_TOKEN = "docling-adapter-service-token-0001";
const IDS = {
  jobId: "019c9e68-62b6-7f58-a10b-7bbd5532e001",
  workspaceId: "019c9e68-62b6-7f58-a10b-7bbd5532e002",
  documentId: "019c9e68-62b6-7f58-a10b-7bbd5532e003",
  documentVersionId: "019c9e68-62b6-7f58-a10b-7bbd5532e004",
  sourceAssetId: "019c9e68-62b6-7f58-a10b-7bbd5532e005",
};

async function main() {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "sushua-docling-adapter-"));
  await chmod(storageRoot, 0o755);
  const sourceObjectKey = (
    `tenant/${IDS.workspaceId}/${IDS.documentId}/${IDS.documentVersionId}/source/${IDS.sourceAssetId}`
  );
  const sourcePath = path.join(storageRoot, ...sourceObjectKey.split("/"));
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await createDocx(sourcePath);
  const source = await readFile(sourcePath);
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const doclingPort = await reservePort();
  const documentPort = await reservePort();
  const doclingUrl = `http://127.0.0.1:${doclingPort}`;
  const documentUrl = `http://127.0.0.1:${documentPort}`;
  const docling = startPythonService({
    project: "services/docling-worker",
    app: "docling_service.app:app",
    port: doclingPort,
    environment: {
      DOCLING_SERVICE_TOKEN: DOCLING_TOKEN,
      STORAGE_DRIVER: "local",
      DOCUMENT_STORAGE_ROOT: storageRoot,
    },
  });
  const document = startPythonService({
    project: "services/document-worker",
    app: "document_worker.app:app",
    port: documentPort,
    environment: {
      DOCUMENT_SERVICE_TOKEN: DOCUMENT_TOKEN,
      STORAGE_DRIVER: "local",
      DOCUMENT_STORAGE_ROOT: storageRoot,
      DOCLING_SERVICE_URL: doclingUrl,
      DOCLING_SERVICE_TOKEN: DOCLING_TOKEN,
      DOCLING_SERVICE_TIMEOUT_SECONDS: "180",
    },
  });
  let doclingOutput = "";
  let documentOutput = "";
  docling.stdout.on("data", (chunk) => { doclingOutput += chunk.toString(); });
  docling.stderr.on("data", (chunk) => { doclingOutput += chunk.toString(); });
  document.stdout.on("data", (chunk) => { documentOutput += chunk.toString(); });
  document.stderr.on("data", (chunk) => { documentOutput += chunk.toString(); });

  try {
    await waitUntilReady(doclingUrl, docling, () => doclingOutput, 120_000);
    await waitUntilReady(documentUrl, document, () => documentOutput, 60_000);
    const result = await createDocumentServiceClient({
      baseUrl: documentUrl,
      token: DOCUMENT_TOKEN,
      timeoutMs: 240_000,
    }).parse({
      ...IDS,
      sourceObjectKey,
      sourceSha256,
      sizeBytes: source.byteLength,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      parseConfig: { mode: "study_material", ocr: false },
      irSchemaVersion: "sushua.document-ir.v1",
      parseStatus: "parsing",
    }, new AbortController().signal);

    assert.equal(result.parser, "docling");
    assert.equal(result.parserVersion, "2.124.0");
    assert.equal(result.pageCount, 1);
    const irBytes = await readFile(path.join(storageRoot, ...result.irObjectKey.split("/")));
    assert.equal(createHash("sha256").update(irBytes).digest("hex"), result.irSha256);
    const ir = JSON.parse(irBytes.toString("utf8")) as {
      document: { pages: Array<{ blocks: Array<Record<string, unknown>> }> };
    };
    assert.deepEqual(ir.document.pages, [{
      pageNumber: 1,
      width: 1,
      height: 1,
      blocks: [
        {
          blockId: "block-1",
          blockType: "heading",
          text: "Cell membrane",
          markdown: "# Cell membrane",
          bbox: [0, 0, 1, 1],
          readingOrder: 0,
          confidence: 0.85,
          headingLevel: 1,
          sourceHash: createHash("sha256")
            .update(`2.124.0\nCell membrane\n0,0,1,1\n${sourceSha256}`)
            .digest("hex"),
        },
        {
          blockId: "block-2",
          blockType: "text",
          text: "The cell membrane controls transport.",
          markdown: "The cell membrane controls transport.",
          bbox: [0, 0, 1, 1],
          readingOrder: 1,
          confidence: 0.85,
          sourceHash: createHash("sha256")
            .update(`2.124.0\nThe cell membrane controls transport.\n0,0,1,1\n${sourceSha256}`)
            .digest("hex"),
        },
      ],
    }]);
    const conversionPath = path.join(
      storageRoot,
      "tenant", IDS.workspaceId, IDS.documentId, IDS.documentVersionId,
      "conversion", "docling.json",
    );
    assert.ok((await readFile(conversionPath)).byteLength > 0);
    console.log("Document Service Docling Adapter HTTP contract");
    console.log("  ✓ DOCX 经对象引用进入 Docling，再确定性转为 Document IR v1");
  } finally {
    document.kill("SIGTERM");
    docling.kill("SIGTERM");
    await Promise.all([waitForExit(document), waitForExit(docling)]);
    await rm(storageRoot, { recursive: true, force: true });
  }
  assert.equal(doclingOutput.includes("Cell membrane"), false);
  assert.equal(documentOutput.includes("Cell membrane"), false);
  assert.equal(doclingOutput.includes(DOCLING_TOKEN), false);
  assert.equal(documentOutput.includes(DOCUMENT_TOKEN), false);
  console.log("  ✓ 两层服务日志均不包含正文或 token");
  await verifyDependencyFailureContracts();
}

async function verifyDependencyFailureContracts() {
  const storageRoot = await mkdtemp(path.join(tmpdir(), "sushua-docling-auth-failure-"));
  const sourceObjectKey = (
    `tenant/${IDS.workspaceId}/${IDS.documentId}/${IDS.documentVersionId}/source/${IDS.sourceAssetId}`
  );
  const sourcePath = path.join(storageRoot, ...sourceObjectKey.split("/"));
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await createDocx(sourcePath);
  const source = await readFile(sourcePath);
  const sourceSha256 = createHash("sha256").update(source).digest("hex");
  const conversionObjectKey = (
    `tenant/${IDS.workspaceId}/${IDS.documentId}/${IDS.documentVersionId}/conversion/docling.json`
  );
  const conversionPath = path.join(storageRoot, ...conversionObjectKey.split("/"));
  const fakeDoclingPort = await reservePort();
  const redirectTargetPort = await reservePort();
  const documentPort = await reservePort();
  type Scenario = "auth" | "unavailable" | "wrong_key" | "bad_sha" | "identity"
    | "malformed" | "oversized" | "partial_status" | "redirect" | "empty"
    | "unsupported_structure";
  let scenario: Scenario = "auth";
  let redirectTargetHits = 0;
  const redirectTarget = createServer((_request, response) => {
    redirectTargetHits += 1;
    sendJson(response, 200, {});
  });
  await new Promise<void>((resolve) => redirectTarget.listen(
    redirectTargetPort,
    "127.0.0.1",
    resolve,
  ));
  const fakeDocling = createServer(async (_request, response) => {
    try {
      if (scenario === "auth") {
        sendJson(response, 401, {
          schemaVersion: 1,
          error: { code: "invalid_service_token", message: "request rejected", retryable: false },
        });
        return;
      }
      if (scenario === "unavailable") {
        sendJson(response, 503, {
          schemaVersion: 1,
          error: { code: "conversion_unavailable", message: "request rejected", retryable: true },
        });
        return;
      }
      if (scenario === "malformed") {
        sendJson(response, 200, {});
        return;
      }
      if (scenario === "oversized") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(" ".repeat(65_537));
        return;
      }
      if (scenario === "redirect") {
        response.writeHead(302, {
          location: `http://127.0.0.1:${redirectTargetPort}/capture`,
        });
        response.end();
        return;
      }
      if (scenario === "wrong_key") {
        sendJson(response, 200, conversionResponse(
          `${conversionObjectKey}.other`,
          "0".repeat(64),
        ));
        return;
      }

      const output = Buffer.from(JSON.stringify({
        schemaVersion: "sushua.docling-output.v1",
        document: {
          id: IDS.documentId,
          workspaceId: scenario === "identity"
            ? "019c9e68-62b6-7f58-a10b-7bbd5532efff"
            : IDS.workspaceId,
          documentVersionId: IDS.documentVersionId,
          source: {
            assetId: IDS.sourceAssetId,
            objectKey: sourceObjectKey,
            sha256: sourceSha256,
            sizeBytes: source.byteLength,
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
          parseConfig: { mode: "study_material", ocr: false },
          parser: { name: "docling", version: "2.124.0" },
          content: scenario === "empty"
            ? { schema_name: "DoclingDocument", texts: [] }
            : scenario === "unsupported_structure"
              ? {
                  schema_name: "DoclingDocument",
                  texts: [{ text: "Visible paragraph", label: "text" }],
                  tables: [{ data: { table_cells: [{ text: "Hidden answer" }] } }],
                }
              : {
                  schema_name: "DoclingDocument",
                  texts: [{ text: "Visible paragraph", label: "text" }],
                },
        },
      }));
      await mkdir(path.dirname(conversionPath), { recursive: true });
      await writeFile(conversionPath, output);
      sendJson(response, scenario === "partial_status" ? 206 : 200, conversionResponse(
        conversionObjectKey,
        scenario === "bad_sha"
          ? "0".repeat(64)
          : createHash("sha256").update(output).digest("hex"),
      ));
    } catch {
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => fakeDocling.listen(fakeDoclingPort, "127.0.0.1", resolve));
  const documentUrl = `http://127.0.0.1:${documentPort}`;
  const document = startPythonService({
    project: "services/document-worker",
    app: "document_worker.app:app",
    port: documentPort,
    environment: {
      DOCUMENT_SERVICE_TOKEN: DOCUMENT_TOKEN,
      STORAGE_DRIVER: "local",
      DOCUMENT_STORAGE_ROOT: storageRoot,
      DOCLING_SERVICE_URL: `http://127.0.0.1:${fakeDoclingPort}`,
      DOCLING_SERVICE_TOKEN: "misconfigured-docling-token-00001",
      HTTP_PROXY: `http://127.0.0.1:${redirectTargetPort}`,
      http_proxy: `http://127.0.0.1:${redirectTargetPort}`,
      NO_PROXY: "",
      no_proxy: "",
    },
  });
  let documentOutput = "";
  document.stdout.on("data", (chunk) => { documentOutput += chunk.toString(); });
  document.stderr.on("data", (chunk) => { documentOutput += chunk.toString(); });

  try {
    await waitUntilReady(documentUrl, document, () => documentOutput, 60_000);
    const cases: Array<{
      scenario: Scenario;
      status: number;
      code: string;
      retryable: boolean;
    }> = [
      { scenario: "auth", status: 502, code: "docling_service_auth_failed", retryable: false },
      { scenario: "unavailable", status: 503, code: "docling_service_unavailable", retryable: true },
      { scenario: "wrong_key", status: 502, code: "docling_protocol_error", retryable: false },
      { scenario: "bad_sha", status: 502, code: "docling_output_integrity_mismatch", retryable: false },
      { scenario: "identity", status: 502, code: "docling_protocol_error", retryable: false },
      { scenario: "malformed", status: 502, code: "docling_protocol_error", retryable: false },
      { scenario: "oversized", status: 502, code: "docling_protocol_error", retryable: false },
      { scenario: "partial_status", status: 502, code: "docling_protocol_error", retryable: false },
      { scenario: "redirect", status: 502, code: "docling_protocol_error", retryable: false },
      { scenario: "empty", status: 422, code: "docling_output_empty", retryable: false },
      {
        scenario: "unsupported_structure",
        status: 422,
        code: "docling_unsupported_structure",
        retryable: false,
      },
    ];
    for (const testCase of cases) {
      scenario = testCase.scenario;
      const response = await parseDocument(documentUrl, {
        sourceObjectKey,
        sourceSha256,
        sourceSize: source.byteLength,
      });
      assert.equal(response.status, testCase.status, testCase.scenario);
      assert.deepEqual(await response.json(), {
        schemaVersion: 1,
        error: {
          code: testCase.code,
          message: "request rejected",
          retryable: testCase.retryable,
        },
      }, testCase.scenario);
    }
    assert.equal(redirectTargetHits, 0, "Docling redirects must not trigger a second request");
    const irPath = path.join(
      storageRoot,
      "tenant", IDS.workspaceId, IDS.documentId, IDS.documentVersionId,
      "ir", "document-ir.json",
    );
    await assert.rejects(access(irPath), { code: "ENOENT" });
    console.log("  ✓ 认证、暂时故障、协议篡改/重定向/代理外带、空输出与未支持结构均显式失败");
  } finally {
    document.kill("SIGTERM");
    await waitForExit(document);
    await new Promise<void>((resolve, reject) => {
      fakeDocling.close((error) => error ? reject(error) : resolve());
    });
    await new Promise<void>((resolve, reject) => {
      redirectTarget.close((error) => error ? reject(error) : resolve());
    });
    await rm(storageRoot, { recursive: true, force: true });
  }
  assert.equal(documentOutput.includes("Cell membrane"), false);
  assert.equal(documentOutput.includes(DOCUMENT_TOKEN), false);
}

function parseDocument(
  documentUrl: string,
  source: { sourceObjectKey: string; sourceSha256: string; sourceSize: number },
) {
  return fetch(`${documentUrl}/v1/parse`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${DOCUMENT_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      schemaVersion: 1,
      jobId: IDS.jobId,
      traceId: IDS.jobId,
      workspaceId: IDS.workspaceId,
      documentId: IDS.documentId,
      documentVersionId: IDS.documentVersionId,
      source: {
        assetId: IDS.sourceAssetId,
        objectKey: source.sourceObjectKey,
        sha256: source.sourceSha256,
        sizeBytes: source.sourceSize,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      parseConfig: { mode: "study_material", ocr: false },
      irSchemaVersion: "sushua.document-ir.v1",
    }),
  });
}

function conversionResponse(objectKey: string, sha256: string) {
  return {
    schemaVersion: 1,
    result: {
      conversionObjectKey: objectKey,
      conversionSha256: sha256,
      parser: "docling",
      parserVersion: "2.124.0",
      outputSchemaVersion: "sushua.docling-output.v1",
    },
  };
}

function sendJson(response: import("node:http").ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function startPythonService(input: {
  project: string;
  app: string;
  port: number;
  environment: Record<string, string>;
}) {
  return spawn("uv", [
    "run", "--frozen", "--project", input.project,
    "uvicorn", input.app, "--app-dir", input.project,
    "--host", "127.0.0.1", "--port", String(input.port), "--no-access-log",
  ], {
    cwd: process.cwd(),
    env: { ...process.env, ...input.environment, PYTHONDONTWRITEBYTECODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitUntilReady(
  baseUrl: string,
  service: ReturnType<typeof startPythonService>,
  output: () => string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (service.exitCode !== null) {
      assert.fail(`service exited before ready (${service.exitCode}): ${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) return;
    } catch {
      // The real service may still be importing its runtime.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`service did not become ready: ${output()}`);
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

async function waitForExit(process: ReturnType<typeof startPythonService>) {
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
