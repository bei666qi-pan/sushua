import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const IMAGE = `sushua-docling-worker:contract-${process.pid}`;
const TOKEN = "docling-container-contract-token-0001";
const IDS = {
  traceId: "019c9e68-62b6-7f58-a10b-7bbd5532df01",
  workspaceId: "019c9e68-62b6-7f58-a10b-7bbd5532df02",
  documentId: "019c9e68-62b6-7f58-a10b-7bbd5532df03",
  documentVersionId: "019c9e68-62b6-7f58-a10b-7bbd5532df04",
  sourceAssetId: "019c9e68-62b6-7f58-a10b-7bbd5532df05",
};

async function main() {
  const fixtures = await mkdtemp(path.join(tmpdir(), "sushua-docling-contract-"));
  await chmod(fixtures, 0o755);
  await createDocx(path.join(fixtures, "source.docx"));
  await createExternalImageOdt(path.join(fixtures, "external-image.odt"));

  const build = spawnSync("docker", [
    "build", "--file", "services/docling-worker/Dockerfile",
    "--tag", IMAGE, ".",
  ], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
  assert.equal(build.status, 0, `Docling image build failed:\n${build.stdout}\n${build.stderr}`);

  try {
    const configuredUser = docker("image", "inspect", IMAGE, "--format", "{{.Config.User}}").trim();
    assert.match(configuredUser, /^[1-9][0-9]*:[1-9][0-9]*$/, "image must use numeric non-root");

    const markdown = runIsolated(fixtures, [
      "from docling.document_converter import DocumentConverter",
      "result = DocumentConverter().convert('/input/source.docx')",
      "print(result.document.export_to_markdown())",
    ].join("; "));
    assert.match(markdown, /Cell membrane/);
    assert.match(markdown, /controls transport/);

    const odtResult = runIsolated(fixtures, [
      "from docling.document_converter import DocumentConverter",
      "p = '/input/external-image.odt'",
      "try:",
      " result = DocumentConverter().convert(p)",
      " print(result.document.export_to_markdown())",
      "except Exception:",
      " print('REJECTED')",
    ].join("\n"));
    assert.doesNotMatch(odtResult, /root:x:/, "external ODF image must not read container files");
    await verifyHttpBoundary(fixtures);
    console.log("Docling isolated image contract");
    console.log("  ✓ 真实 DOCX 在无网络、只读根、非 root 容器中转换");
    console.log("  ✓ 恶意 ODF 外部图像引用未读取容器文件");
    console.log("  ✓ 内部 HTTP 服务只按租户对象引用读取并写回转换结果");
  } finally {
    spawnSync("docker", ["image", "rm", "--force", IMAGE], { encoding: "utf8" });
    await rm(fixtures, { recursive: true, force: true });
  }
}

async function verifyHttpBoundary(fixtures: string) {
  const source = await readFile(path.join(fixtures, "source.docx"));
  const objectKey = `tenant/${IDS.workspaceId}/${IDS.documentId}/${IDS.documentVersionId}/source/${IDS.sourceAssetId}`;
  const sourcePath = path.join(fixtures, ...objectKey.split("/"));
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await copyFile(path.join(fixtures, "source.docx"), sourcePath);
  await chmodTree(fixtures);
  const request = JSON.stringify({
    schemaVersion: 1,
    traceId: IDS.traceId,
    workspaceId: IDS.workspaceId,
    documentId: IDS.documentId,
    documentVersionId: IDS.documentVersionId,
    source: {
      assetId: IDS.sourceAssetId,
      objectKey,
      sha256: createHash("sha256").update(source).digest("hex"),
      sizeBytes: source.byteLength,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    parseConfig: { mode: "study_material", ocr: false },
    outputSchemaVersion: "sushua.docling-output.v1",
  });
  const containerName = `sushua-docling-http-${randomUUID()}`;
  let started = false;
  try {
    docker(
      "run", "--detach", "--name", containerName, "--network", "none",
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=536870912",
      "--mount", `type=bind,src=${fixtures},dst=/data`,
      "--env", `DOCLING_SERVICE_TOKEN=${TOKEN}`,
      "--env", "STORAGE_DRIVER=local", "--env", "DOCUMENT_STORAGE_ROOT=/data",
      IMAGE,
    );
    started = true;
    await waitUntilReady(containerName);
    const responseText = docker(
      "exec", "--env", `REQUEST=${request}`, "--env", `TOKEN=${TOKEN}`,
      containerName, "python", "-c",
      "import json, os, urllib.request; "
        + "payload=os.environ['REQUEST'].encode(); "
        + "request=urllib.request.Request('http://127.0.0.1:8000/v1/convert', data=payload, "
        + "headers={'Content-Type':'application/json','Authorization':'Bearer '+os.environ['TOKEN']}); "
        + "print(urllib.request.urlopen(request, timeout=180).read().decode())",
    );
    const response = JSON.parse(responseText) as {
      result: { conversionObjectKey: string; conversionSha256: string };
    };
    const converted = await readFile(path.join(fixtures, ...response.result.conversionObjectKey.split("/")));
    assert.equal(
      createHash("sha256").update(converted).digest("hex"),
      response.result.conversionSha256,
    );
    const logs = docker("logs", containerName);
    assert.equal(logs.includes("Cell membrane"), false);
    assert.equal(logs.includes(TOKEN), false);
  } finally {
    if (started) spawnSync("docker", ["rm", "--force", containerName], { encoding: "utf8" });
  }
}

async function waitUntilReady(containerName: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = spawnSync("docker", [
      "exec", containerName, "python", "-c",
      "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/ready', timeout=1)",
    ], { encoding: "utf8" });
    if (result.status === 0) return;
    const running = docker("inspect", containerName, "--format", "{{.State.Running}}").trim();
    if (running !== "true") assert.fail(`Docling service exited:\n${docker("logs", containerName)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`Docling service did not become ready:\n${docker("logs", containerName)}`);
}

async function chmodTree(root: string) {
  const result = spawnSync("chmod", ["-R", "a+rwX", root], { encoding: "utf8" });
  assert.equal(result.status, 0, `fixture permission setup failed: ${result.stderr}`);
}

function runIsolated(fixtures: string, script: string) {
  return docker(
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=536870912",
    "--mount", `type=bind,src=${fixtures},dst=/input,readonly`,
    "--env", "HOME=/tmp/home", "--env", "HF_HOME=/tmp/huggingface",
    "--entrypoint", "python", IMAGE, "-c", script,
  );
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

async function createExternalImageOdt(target: string) {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
    <office:document-content
      xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
      xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
      xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
      xmlns:xlink="http://www.w3.org/1999/xlink">
      <office:body><office:text><text:p>External image probe</text:p>
      <draw:frame><draw:image xlink:href="file:///etc/passwd" xlink:type="simple"/></draw:frame>
      </office:text></office:body>
    </office:document-content>`;
  const script = [
    "import os, zipfile",
    "target = os.environ['TARGET']",
    "content = os.environ['CONTENT']",
    "archive = zipfile.ZipFile(target, 'w')",
    "archive.writestr('mimetype', 'application/vnd.oasis.opendocument.text', compress_type=zipfile.ZIP_STORED)",
    "archive.writestr('content.xml', content)",
    "archive.close()",
  ].join("; ");
  const result = spawnSync("python3", ["-c", script], {
    env: { ...process.env, TARGET: target, CONTENT: content }, encoding: "utf8",
  });
  assert.equal(result.status, 0, `ODT fixture creation failed: ${result.stderr}`);
}

function docker(...args: string[]) {
  return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
