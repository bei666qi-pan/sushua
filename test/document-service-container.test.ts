import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDocumentServiceClient } from "../src/features/documents/document-service-client";

const IMAGE = `sushua-document-worker:contract-${process.pid}`;
const TOKEN = "document-container-contract-token-0001";
const IDS = {
  jobId: "019c9e68-62b6-7f58-a10b-7bbd5532cef1",
  workspaceId: "019c9e68-62b6-7f58-a10b-7bbd5532cef2",
  documentId: "019c9e68-62b6-7f58-a10b-7bbd5532cef3",
  documentVersionId: "019c9e68-62b6-7f58-a10b-7bbd5532cef4",
  sourceAssetId: "019c9e68-62b6-7f58-a10b-7bbd5532cef5",
};
const SOURCE = Buffer.from("容器边界合同\n线粒体是有氧呼吸的主要场所。\n", "utf8");

async function main() {
  const build = spawnSync("docker", [
    "build", "--file", "services/document-worker/Dockerfile",
    "--tag", IMAGE, "services/document-worker",
  ], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  assert.equal(build.status, 0, `Document Service image build failed:\n${build.stdout}\n${build.stderr}`);
  const configuredUser = docker("image", "inspect", IMAGE, "--format", "{{.Config.User}}").trim();
  assert.match(configuredUser, /^[1-9][0-9]*:[1-9][0-9]*$/, "image must use a numeric non-root uid:gid");
  const isAlpine = docker(
    "run", "--rm", "--entrypoint", "python", IMAGE,
    "-c", "from pathlib import Path; print(Path('/etc/alpine-release').is_file())",
  ).trim();
  assert.equal(isAlpine, "True", "runtime must use the scanned zero-high Alpine OS baseline");
  const pythonVersion = docker(
    "run", "--rm", "--entrypoint", "python", IMAGE,
    "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
  ).trim();
  assert.equal(pythonVersion, "3.13", "runtime must stay on the Grype-clean Python 3.13 line");

  const storageRoot = await mkdtemp(path.join(tmpdir(), "sushua-document-container-"));
  await chmod(storageRoot, 0o777);
  const sourceObjectKey = `tenant/${IDS.workspaceId}/${IDS.documentId}/${IDS.documentVersionId}/source/${IDS.sourceAssetId}`;
  const sourcePath = path.join(storageRoot, ...sourceObjectKey.split("/"));
  const irDirectory = path.posix.join(
    "/data",
    path.posix.dirname(path.posix.dirname(sourceObjectKey)),
    "ir",
  );
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await chmod(path.join(storageRoot, "tenant"), 0o777);
  await writeFile(sourcePath, SOURCE);
  await chmod(path.dirname(sourcePath), 0o777);
  const documentVersionPath = path.dirname(path.dirname(sourcePath));
  await chmod(documentVersionPath, 0o777);
  assert.notEqual(
    (await stat(documentVersionPath)).mode & 0o002,
    0,
    "bind-mounted DocumentVersion directory must let the numeric container user create IR siblings",
  );
  const containerName = `sushua-document-contract-${randomUUID()}`;
  let containerId = "";

  try {
    containerId = docker(
      "run", "--detach", "--name", containerName,
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=16777216",
      "--mount", `type=bind,src=${storageRoot},dst=/data`,
      "--env", `DOCUMENT_SERVICE_TOKEN=${TOKEN}`,
      "--env", "STORAGE_DRIVER=local",
      "--env", "DOCUMENT_STORAGE_ROOT=/data",
      "--publish", "127.0.0.1::8000",
      IMAGE,
    ).trim();
    assert.match(containerId, /^[0-9a-f]{64}$/);
    const portOutput = docker("port", containerName, "8000/tcp").trim();
    const port = Number(portOutput.slice(portOutput.lastIndexOf(":") + 1));
    assert.ok(Number.isInteger(port) && port > 0);
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitUntilReady(baseUrl, containerName);

    console.log("Document Service container boundary");
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
    grantHostFixtureAccess(containerName, irDirectory);
    const ir = await readFile(path.join(storageRoot, ...result.irObjectKey.split("/")));
    assert.equal(createHash("sha256").update(ir).digest("hex"), result.irSha256);
    const state = JSON.parse(docker("inspect", containerName, "--format", "{{json .State}}")) as {
      Running: boolean;
      OOMKilled: boolean;
    };
    assert.deepEqual({ Running: state.Running, OOMKilled: state.OOMKilled }, {
      Running: true,
      OOMKilled: false,
    });
    console.log("  ✓ 非 root 镜像在只读根、无 capabilities、no-new-privileges 下写回可校验 IR");
  } finally {
    if (containerId) {
      const logs = docker("logs", containerName);
      assert.equal(logs.includes(SOURCE.toString("utf8").trim()), false);
      assert.equal(logs.includes(TOKEN), false);
      grantHostFixtureAccess(containerName, irDirectory);
      spawnSync("docker", ["rm", "--force", containerName], { encoding: "utf8" });
    }
    spawnSync("docker", ["image", "rm", "--force", IMAGE], { encoding: "utf8" });
    await rm(storageRoot, { recursive: true, force: true });
  }
  console.log("  ✓ 容器日志不包含资料正文或服务 token");
}

function docker(...args: string[]) {
  return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
}

function grantHostFixtureAccess(containerName: string, irDirectory: string) {
  docker(
    "exec", "--env", `IR_DIRECTORY=${irDirectory}`, containerName,
    "python", "-c",
    "import os; from pathlib import Path; root = Path(os.environ['IR_DIRECTORY']); "
      + "[item.chmod(0o777) for item in root.rglob('*')] if root.exists() else None; "
      + "root.chmod(0o777) if root.exists() else None",
  );
}

async function waitUntilReady(baseUrl: string, containerName: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      if (response.ok) return;
    } catch {
      // Container startup is asynchronous.
    }
    const running = docker("inspect", containerName, "--format", "{{.State.Running}}").trim();
    if (running !== "true") assert.fail(`container exited before ready:\n${docker("logs", containerName)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`container did not become ready:\n${docker("logs", containerName)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
