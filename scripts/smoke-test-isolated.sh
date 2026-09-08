#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRODUCTION_DB="${PROJECT_ROOT}/data/social.db"
PRODUCTION_UPLOADS="${PROJECT_ROOT}/uploads"
TEST_ROOT="$(mktemp -d /tmp/refugecloud-smoke.XXXXXX)"
TEST_DB="${TEST_ROOT}/data/test-social.db"
TEST_UPLOADS="${TEST_ROOT}/uploads"
SERVER_LOG="${TEST_ROOT}/server.log"
SERVER_PID=""

cleanup() {
  local exit_code=$?
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi

  case "${TEST_ROOT}" in
    /tmp/refugecloud-smoke.*) rm -rf -- "${TEST_ROOT}" ;;
    *)
      printf '[isolated-smoke] Refusing to remove unexpected temp path: %s\n' "${TEST_ROOT}" >&2
      exit_code=1
      ;;
  esac
  exit "${exit_code}"
}
trap cleanup EXIT INT TERM

if [[ "${TEST_DB}" == "${PRODUCTION_DB}" || "${TEST_UPLOADS}" == "${PRODUCTION_UPLOADS}" ]]; then
  printf '[isolated-smoke] Refusing unsafe storage paths.\n' >&2
  exit 1
fi

mkdir -p "${TEST_ROOT}/data" "${TEST_UPLOADS}"
TEST_PORT="$(
  node -e "const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});"
)"
if [[ -z "${TEST_PORT}" || "${TEST_PORT}" == "3003" ]]; then
  printf '[isolated-smoke] Could not allocate a safe non-production port.\n' >&2
  exit 1
fi

printf '[isolated-smoke] NODE_ENV=test\n'
printf '[isolated-smoke] Database: %s\n' "${TEST_DB}"
printf '[isolated-smoke] Uploads : %s\n' "${TEST_UPLOADS}"
printf '[isolated-smoke] Port    : %s\n' "${TEST_PORT}"

(
  cd "${PROJECT_ROOT}"
  NODE_ENV=test \
  DOTENV_CONFIG_PATH=/dev/null \
  PORT="${TEST_PORT}" \
  DATABASE_PATH="${TEST_DB}" \
  UPLOADS_DIR="${TEST_UPLOADS}" \
  JWT_SECRET=isolated-smoke-jwt-secret-not-for-production \
  SESSION_SECRET=isolated-smoke-session-secret-not-for-production \
  APP_BASE_URL="http://127.0.0.1:${TEST_PORT}" \
  WEB_BASE_URL="http://127.0.0.1:${TEST_PORT}" \
  GOOGLE_CLIENT_ID= \
  GOOGLE_CLIENT_SECRET= \
  STEAM_API_KEY= \
  STEAM_RETURN_URL= \
  RESEND_API_KEY= \
  RATE_LIMIT_ENABLED=false \
  exec ./node_modules/.bin/tsx server/index.ts
) >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!

ready=0
for _attempt in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:${TEST_PORT}/api/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

if [[ "${ready}" != "1" ]]; then
  printf '[isolated-smoke] Test server failed to start.\n' >&2
  sed -n '1,160p' "${SERVER_LOG}" >&2
  exit 1
fi

SMOKE_BASE_URL="http://127.0.0.1:${TEST_PORT}" \
SMOKE_API_ONLY=1 \
bash "${PROJECT_ROOT}/scripts/smoke-test.sh"

if [[ ! -f "${TEST_DB}" || ! -d "${TEST_UPLOADS}" ]]; then
  printf '[isolated-smoke] Expected isolated storage was not created.\n' >&2
  exit 1
fi

printf '[isolated-smoke] Isolated storage verified; cleanup will run now.\n'
