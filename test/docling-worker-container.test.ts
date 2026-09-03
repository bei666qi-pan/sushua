import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  describeCommandFailure,
  formatPrimaryFailure,
  reportCleanupFailures as reportContainerCleanupFailures,
  withContainerDiagnostics as attachContainerDiagnostics,
} from "./support/container-contract-evidence";

const IMAGE = `sushua-docling-worker:contract-${process.pid}`;
const DOCUMENT_IMAGE = `sushua-document-worker:docling-contract-${process.pid}`;
const TOKEN = "docling-container-contract-token-0001";
const DOCUMENT_TOKEN = "document-container-docling-token-0001";
const IDS = {
  traceId: "019c9e68-62b6-7f58-a10b-7bbd5532df01",
  workspaceId: "019c9e68-62b6-7f58-a10b-7bbd5532df02",
  documentId: "019c9e68-62b6-7f58-a10b-7bbd5532df03",
  documentVersionId: "019c9e68-62b6-7f58-a10b-7bbd5532df04",
  sourceAssetId: "019c9e68-62b6-7f58-a10b-7bbd5532df05",
  pdfAssetId: "019c9e68-62b6-7f58-a10b-7bbd5532df06",
};

type PdfPage = {
  page_no: number;
  size: { width: number; height: number };
};

type PdfProvenance = {
  page_no: number;
  charspan: [number, number];
  bbox: {
    l: number;
    t: number;
    r: number;
    b: number;
    coord_origin: string;
  };
};

type PdfText = {
  text: string;
  prov: PdfProvenance[];
};

async function main() {
  const fixtures = await mkdtemp(path.join(tmpdir(), "sushua-docling-contract-"));
  await chmod(fixtures, 0o755);
  await createDocx(path.join(fixtures, "source.docx"));
  await createNativePdf(path.join(fixtures, "source.pdf"));
  await createExternalImageOdt(path.join(fixtures, "external-image.odt"));
  let primaryError: unknown;
  try {
    const build = spawnSync("docker", [
      "build", "--file", "services/docling-worker/Dockerfile",
      "--tag", IMAGE, ".",
    ], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
    assert.equal(build.status, 0, `Docling image build failed:\n${build.stdout}\n${build.stderr}`);

    const documentBuild = spawnSync("docker", [
      "build", "--file", "services/document-worker/Dockerfile",
      "--tag", DOCUMENT_IMAGE, ".",
    ], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
    assert.equal(
      documentBuild.status,
      0,
      `Document image build failed:\n${documentBuild.stdout}\n${documentBuild.stderr}`,
    );
    verifySharedLocalStorageBoundary();
    const configuredUser = docker("image", "inspect", IMAGE, "--format", "{{.Config.User}}").trim();
    assert.match(configuredUser, /^[1-9][0-9]*:[1-9][0-9]*$/, "image must use numeric non-root");
    assert.equal(
      runIsolated(
        fixtures,
        "from importlib.metadata import version; print(version('transformers'))",
      ).trim(),
      "5.16.1",
      "Linux Docling image must select the audited Transformers branch from the universal lock",
    );
    const paddleOcrVerified = verifyPaddleOcr();

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
    console.log(
      paddleOcrVerified
        ? "  ✓ PaddleOCR CPU 使用预烘焙模型识别中文 JPEG 与两页扫描 PDF，并保留逐页 bbox/置信度"
        : "  - PaddleOCR CPU 容器识别仅在 Linux x86_64 执行；当前镜像架构已跳过",
    );
    console.log("  ✓ 原生 PDF 使用预烘焙模型在无网络容器中保留两页 provenance");
    console.log("  ✓ Document Service 经内网 Docling 生成可定位的两页 Document IR");
    console.log("  ✓ 两张镜像通过 0600 本地对象完成跨服务交接，未放宽文件权限");
    console.log("  ✓ 真实 HTTP 拒绝只暴露状态、错误码和可重试性");
    console.log("  ✓ 恶意 ODF 外部图像引用未读取容器文件");
    console.log("  ✓ 内部 HTTP 服务只按租户对象引用读取并写回转换结果");
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupFailures: string[] = [];
    for (const image of [IMAGE, DOCUMENT_IMAGE]) {
      const removal = spawnSync("docker", ["image", "rm", "--force", image], {
        encoding: "utf8",
      });
      const removalStderr = childOutput(removal.stderr);
      if (removal.status !== 0 && !removalStderr.includes("No such image")) {
        cleanupFailures.push(
          `failed to remove image ${image}: ${describeCommandFailure(removal)}`,
        );
      }
    }
    try {
      await rm(fixtures, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(
        `failed to remove fixture directory: ${redact(error instanceof Error ? error.message : String(error))}`,
      );
    }
    reportCleanupFailures(cleanupFailures, primaryError);
  }
}

function verifySharedLocalStorageBoundary(): void {
  const volume = `sushua-document-storage-contract-${randomUUID()}`;
  const objectKey = "tenant/workspace/document/version/conversion/docling.json";
  let primaryError: unknown;
  let created = false;
  try {
    docker("volume", "create", volume);
    created = true;
    const owner = docker(
      "image", "inspect", IMAGE, "--format", "{{.Config.User}}",
    ).trim();
    assert.match(owner, /^[1-9][0-9]*:[1-9][0-9]*$/);
    const [ownerUid, ownerGid] = owner.split(":");

    docker(
      "run", "--rm", "--network", "none", "--read-only",
      "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE",
      "--cap-add", "FOWNER",
      "--security-opt", "no-new-privileges:true",
      "--mount", `type=volume,src=${volume},dst=/data`,
      "--env", `OWNER_UID=${ownerUid}`, "--env", `OWNER_GID=${ownerGid}`,
      "--user", "0:0", "--entrypoint", "python", IMAGE, "-c",
      [
        "import os",
        "from pathlib import Path",
        "Path('/data/.initialized').touch()",
        "os.chown('/data', int(os.environ['OWNER_UID']), int(os.environ['OWNER_GID']))",
        "os.chmod('/data', 0o755)",
      ].join("; "),
    );

    const writer = docker(
      "run", "--rm", "--network", "none", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=67108864",
      "--mount", `type=volume,src=${volume},dst=/data`,
      "--env", `OBJECT_KEY=${objectKey}`,
      "--entrypoint", "python", IMAGE, "-c",
      [
        "import os, stat",
        "from pathlib import Path",
        "from sushua_document_service.storage import LocalObjectStorage",
        "key = os.environ['OBJECT_KEY']",
        "storage = LocalObjectStorage(Path('/data'))",
        "storage.write(key, b'shared-storage-contract')",
        "value = (Path('/data') / key).stat()",
        "print(f'{value.st_uid}:{value.st_gid}:{stat.S_IMODE(value.st_mode)}')",
      ].join("; "),
    ).trim();
    const mode = Number.parseInt(writer.split(":")[2] ?? "", 10);
    assert.equal(Number.isInteger(mode), true, `invalid writer stat: ${writer}`);
    assert.equal(mode, 0o600, "shared conversion output must remain owner-only");

    const reader = spawnSync("docker", [
      "run", "--rm", "--network", "none", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=67108864",
      "--mount", `type=volume,src=${volume},dst=/data,readonly`,
      "--env", `OBJECT_KEY=${objectKey}`,
      "--entrypoint", "python", DOCUMENT_IMAGE, "-c",
      [
        "import os",
        "from pathlib import Path",
        "from sushua_document_service.storage import LocalObjectStorage",
        "print(LocalObjectStorage(Path('/data')).read(os.environ['OBJECT_KEY']).decode())",
      ].join("; "),
    ], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
    assert.equal(
      reader.status,
      0,
      `Document Service image cannot read Docling's private local object:\n${reader.stderr}`,
    );
    assert.equal(reader.stdout.trim(), "shared-storage-contract");
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupFailures: string[] = [];
    if (created) {
      const removal = spawnSync("docker", ["volume", "rm", "--force", volume], {
        encoding: "utf8",
      });
      if (removal.status !== 0) {
        cleanupFailures.push(
          `failed to remove contract volume: ${describeCommandFailure(removal)}`,
        );
      }
    }
    reportCleanupFailures(cleanupFailures, primaryError);
  }
}

async function verifyHttpBoundary(fixtures: string) {
  const docxSource = await readFile(path.join(fixtures, "source.docx"));
  const pdfSource = await readFile(path.join(fixtures, "source.pdf"));
  const docxObjectKey = `tenant/${IDS.workspaceId}/${IDS.documentId}/${IDS.documentVersionId}/source/${IDS.sourceAssetId}`;
  const pdfObjectKey = `tenant/${IDS.workspaceId}/${IDS.documentId}/${IDS.documentVersionId}/source/${IDS.pdfAssetId}`;
  const sourcePath = path.join(fixtures, ...docxObjectKey.split("/"));
  const conversionDirectory = path.posix.join(
    "/data",
    path.posix.dirname(path.posix.dirname(docxObjectKey)),
    "conversion",
  );
  const conversionPath = path.posix.join(conversionDirectory, "docling.json");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await copyFile(path.join(fixtures, "source.docx"), sourcePath);
  await copyFile(path.join(fixtures, "source.pdf"), path.join(fixtures, ...pdfObjectKey.split("/")));
  await chmodTree(fixtures);
  const containerName = `sushua-docling-http-${randomUUID()}`;
  let started = false;
  let primaryError: unknown;
  try {
    docker(
      "run", "--detach", "--name", containerName, "--network", "none",
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=536870912",
      "--mount", `type=bind,src=${fixtures},dst=/data`,
      "--env", `DOCLING_SERVICE_TOKEN=${TOKEN}`,
      "--env", "STORAGE_DRIVER=local", "--env", "DOCUMENT_STORAGE_ROOT=/data",
      IMAGE,
      "uvicorn", "docling_service.app:app", "--host", "0.0.0.0", "--port", "8001",
      "--no-access-log",
    );
    started = true;
    await waitUntilReady(containerName, 8001);
    assert.equal(
      docker("inspect", containerName, "--format", "{{.HostConfig.NetworkMode}}").trim(),
      "none",
    );
    assert.equal(
      docker("inspect", containerName, "--format", "{{.HostConfig.ReadonlyRootfs}}").trim(),
      "true",
    );
    assert.notEqual(
      docker("exec", containerName, "python", "-c", "import os; print(os.geteuid())").trim(),
      "0",
      "running service must not have root privileges",
    );
    const docxResponse = convertInContainer(
      containerName,
      8001,
      conversionRequest({
        assetId: IDS.sourceAssetId,
        objectKey: docxObjectKey,
        source: docxSource,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    );
    grantHostFixtureAccess(containerName, conversionDirectory);
    const converted = await readFile(
      path.join(fixtures, ...docxResponse.result.conversionObjectKey.split("/")),
    );
    assert.equal(
      createHash("sha256").update(converted).digest("hex"),
      docxResponse.result.conversionSha256,
    );

    const pdfResponse = convertInContainer(
      containerName,
      8001,
      conversionRequest({
        assetId: IDS.pdfAssetId,
        objectKey: pdfObjectKey,
        source: pdfSource,
        mimeType: "application/pdf",
      }),
    );
    grantHostFixtureAccess(containerName, conversionDirectory);
    const pdfConverted = JSON.parse(
      await readFile(
        path.join(fixtures, ...pdfResponse.result.conversionObjectKey.split("/")),
        "utf8",
      ),
    ) as {
      document: {
        content: {
          pages: Record<string, PdfPage>;
          texts: PdfText[];
        };
      };
    };
    const pdfPages = Object.values(pdfConverted.document.content.pages).sort(
      (left, right) => left.page_no - right.page_no,
    );
    assert.deepEqual(
      pdfPages.map((page) => [page.page_no, page.size.width, page.size.height]),
      [[1, 612, 792], [2, 612, 792]],
    );
    assert.deepEqual(
      pdfConverted.document.content.texts.map((item) => [
        item.text,
        item.prov.map((provenance) => provenance.page_no),
      ]),
      [
        ["Cell membrane", [1]],
        ["The cell membrane controls transport.", [1]],
        ["Mitochondria", [2]],
        ["Mitochondria produce ATP.", [2]],
      ],
    );
    const pagesByNumber = new Map(pdfPages.map((page) => [page.page_no, page]));
    for (const item of pdfConverted.document.content.texts) {
      assert.equal(item.prov.length, 1, "controlled PDF text must have one source region");
      const provenance = item.prov[0];
      assert.deepEqual(provenance.charspan, [0, item.text.length]);
      const page = pagesByNumber.get(provenance.page_no);
      assert.ok(page, `provenance references unknown page ${provenance.page_no}`);
      const { bbox } = provenance;
      assert.equal(bbox.coord_origin, "BOTTOMLEFT");
      assert.ok(
        [bbox.l, bbox.t, bbox.r, bbox.b].every(Number.isFinite),
        "bbox values must be finite",
      );
      assert.ok(bbox.l >= 0 && bbox.l < bbox.r && bbox.r <= page.size.width);
      assert.ok(bbox.b >= 0 && bbox.b < bbox.t && bbox.t <= page.size.height);
    }
    const logs = docker("logs", containerName);
    assert.equal(logs.includes("Cell membrane"), false);
    assert.equal(logs.includes("Mitochondria produce ATP"), false);
    assert.equal(logs.includes(TOKEN), false);
    assert.doesNotMatch(
      logs,
      /\b(?:initiating\s+download|downloading|fetching(?:\s+\d+)?\s+files?|snapshot_download|hf_hub_download)\b|huggingface\.co|modelscope\.cn/i,
      "runtime conversion must not attempt model downloads",
    );
    await verifyDocumentIrBoundary({
      fixtures,
      doclingContainerName: containerName,
      pdfObjectKey,
      pdfSource,
    });
  } catch (error) {
    primaryError = withContainerDiagnostics(error, [
      { role: "Docling Service", name: containerName, probePath: conversionPath },
    ]);
    throw primaryError;
  } finally {
    const cleanupFailures: string[] = [];
    if (started) {
      const state = spawnSync(
        "docker",
        ["inspect", containerName, "--format", "{{.State.Running}}"],
        { encoding: "utf8" },
      );
      if (state.status === 0 && childOutput(state.stdout).trim() === "true") {
        const accessFailure = grantHostFixtureAccess(containerName, conversionDirectory, false);
        if (accessFailure) cleanupFailures.push(accessFailure);
      }
      const removal = spawnSync("docker", ["rm", "--force", containerName], {
        encoding: "utf8",
      });
      if (removal.status !== 0) {
        cleanupFailures.push(
          `failed to remove Docling container: ${describeCommandFailure(removal)}`,
        );
      }
    }
    reportCleanupFailures(cleanupFailures, primaryError);
  }
}

async function verifyDocumentIrBoundary(input: {
  fixtures: string;
  doclingContainerName: string;
  pdfObjectKey: string;
  pdfSource: Buffer;
}) {
  const containerName = `sushua-document-pdf-${randomUUID()}`;
  const irDirectory = path.posix.join(
    "/data",
    path.posix.dirname(path.posix.dirname(input.pdfObjectKey)),
    "ir",
  );
  const conversionPath = path.posix.join(
    "/data",
    path.posix.dirname(path.posix.dirname(input.pdfObjectKey)),
    "conversion",
    "docling.json",
  );
  let started = false;
  let primaryError: unknown;
  try {
    docker(
      "run", "--detach", "--name", containerName,
      "--network", `container:${input.doclingContainerName}`,
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=536870912",
      "--mount", `type=bind,src=${input.fixtures},dst=/data`,
      "--env", `DOCUMENT_SERVICE_TOKEN=${DOCUMENT_TOKEN}`,
      "--env", "STORAGE_DRIVER=local", "--env", "DOCUMENT_STORAGE_ROOT=/data",
      "--env", "DOCLING_SERVICE_URL=http://127.0.0.1:8001",
      "--env", `DOCLING_SERVICE_TOKEN=${TOKEN}`,
      "--env", "DOCLING_SERVICE_TIMEOUT_SECONDS=900",
      "--env", "DOCLING_NATIVE_PDF_ENABLED=true",
      DOCUMENT_IMAGE,
    );
    started = true;
    await waitUntilReady(containerName, 8000);
    assert.equal(
      docker("inspect", containerName, "--format", "{{.HostConfig.ReadonlyRootfs}}").trim(),
      "true",
    );
    assert.match(
      docker("inspect", containerName, "--format", "{{.HostConfig.NetworkMode}}").trim(),
      /^container:/,
    );
    assert.notEqual(
      docker("exec", containerName, "python", "-c", "import os; print(os.geteuid())").trim(),
      "0",
    );

    assert.throws(
      () => parseDocumentInContainer(
        containerName,
        documentParseRequest(input.pdfObjectKey, input.pdfSource),
        "invalid-document-service-token-0001",
      ),
      (error: unknown) => {
        const summary = formatPrimaryFailure(error);
        assert.match(summary, /http_status=401/);
        assert.match(summary, /error_code=invalid_service_token/);
        assert.match(summary, /retryable=false/);
        assert.equal(summary.includes("request rejected"), false);
        assert.equal(summary.includes("invalid-document-service-token-0001"), false);
        return true;
      },
      "the real HTTP rejection must expose only allowlisted failure metadata",
    );

    const response = parseDocumentInContainer(
      containerName,
      documentParseRequest(input.pdfObjectKey, input.pdfSource),
    );
    grantHostFixtureAccess(containerName, irDirectory);
    const irBytes = await readFile(
      path.join(input.fixtures, ...response.result.irObjectKey.split("/")),
    );
    assert.equal(createHash("sha256").update(irBytes).digest("hex"), response.result.irSha256);
    assert.equal(response.result.parser, "docling");
    assert.equal(response.result.parserVersion, "2.124.0");
    assert.equal(response.result.pageCount, 2);

    const ir = JSON.parse(irBytes.toString("utf8")) as {
      schemaVersion: string;
      document: {
        parser: { name: string; version: string };
        pages: Array<{
          pageNumber: number;
          width: number;
          height: number;
          blocks: Array<{
            blockId: string;
            text: string;
            bbox: [number, number, number, number];
            readingOrder: number;
            sourceHash: string;
          }>;
        }>;
      };
    };
    assert.equal(ir.schemaVersion, "sushua.document-ir.v1");
    assert.deepEqual(ir.document.parser, { name: "docling", version: "2.124.0" });
    assert.deepEqual(
      ir.document.pages.map((page) => [page.pageNumber, page.width, page.height]),
      [[1, 612, 792], [2, 612, 792]],
    );
    assert.deepEqual(
      ir.document.pages.flatMap((page) => page.blocks.map((block) => block.text)),
      [
        "Cell membrane",
        "The cell membrane controls transport.",
        "Mitochondria",
        "Mitochondria produce ATP.",
      ],
    );
    const blockIds = ir.document.pages.flatMap((page) =>
      page.blocks.map((block) => block.blockId)
    );
    assert.deepEqual(blockIds, ["block-1", "block-2", "block-3", "block-4"]);
    assert.equal(new Set(blockIds).size, blockIds.length);
    for (const page of ir.document.pages) {
      assert.deepEqual(page.blocks.map((block) => block.readingOrder), [0, 1]);
      for (const block of page.blocks) {
        assert.match(block.sourceHash, /^[0-9a-f]{64}$/);
        const [x, y, width, height] = block.bbox;
        assert.ok([x, y, width, height].every(Number.isFinite));
        assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0);
        assert.ok(x + width <= 1 && y + height <= 1);
      }
    }

    const logs = docker("logs", containerName);
    assert.equal(logs.includes("Cell membrane"), false);
    assert.equal(logs.includes("Mitochondria produce ATP"), false);
    assert.equal(logs.includes(DOCUMENT_TOKEN), false);
    assert.equal(logs.includes(TOKEN), false);
  } catch (error) {
    primaryError = withContainerDiagnostics(error, [
      { role: "Document Service", name: containerName, probePath: conversionPath },
      {
        role: "Docling Service",
        name: input.doclingContainerName,
        probePath: conversionPath,
      },
    ]);
    throw primaryError;
  } finally {
    const cleanupFailures: string[] = [];
    if (started) {
      const state = spawnSync(
        "docker",
        ["inspect", containerName, "--format", "{{.State.Running}}"],
        { encoding: "utf8" },
      );
      if (state.status === 0 && childOutput(state.stdout).trim() === "true") {
        const accessFailure = grantHostFixtureAccess(containerName, irDirectory, false);
        if (accessFailure) cleanupFailures.push(accessFailure);
      }
      const removal = spawnSync("docker", ["rm", "--force", containerName], {
        encoding: "utf8",
      });
      if (removal.status !== 0) {
        cleanupFailures.push(
          `failed to remove Document Service container: ${describeCommandFailure(removal)}`,
        );
      }
    }
    reportCleanupFailures(cleanupFailures, primaryError);
  }
}

function documentParseRequest(objectKey: string, source: Buffer) {
  return JSON.stringify({
    schemaVersion: 1,
    jobId: IDS.traceId,
    traceId: IDS.traceId,
    workspaceId: IDS.workspaceId,
    documentId: IDS.documentId,
    documentVersionId: IDS.documentVersionId,
    source: {
      assetId: IDS.pdfAssetId,
      objectKey,
      sha256: createHash("sha256").update(source).digest("hex"),
      sizeBytes: source.byteLength,
      mimeType: "application/pdf",
    },
    parseConfig: { mode: "study_material", ocr: false },
    irSchemaVersion: "sushua.document-ir.v1",
  });
}

function parseDocumentInContainer(
  containerName: string,
  request: string,
  token = DOCUMENT_TOKEN,
) {
  const responseText = docker(
    "exec", "--env", `REQUEST=${request}`, "--env", `TOKEN=${token}`,
    containerName, "python", "-c",
    [
      "import json, os, re, sys, urllib.error, urllib.request",
      "payload = os.environ['REQUEST'].encode()",
      "request = urllib.request.Request(",
      "    'http://127.0.0.1:8000/v1/parse',",
      "    data=payload,",
      "    headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + os.environ['TOKEN']},",
      ")",
      "try:",
      "    print(urllib.request.urlopen(request, timeout=900).read().decode())",
      "except urllib.error.HTTPError as error:",
      "    code = 'unparseable_response'",
      "    retryable = 'unknown'",
      "    try:",
      "        payload = json.loads(error.read(65_536).decode('utf-8'))",
      "        detail = payload.get('error', {}) if isinstance(payload, dict) else {}",
      "        candidate = detail.get('code') if isinstance(detail, dict) else None",
      "        if isinstance(candidate, str) and re.fullmatch(r'[a-z0-9_.-]{1,64}', candidate):",
      "            code = candidate",
      "        candidate_retryable = detail.get('retryable') if isinstance(detail, dict) else None",
      "        if isinstance(candidate_retryable, bool):",
      "            retryable = str(candidate_retryable).lower()",
      "    except Exception:",
      "        pass",
      "    print(f'SUSHUA_HTTP_ERROR status={error.code} code={code} retryable={retryable}', file=sys.stderr)",
      "    sys.exit(17)",
    ].join("\n"),
  );
  return JSON.parse(responseText) as {
    result: {
      irObjectKey: string;
      irSha256: string;
      parser: string;
      parserVersion: string;
      pageCount: number;
    };
  };
}

function conversionRequest(input: {
  assetId: string;
  objectKey: string;
  source: Buffer;
  mimeType: string;
}) {
  return JSON.stringify({
    schemaVersion: 1,
    traceId: IDS.traceId,
    workspaceId: IDS.workspaceId,
    documentId: IDS.documentId,
    documentVersionId: IDS.documentVersionId,
    source: {
      assetId: input.assetId,
      objectKey: input.objectKey,
      sha256: createHash("sha256").update(input.source).digest("hex"),
      sizeBytes: input.source.byteLength,
      mimeType: input.mimeType,
    },
    parseConfig: { mode: "study_material", ocr: false },
    outputSchemaVersion: "sushua.docling-output.v1",
  });
}

function convertInContainer(containerName: string, port: number, request: string) {
  const responseText = docker(
    "exec", "--env", `REQUEST=${request}`, "--env", `TOKEN=${TOKEN}`,
    "--env", `PORT=${port}`,
    containerName, "python", "-c",
    "import os, urllib.request; "
      + "payload=os.environ['REQUEST'].encode(); "
      + "url='http://127.0.0.1:'+os.environ['PORT']+'/v1/convert'; "
      + "request=urllib.request.Request(url, data=payload, "
      + "headers={'Content-Type':'application/json','Authorization':'Bearer '+os.environ['TOKEN']}); "
      + "print(urllib.request.urlopen(request, timeout=300).read().decode())",
  );
  return JSON.parse(responseText) as {
    result: { conversionObjectKey: string; conversionSha256: string };
  };
}

function grantHostFixtureAccess(
  containerName: string,
  conversionDirectory: string,
  required = true,
): string | undefined {
  const result = spawnSync("docker", [
    "exec", "--env", `CONVERSION_DIRECTORY=${conversionDirectory}`,
    containerName, "python", "-c",
    "import os; from pathlib import Path; root = Path(os.environ['CONVERSION_DIRECTORY']); "
      + "[item.chmod(0o777) for item in root.rglob('*')] if root.exists() else None; "
      + "root.chmod(0o777) if root.exists() else None",
  ], { encoding: "utf8" });
  if (result.status === 0) return undefined;
  const logs = spawnSync("docker", ["logs", "--tail", "200", containerName], {
    encoding: "utf8",
  });
  const logBytes = Buffer.byteLength(
    `${childOutput(logs.stdout)}${childOutput(logs.stderr)}`,
    "utf8",
  );
  const failure = [
    `fixture permission handoff failed: ${describeCommandFailure(result)}`,
    logs.status === 0
      ? `container logs omitted (${logBytes} bytes)`
      : `container logs unavailable: ${describeCommandFailure(logs)}`,
  ].join("; ");
  if (required) assert.fail(failure);
  return failure;
}

async function waitUntilReady(containerName: string, port: number) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = spawnSync("docker", [
      "exec", containerName, "python", "-c",
      `import urllib.request; urllib.request.urlopen('http://127.0.0.1:${port}/health/ready', timeout=1)`,
    ], { encoding: "utf8" });
    if (result.status === 0) return;
    const running = docker("inspect", containerName, "--format", "{{.State.Running}}").trim();
    if (running !== "true") assert.fail(`Docling service exited:\n${docker("logs", containerName)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`Docling service did not become ready:\n${docker("logs", containerName)}`);
}

async function chmodTree(root: string, required = true): Promise<string | undefined> {
  const result = spawnSync("chmod", ["-R", "a+rwX", root], { encoding: "utf8" });
  if (result.status === 0) return undefined;
  const failure = `fixture permission setup failed: ${describeCommandFailure(result)}`;
  if (required) assert.fail(failure);
  return failure;
}

function withContainerDiagnostics(
  error: unknown,
  containers: Array<{ role: string; name: string; probePath?: string }>,
): unknown {
  return attachContainerDiagnostics(error, containers, { redact });
}

function reportCleanupFailures(failures: string[], primaryError: unknown): void {
  reportContainerCleanupFailures(failures, primaryError, { redact });
}

function redact(value: string): string {
  return value
    .replaceAll(TOKEN, "[REDACTED_DOCLING_TOKEN]")
    .replaceAll(DOCUMENT_TOKEN, "[REDACTED_DOCUMENT_TOKEN]")
    .replaceAll("The cell membrane controls transport.", "[REDACTED_FIXTURE_TEXT]")
    .replaceAll("Mitochondria produce ATP.", "[REDACTED_FIXTURE_TEXT]")
    .replaceAll("Cell membrane", "[REDACTED_FIXTURE_TEXT]")
    .replaceAll("Mitochondria", "[REDACTED_FIXTURE_TEXT]");
}

function childOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
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

function verifyPaddleOcr(): boolean {
  const architecture = docker(
    "image", "inspect", IMAGE, "--format", "{{.Architecture}}",
  ).trim();
  if (architecture !== "amd64") return false;
  const probe = path.join(
    process.cwd(),
    "services/docling-worker/tests/container_ocr_probe.py",
  );
  const fixture = path.join(
    process.cwd(),
    "services/docling-worker/tests/fixtures/paddleocr-ch-doc1.jpg.base64",
  );
  const result = spawnSync("docker", [
    "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=268435456",
    "--mount", `type=bind,src=${probe},dst=/probe.py,readonly`,
    "--mount", `type=bind,src=${fixture},dst=/fixture.base64,readonly`,
    "--env", "HOME=/tmp", "--env", "PYTHONPATH=/app",
    "--env", "PADDLE_OCR_ENABLED=true",
    "--env", "PADDLE_OCR_PDF_ENABLED=true",
    "--env", "PADDLE_OCR_ARTIFACTS_PATH=/opt/paddle-models",
    "--env", "PADDLE_PDX_CACHE_HOME=/tmp/paddlex",
    "--env", "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True",
    "--entrypoint", "python", IMAGE, "/probe.py", "/fixture.base64",
  ], { cwd: process.cwd(), encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  assert.equal(
    result.status,
    0,
    `PaddleOCR container probe failed:\n${result.stdout}\n${result.stderr}`,
  );
  assert.match(result.stdout, /"text": "如，和对旅游表演形式"/);
  assert.match(result.stdout, /"pdfText": "如，和对旅游表演形式"/);
  assert.match(result.stdout, /"pdfPages": 2/);
  assert.match(result.stdout, /"cv2Version": "4\.10\.0"/);
  assert.match(result.stdout, /"doclingImport": "DocumentConverter"/);
  return true;
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

async function createNativePdf(target: string) {
  const firstPage = [
    "BT", "/F1 18 Tf", "72 720 Td", "(Cell membrane) Tj",
    "/F1 12 Tf", "0 -32 Td", "(The cell membrane controls transport.) Tj", "ET",
  ].join("\n");
  const secondPage = [
    "BT", "/F1 18 Tf", "72 720 Td", "(Mitochondria) Tj",
    "/F1 12 Tf", "0 -32 Td", "(Mitochondria produce ATP.) Tj", "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
      + "/Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(firstPage)} >>\nstream\n${firstPage}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
      + "/Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    `<< /Length ${Buffer.byteLength(secondPage)} >>\nstream\n${secondPage}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(
    (offset) => `${String(offset).padStart(10, "0")} 00000 n \n`,
  ).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  await writeFile(target, pdf, "ascii");
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
  console.error(formatPrimaryFailure(error));
  process.exitCode = 1;
});
