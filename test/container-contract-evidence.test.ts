import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as evidence from "./support/container-contract-evidence";

const { reportCleanupFailures, withContainerDiagnostics } = evidence;

async function main(): Promise<void> {
  const primary = Object.assign(new Error("PRIMARY_HTTP_503"), {
    status: 503,
    stderr: "SUSHUA_HTTP_ERROR status=503 code=docling_output_unavailable retryable=true",
  });

  const firstMessages = captureErrors(() =>
    assert.strictEqual(
      withContainerDiagnostics(primary, [], { redact: (value) => value }),
      primary,
      "container diagnostics must preserve the exact primary error object",
    )
  );
  assert.equal(firstMessages.join("\n").includes("PRIMARY_HTTP_503"), false);

  console.log("Container contract failure evidence");
  console.log("  ✓ 补充诊断不替换首个业务错误对象");

  const originalPath = process.env.PATH;
  try {
    process.env.PATH = "/sushua-intentionally-missing-bin";
    const missingMessages = captureErrors(() =>
      assert.doesNotThrow(
        () => withContainerDiagnostics(primary, [{
          role: "Missing container",
          name: "missing-container",
          probePath: "/data/private-object",
        }], { redact: (value) => value }),
        "diagnostic collection must be total when docker cannot spawn",
      )
    );
    assert.match(missingMessages.join("\n"), /error=ENOENT/);
  } finally {
    process.env.PATH = originalPath;
  }

  console.log("  ✓ Docker 诊断命令本身失败时不覆盖首错");

  const fakeBin = await mkdtemp(path.join(tmpdir(), "sushua-container-evidence-"));
  const privateLog = "SYNTHETIC_PRIVATE_DOCUMENT_AND_TOKEN";
  try {
    const fakeDocker = path.join(fakeBin, "docker");
    await writeFile(fakeDocker, [
      "#!/bin/sh",
      "case \"$1\" in",
      "  inspect) printf '%s\\n' 'status=running exit=0 oom=false finished=never' ;;",
      "  logs) printf '%s\\n' \"$SUSHUA_PRIVATE_LOG\" ;;",
      "  exec) printf '%s\\n' 'readable=false mode=0600 uid=10002 gid=10002 size=1024' ;;",
      "esac",
    ].join("\n"), "utf8");
    await chmod(fakeDocker, 0o755);
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    process.env.SUSHUA_PRIVATE_LOG = privateLog;

    const messages = captureErrors(() =>
      withContainerDiagnostics(primary, [{
        role: "Document Service",
        name: "document-service",
        probePath: "/data/private-object",
      }], { redact: (value) => value })
    ).join("\n");

    assert.match(messages, /status=running exit=0 oom=false/);
    assert.match(messages, /readable=false mode=0600 uid=10002 gid=10002 size=1024/);
    assert.match(messages, /container logs omitted/i);
    assert.equal(
      messages.includes(privateLog),
      false,
      "container logs may contain source text or tokens and must not be emitted",
    );
  } finally {
    delete process.env.SUSHUA_PRIVATE_LOG;
    process.env.PATH = originalPath;
    await rm(fakeBin, { recursive: true, force: true });
  }

  console.log("  ✓ 诊断保留容器状态和文件权限，但不输出容器日志正文");

  const originalConsoleError = console.error;
  try {
    console.error = () => {
      throw new Error("synthetic stderr sink failure");
    };
    assert.doesNotThrow(
      () => reportCleanupFailures(
        ["failed to remove synthetic container"],
        primary,
        { redact: (value) => value },
      ),
      "cleanup reporting must not replace an existing primary error",
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.throws(
    () => reportCleanupFailures(
      ["failed to remove synthetic container"],
      undefined,
      { redact: (value) => value },
    ),
    /Container cleanup failures/,
    "a cleanup-only failure must still fail the contract",
  );

  console.log("  ✓ 清理错误只在没有首错时决定最终失败");

  const formatPrimaryFailure = (
    evidence as typeof evidence & { formatPrimaryFailure?: (error: unknown) => string }
  ).formatPrimaryFailure;
  assert.equal(
    typeof formatPrimaryFailure,
    "function",
    "container failures need an allowlisted top-level summary",
  );
  const failureSummary = formatPrimaryFailure(primary);
  assert.match(failureSummary, /http_status=503/);
  assert.match(failureSummary, /error_code=docling_output_unavailable/);
  assert.match(failureSummary, /retryable=true/);
  assert.equal(failureSummary.includes("PRIMARY_HTTP_503"), false);

  console.log("  ✓ 顶层失败只输出结构化状态，不回显任意错误正文");

  const describeCommandFailure = (
    evidence as typeof evidence & {
      describeCommandFailure?: (result: Record<string, unknown>) => string;
    }
  ).describeCommandFailure;
  assert.equal(
    typeof describeCommandFailure,
    "function",
    "cleanup paths need a null-safe, allowlisted command failure formatter",
  );
  const commandSummary = describeCommandFailure({
    status: null,
    signal: null,
    stdout: null,
    stderr: null,
    error: Object.assign(new Error("SYNTHETIC_PRIVATE_COMMAND_BODY"), { code: "ENOBUFS" }),
  });
  assert.equal(commandSummary, "exit=unavailable signal=none error=ENOBUFS");
  assert.equal(commandSummary.includes("SYNTHETIC_PRIVATE_COMMAND_BODY"), false);

  console.log("  ✓ 清理命令结果为空或过大时仍只输出白名单元数据");
}

function captureErrors(action: () => unknown): string[] {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => {
    messages.push(values.map(String).join(" "));
  };
  try {
    action();
  } finally {
    console.error = original;
  }
  return messages;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
