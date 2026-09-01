#!/usr/bin/env bash
set -Eeuo pipefail

required=(
  APP_VERSION
  COOLIFY_BASE_URL
  COOLIFY_API_KEY
  COOLIFY_APP_UUID
  PRODUCTION_URL
)

for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Required deployment input is missing: ${name}" >&2
    exit 1
  fi
done

if [[ ! "${APP_VERSION}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "APP_VERSION must be a full Git commit SHA." >&2
  exit 1
fi

command -v curl >/dev/null || { echo "curl is required." >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required." >&2; exit 1; }

coolify_base_url="${COOLIFY_BASE_URL%/}"
production_url="${PRODUCTION_URL%/}"
health_path="${PRODUCTION_HEALTH_PATH:-/api/health}"
poll_interval="${COOLIFY_POLL_INTERVAL_SECONDS:-15}"
max_deployment_polls="${COOLIFY_MAX_DEPLOYMENT_POLLS:-80}"
max_application_polls="${COOLIFY_MAX_APPLICATION_POLLS:-60}"
max_public_polls="${PRODUCTION_MAX_HEALTH_POLLS:-30}"

coolify_curl() {
  curl --fail --silent --show-error --retry 3 --retry-all-errors \
    -H "Authorization: Bearer ${COOLIFY_API_KEY}" \
    -H "Accept: application/json" \
    "$@"
}

echo "Publishing commit ${APP_VERSION} through Coolify."

version_payload="$(jq -nc \
  --arg key APP_VERSION \
  --arg value "${APP_VERSION}" \
  '{key:$key,value:$value,is_preview:false,is_literal:true}')"

current_envs="$(
  coolify_curl \
    "${coolify_base_url}/api/v1/applications/${COOLIFY_APP_UUID}/envs"
)"
if jq -e 'any(.[]; .key == "APP_VERSION" and .is_preview == false)' \
  <<<"${current_envs}" >/dev/null; then
  env_method=PATCH
else
  env_method=POST
fi

coolify_curl \
  -X "${env_method}" \
  -H "Content-Type: application/json" \
  --data-binary "${version_payload}" \
  "${coolify_base_url}/api/v1/applications/${COOLIFY_APP_UUID}/envs" \
  >/dev/null

published_version="$(
  coolify_curl \
    "${coolify_base_url}/api/v1/applications/${COOLIFY_APP_UUID}/envs" |
    jq -er '[.[] | select(.key == "APP_VERSION" and .is_preview == false) | .value][0] // empty'
)"

if [[ "${published_version}" != "${APP_VERSION}" ]]; then
  echo "Coolify did not persist the requested APP_VERSION." >&2
  exit 1
fi

deploy_response="$(
  coolify_curl \
    -X POST \
    "${coolify_base_url}/api/v1/deploy?uuid=${COOLIFY_APP_UUID}&force=true"
)"
deployment_uuid="$(jq -er '.deployments[0].deployment_uuid // empty' <<<"${deploy_response}")"
echo "Coolify deployment queued: ${deployment_uuid}."

last_status=""
deployment_finished=false
for ((attempt = 1; attempt <= max_deployment_polls; attempt++)); do
  deployment="$(coolify_curl "${coolify_base_url}/api/v1/deployments/${deployment_uuid}")"
  status="$(jq -r '.status // "unknown"' <<<"${deployment}")"
  if [[ "${status}" != "${last_status}" ]]; then
    echo "Deployment status: ${status} (${attempt}/${max_deployment_polls})."
    last_status="${status}"
  fi

  case "${status}" in
    finished)
      deployed_commit="$(jq -r '.commit // empty' <<<"${deployment}")"
      if [[ -n "${deployed_commit}" && "${deployed_commit}" != "${APP_VERSION}" ]]; then
        echo "Coolify deployed ${deployed_commit}, expected ${APP_VERSION}." >&2
        exit 1
      fi
      deployment_finished=true
      break
      ;;
    failed|cancelled|canceled|exited|exited:unhealthy)
      echo "Coolify deployment ${deployment_uuid} ended with status ${status}." >&2
      exit 1
      ;;
  esac
  sleep "${poll_interval}"
done

if [[ "${deployment_finished}" != true ]]; then
  echo "Coolify deployment ${deployment_uuid} did not finish before timeout." >&2
  exit 1
fi

last_status=""
application_healthy=false
for ((attempt = 1; attempt <= max_application_polls; attempt++)); do
  application="$(coolify_curl "${coolify_base_url}/api/v1/applications/${COOLIFY_APP_UUID}")"
  status="$(jq -r '.status // "unknown"' <<<"${application}")"
  if [[ "${status}" != "${last_status}" ]]; then
    echo "Application status: ${status} (${attempt}/${max_application_polls})."
    last_status="${status}"
  fi

  if [[ "${status}" == *healthy* && "${status}" != *unhealthy* ]]; then
    application_healthy=true
    break
  fi
  if [[ "${status}" == failed* || "${status}" == exited* ]]; then
    echo "Coolify application ended with status ${status}." >&2
    exit 1
  fi
  sleep 10
done

if [[ "${application_healthy}" != true ]]; then
  echo "Coolify application did not become healthy before timeout." >&2
  exit 1
fi

health_file="$(mktemp)"
trap 'rm -f "${health_file}"' EXIT
public_ready=false
for ((attempt = 1; attempt <= max_public_polls; attempt++)); do
  if curl --fail --silent --show-error --max-time 20 \
    "${production_url}${health_path}" >"${health_file}" 2>/dev/null; then
    health_ok="$(jq -r '.ok // false' "${health_file}" 2>/dev/null || true)"
    health_version="$(jq -r '.version // empty' "${health_file}" 2>/dev/null || true)"
    if [[ "${health_ok}" == "true" && "${health_version}" == "${APP_VERSION}" ]]; then
      public_ready=true
      break
    fi
    echo "Public health is reachable but not ready for ${APP_VERSION} (${attempt}/${max_public_polls})."
  else
    echo "Public health is not reachable yet (${attempt}/${max_public_polls})."
  fi
  sleep 10
done

if [[ "${public_ready}" != true ]]; then
  echo "Public health did not confirm ${APP_VERSION} before timeout." >&2
  exit 1
fi

curl --fail --silent --show-error --max-time 20 \
  --output /dev/null "${production_url}/"

echo "Production is healthy at ${production_url} with version ${APP_VERSION}."
