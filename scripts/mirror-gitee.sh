#!/usr/bin/env bash
set -Eeuo pipefail

required=(DEPLOY_SHA GITEE_REPOSITORY GITEE_USER GITEE_TOKEN)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Required Gitee mirror input is missing: ${name}" >&2
    exit 1
  fi
done

if [[ ! "${DEPLOY_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "DEPLOY_SHA must be a full Git commit SHA." >&2
  exit 1
fi
if [[ ! "${GITEE_REPOSITORY}" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
  echo "GITEE_REPOSITORY must be an owner/repository path." >&2
  exit 1
fi

verify_attempts="${GITEE_VERIFY_ATTEMPTS:-5}"
retry_seconds="${GITEE_VERIFY_RETRY_SECONDS:-5}"
if [[ ! "${verify_attempts}" =~ ^[0-9]+$ ]] || ((verify_attempts < 1 || verify_attempts > 10)); then
  echo "GITEE_VERIFY_ATTEMPTS must be between 1 and 10." >&2
  exit 1
fi
if [[ ! "${retry_seconds}" =~ ^[0-9]+$ ]] || ((retry_seconds < 0 || retry_seconds > 60)); then
  echo "GITEE_VERIFY_RETRY_SECONDS must be between 0 and 60." >&2
  exit 1
fi

askpass="$(mktemp)"
trap 'rm -f "${askpass}"' EXIT
chmod 700 "${askpass}"
printf '%s\n' \
  '#!/usr/bin/env sh' \
  'case "$1" in' \
  '  *Username*) printf "%s\n" "$GITEE_USER" ;;' \
  '  *) printf "%s\n" "$GITEE_TOKEN" ;;' \
  'esac' > "${askpass}"

remote="https://gitee.com/${GITEE_REPOSITORY}.git"
GIT_ASKPASS="${askpass}" GIT_TERMINAL_PROMPT=0 git push "${remote}" HEAD:master

for ((attempt = 1; attempt <= verify_attempts; attempt++)); do
  remote_ref="$(
    GIT_ASKPASS="${askpass}" GIT_TERMINAL_PROMPT=0 \
      git ls-remote "${remote}" refs/heads/master 2>/dev/null || true
  )"
  remote_sha="$(awk 'NR == 1 { print $1 }' <<<"${remote_ref}")"
  if [[ "${remote_sha}" == "${DEPLOY_SHA}" ]]; then
    echo "Gitee master now points to ${DEPLOY_SHA}."
    exit 0
  fi
  if ((attempt < verify_attempts)); then
    echo "Gitee SHA verification unavailable or not converged (${attempt}/${verify_attempts}); retrying."
    sleep "${retry_seconds}"
  fi
done

echo "Gitee master did not confirm ${DEPLOY_SHA} after ${verify_attempts} attempts." >&2
exit 1
