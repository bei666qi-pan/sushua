import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { v7 as uuidv7 } from "uuid";

async function main() {
  const clientModule = await import("../src/features/documents/document-service-client").catch(() => null);
  assert.ok(clientModule, "Document Service HTTP Adapter must exist");

  const token = "document-service-token-32-characters";
  let responder: (request: IncomingMessage, response: ServerResponse, body: string) => void = () => undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    responder(request, response, Buffer.concat(chunks).toString("utf8"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const target = {
    jobId: uuidv7(),
    workspaceId: uuidv7(),
    documentId: uuidv7(),
    documentVersionId: uuidv7(),
    sourceAssetId: uuidv7(),
    sourceObjectKey: "tenant/source/object.pdf",
    sourceSha256: "a".repeat(64),
    sizeBytes: 23,
    mimeType: "application/pdf",
    parseConfig: { mode: "unknown" },
    irSchemaVersion: "sushua.document-ir.v1" as const,
    parseStatus: "parsing" as const,
  };
  const expectedResult = {
    irObjectKey: `tenant/${target.workspaceId}/${target.documentId}/${target.documentVersionId}/ir/document-ir.json`,
    irSha256: "b".repeat(64),
    parser: "docling",
    parserVersion: "2.123.1",
    pageCount: 4,
    irSchemaVersion: "sushua.document-ir.v1" as const,
  };

  try {
    console.log("Document Service HTTP Adapter");
    let captured: { method?: string; url?: string; authorization?: string; body?: unknown } = {};
    responder = (request, response, body) => {
      captured = {
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(body),
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ schemaVersion: 1, result: expectedResult }));
    };
    const client = clientModule.createDocumentServiceClient({ baseUrl, token, timeoutMs: 2_000 });
    assert.deepEqual(await client.parse(target, new AbortController().signal), expectedResult);
    assert.deepEqual(captured, {
      method: "POST",
      url: "/v1/parse",
      authorization: `Bearer ${token}`,
      body: {
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
      },
    });
    console.log("  ✓ 只发送对象引用与解析配置，服务 token 仅进入内网 Authorization");

    responder = (_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ private: "document bytes must not leak" }));
    };
    await assert.rejects(
      () => client.parse(target, new AbortController().signal),
      (error: unknown) => error instanceof clientModule.DocumentServiceError
        && error.code === "document_service_unavailable"
        && error.retryable
        && !error.message.includes("private")
        && !error.message.includes(token),
    );
    console.log("  ✓ 429/5xx 只返回安全可重试错误，不泄露响应正文或 token");

    responder = (_request, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end("rejected private detail");
    };
    await assert.rejects(
      () => client.parse(target, new AbortController().signal),
      (error: unknown) => error instanceof clientModule.DocumentServiceError
        && error.code === "document_request_rejected"
        && !error.retryable
        && !error.message.includes("private"),
    );
    console.log("  ✓ 确定性 4xx 失败不盲目重试");

    responder = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ schemaVersion: 1, result: { ...expectedResult, pageCount: 0 } }));
    };
    await assert.rejects(
      () => client.parse(target, new AbortController().signal),
      (error: unknown) => error instanceof clientModule.DocumentServiceError
        && error.code === "document_service_protocol_error"
        && !error.retryable,
    );
    console.log("  ✓ 非法 schema/结果失败关闭，不将界面服务 HTTP 200 伪装成功");

    let hangingResponse: ServerResponse | undefined;
    responder = (_request, response) => {
      hangingResponse = response;
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
    };
    const cancellation = new AbortController();
    const cancelTimer = setTimeout(() => cancellation.abort(), 50);
    await assert.rejects(
      () => client.parse(target, cancellation.signal),
      (error: unknown) => error instanceof clientModule.DocumentServiceError
        && error.code === "document_parse_cancelled"
        && !error.retryable,
    );
    clearTimeout(cancelTimer);
    hangingResponse?.destroy();
    console.log("  ✓ Job 取消在 headers 后仍能中止卡住的正文读取");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  console.log("\n全部通过 ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
