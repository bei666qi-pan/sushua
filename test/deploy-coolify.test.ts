import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

async function main() {
  const releaseSha = "0123456789abcdef0123456789abcdef01234567";
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "sushua-deploy-"));
  const curlFixture = path.join(fixtureDir, "curl");

  await writeFile(
  curlFixture,
  `#!/usr/bin/env bash
set -euo pipefail
url="\${*: -1}"
case "$url" in
  */applications/app-id/envs)
    if [[ " $* " == *" -X POST "* ]]; then
      : > "$CURL_STATE_FILE"
      exit 0
    fi
    if [[ " $* " == *" -X PATCH "* ]]; then
      [[ -f "$CURL_STATE_FILE" ]] && exit 0
      exit 22
    fi
    if [[ -f "$CURL_STATE_FILE" ]]; then
      printf '[{"key":"APP_VERSION","value":"%s","is_preview":false}]' "$APP_VERSION"
    else
      printf '[]'
    fi
    ;;
  *"/deploy?uuid=app-id&force=true")
    printf '{"deployments":[{"deployment_uuid":"deployment-id"}]}'
    ;;
  */deployments/deployment-id)
    printf '{"status":"finished","commit":"%s"}' "$APP_VERSION"
    ;;
  */applications/app-id)
    printf '{"status":"running:healthy"}'
    ;;
  */api/health)
    printf '{"ok":true,"version":"%s"}' "$APP_VERSION"
    ;;
  https://production.example/)
    exit 0
    ;;
  *)
    echo "unexpected curl URL: $url" >&2
    exit 2
    ;;
esac
`,
  );
  await chmod(curlFixture, 0o700);

  const runDeployment = () => spawnSync("bash", ["scripts/deploy-coolify.sh"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixtureDir}:${process.env.PATH ?? ""}`,
      CURL_STATE_FILE: path.join(fixtureDir, "app-version-created"),
      APP_VERSION: releaseSha,
      COOLIFY_BASE_URL: "https://coolify.example",
      COOLIFY_API_KEY: "test-key",
      COOLIFY_APP_UUID: "app-id",
      PRODUCTION_URL: "https://production.example",
      COOLIFY_POLL_INTERVAL_SECONDS: "0",
      COOLIFY_MAX_DEPLOYMENT_POLLS: "1",
      COOLIFY_MAX_APPLICATION_POLLS: "1",
      PRODUCTION_MAX_HEALTH_POLLS: "1",
    },
  });

  const firstDeployment = runDeployment();
  assert.equal(firstDeployment.status, 0, firstDeployment.stderr || firstDeployment.stdout);
  assert.match(firstDeployment.stdout, new RegExp(`Production is healthy .* ${releaseSha}`));

  const nextDeployment = runDeployment();
  assert.equal(nextDeployment.status, 0, nextDeployment.stderr || nextDeployment.stdout);
  console.log("  ✓ 发布脚本首次创建版本变量，后续更新并验证完整上线闭环");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
