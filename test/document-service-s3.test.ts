import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { CreateBucketCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createDocumentServiceClient } from "../src/features/documents/document-service-client";

const TOKEN = "document-service-s3-contract-token-0001";
const BUCKET = "sushua-document-contract";
const IDS = {
  jobId: "019c9e68-62b6-7f58-a10b-7bbd5532cee1",
  workspaceId: "019c9e68-62b6-7f58-a10b-7bbd5532cee2",
  documentId: "019c9e68-62b6-7f58-a10b-7bbd5532cee3",
  documentVersionId: "019c9e68-62b6-7f58-a10b-7bbd5532cee4",
  sourceAssetId: "019c9e68-62b6-7f58-a10b-7bbd5532cee5",
};
const SOURCE = Buffer.from("S3 合同资料\n主动运输需要载体和能量。\n", "utf8");

async function main() {
  const motoPort = await reservePort();
  const servicePort = await reservePort();
  const endpoint = `http://127.0.0.1:${motoPort}`;
  const moto = spawn("uv", [
    "run", "--frozen", "--project", "services/document-worker", "moto_server",
    "--host", "127.0.0.1", "--port", String(motoPort),
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let motoOutput = "";
  moto.stdout.on("data", (chunk) => { motoOutput += chunk.toString(); });
  moto.stderr.on("data", (chunk) => { motoOutput += chunk.toString(); });
  const s3 = new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "contract-access", secretAccessKey: "contract-secret" },
  });
  const sourceObjectKey = `tenant/${IDS.workspaceId}/${IDS.documentId}/${IDS.documentVersionId}/source/${IDS.sourceAssetId}`;
  let service: ReturnType<typeof startService> | undefined;
  let serviceOutput = "";

  try {
    await waitForHttp(endpoint, moto, () => motoOutput);
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: sourceObjectKey, Body: SOURCE }));

    service = startService({ port: servicePort, endpoint });
    service.stdout.on("data", (chunk) => { serviceOutput += chunk.toString(); });
    service.stderr.on("data", (chunk) => { serviceOutput += chunk.toString(); });
    const baseUrl = `http://127.0.0.1:${servicePort}`;
    await waitForHttp(`${baseUrl}/health/ready`, service, () => serviceOutput);

    console.log("Document Service S3 Adapter contract");
    const sourceSha256 = createHash("sha256").update(SOURCE).digest("hex");
    const result = await createDocumentServiceClient({ baseUrl, token: TOKEN, timeoutMs: 5_000 }).parse({
      ...IDS,
      sourceObjectKey,
      sourceSha256,
      sizeBytes: SOURCE.byteLength,
      mimeType: "text/plain",
      parseConfig: { mode: "study_material" },
      irSchemaVersion: "sushua.document-ir.v1",
      parseStatus: "parsing",
    }, new AbortController().signal);

    const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: result.irObjectKey }));
    assert.ok(object.Body);
    const irBytes = Buffer.from(await object.Body.transformToByteArray());
    assert.equal(createHash("sha256").update(irBytes).digest("hex"), result.irSha256);
    const ir = JSON.parse(irBytes.toString("utf8")) as {
      document: { source: { objectKey: string }; pages: unknown[] };
    };
    assert.equal(ir.document.source.objectKey, sourceObjectKey);
    assert.equal(ir.document.pages.length, 1);
    assert.equal(result.parser, "plain-text");
    console.log("  ✓ boto3 通过真实 SigV4 HTTP 从私有桶读取源对象并写回可校验 IR");
  } finally {
    if (service) {
      service.kill("SIGTERM");
      await waitForExit(service);
    }
    moto.kill("SIGTERM");
    await waitForExit(moto);
    s3.destroy();
  }
  assert.equal(serviceOutput.includes(SOURCE.toString("utf8").trim()), false);
  assert.equal(serviceOutput.includes("contract-secret"), false);
  console.log("  ✓ 服务输出不包含资料正文或 S3 凭证");
}

function startService(input: { port: number; endpoint: string }) {
  return spawn("uv", [
    "run", "--frozen", "--project", "services/document-worker", "uvicorn",
    "document_worker.app:app", "--app-dir", "services/document-worker",
    "--host", "127.0.0.1", "--port", String(input.port), "--no-access-log",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DOCUMENT_SERVICE_TOKEN: TOKEN,
      STORAGE_DRIVER: "s3",
      S3_ENDPOINT: input.endpoint,
      S3_REGION: "us-east-1",
      S3_BUCKET: BUCKET,
      S3_ACCESS_KEY_ID: "contract-access",
      S3_SECRET_ACCESS_KEY: "contract-secret",
      PYTHONDONTWRITEBYTECODE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForHttp(url: string, process: ReturnType<typeof spawn>, output: () => string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      assert.fail(`process exited before ready (${process.exitCode}): ${output()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Process startup is asynchronous.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`process did not become ready: ${output()}`);
}

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function waitForExit(process: ReturnType<typeof spawn>) {
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
