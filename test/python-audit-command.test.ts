import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function main(): Promise<void> {
  const fakeBin = await mkdtemp(path.join(tmpdir(), "sushua-audit-command-"));

  try {
    const uv = path.join(fakeBin, "uv");
    await writeFile(uv, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", "utf8");
    await chmod(uv, 0o755);
    const result = spawnSync("npm", ["run", "document:audit"], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /run\n--frozen\n--project\nservices\/document-worker\npip-audit\n--timeout\n60(?:\n|$)/,
      "Document Service audit must not inherit pip-audit's 15-second network timeout",
    );
    console.log("Python dependency audit command");
    console.log("  ✓ Document Service 显式使用 60 秒网络超时，不依赖终端环境");
  } finally {
    await rm(fakeBin, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
