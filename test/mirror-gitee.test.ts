import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function main() {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "sushua-gitee-mirror-"));
  const gitFixture = path.join(fixtureDir, "git");
  const curlFixture = path.join(fixtureDir, "curl");
  const attemptFile = path.join(fixtureDir, "attempts");
  const releaseSha = "0123456789abcdef0123456789abcdef01234567";
  const secret = "integration-secret-must-not-leak";

  await writeFile(gitFixture, `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  push)
    if [[ -z "\${GIT_ASKPASS:-}" || -z "\${GITEE_USER:-}" || -z "\${GITEE_TOKEN:-}" ]]; then
      echo 'push credentials missing' >&2
      exit 90
    fi
    [[ "\${*: -1}" == "HEAD:master" ]]
    exit 0
    ;;
  ls-remote)
    echo 'git protocol verification must not be used' >&2
    exit 92
    ;;
  *)
    echo "unexpected git command: $*" >&2
    exit 2
    ;;
esac
`);
  await chmod(gitFixture, 0o700);

  await writeFile(curlFixture, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"$GITEE_TOKEN"* ]]; then
  echo 'token leaked through curl arguments' >&2
  exit 93
fi
config=''
while (($#)); do
  if [[ "$1" == '--config' ]]; then
    config="$2"
    break
  fi
  shift
done
[[ -n "$config" && -f "$config" ]]
[[ "$(stat -c '%a' "$config")" == '600' ]]
grep -Fq 'https://gitee.com/api/v5/repos/example/sushua/branches/master?access_token=' "$config"
grep -Fq "$GITEE_TOKEN" "$config"
attempt=0
[[ ! -f "$ATTEMPT_FILE" ]] || attempt="$(cat "$ATTEMPT_FILE")"
attempt=$((attempt + 1))
printf '%s' "$attempt" > "$ATTEMPT_FILE"
if (( attempt < 3 )); then
  echo 'curl: (22) The requested URL returned error: 429' >&2
  exit 22
fi
printf '{"commit":{"sha":"%s"}}\n' "$DEPLOY_SHA"
`);
  await chmod(curlFixture, 0o700);

  const result = spawnSync("bash", ["scripts/mirror-gitee.sh"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixtureDir}:${process.env.PATH ?? ""}`,
      ATTEMPT_FILE: attemptFile,
      DEPLOY_SHA: releaseSha,
      GITEE_REPOSITORY: "example/sushua",
      GITEE_USER: "integration-user",
      GITEE_TOKEN: secret,
      GITEE_VERIFY_ATTEMPTS: "3",
      GITEE_VERIFY_RETRY_SECONDS: "0",
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await readFile(attemptFile, "utf8"), "3");
  assert.match(result.stdout, /Gitee master now points to 0123456789abcdef0123456789abcdef01234567/);
  assert.equal(`${result.stdout}\n${result.stderr}`.includes(secret), false);
  console.log("  ✓ push 使用 AskPass，REST SHA 核验在两次 429 后只接受目标 SHA 且 token 不进入参数");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
