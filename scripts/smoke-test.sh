#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${SMOKE_BASE_URL:-http://127.0.0.1:3003}"
FAILURES=0

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

request() {
  local name="$1"
  local path="$2"
  local body_file="${TMP_DIR}/${name}.body"
  local status_file="${TMP_DIR}/${name}.status"
  curl -sS -o "${body_file}" -w "%{http_code}" "${BASE_URL}${path}" > "${status_file}" || return 1
}

pass() {
  printf '[ok] %s\n' "$1"
}

fail() {
  printf '[fail] %s\n' "$1" >&2
  FAILURES=$((FAILURES + 1))
}

expect_status() {
  local name="$1"
  local expected="$2"
  local actual
  actual="$(cat "${TMP_DIR}/${name}.status")"
  if [[ "${actual}" == "${expected}" ]]; then
    pass "${name} status ${expected}"
  else
    fail "${name} expected status ${expected}, got ${actual}"
  fi
}

expect_body_contains() {
  local name="$1"
  local needle="$2"
  if grep -Fq "${needle}" "${TMP_DIR}/${name}.body"; then
    pass "${name} body contains ${needle}"
  else
    fail "${name} body did not contain expected text"
  fi
}

run_check() {
  local name="$1"
  local path="$2"
  if request "${name}" "${path}"; then
    pass "${name} request completed"
  else
    fail "${name} request failed"
  fi
}

printf '[smoke] Target: %s\n' "${BASE_URL}"

run_check health /api/health
expect_status health 200
expect_body_contains health '"ok":true'
expect_body_contains health '"app":"social-site"'

run_check api_not_real /api/not-real
expect_status api_not_real 404
expect_body_contains api_not_real '"error":"Not found"'

run_check root /
expect_status root 200

run_check admin_shell /admin
expect_status admin_shell 200

run_check admin_users_unauth /api/admin/users
expect_status admin_users_unauth 401
expect_body_contains admin_users_unauth '"error":"Authentication required."'

run_check admin_backups_unauth /api/admin/backups/status
expect_status admin_backups_unauth 401
expect_body_contains admin_backups_unauth '"error":"Authentication required."'

run_check oauth_token_no_session /api/auth/oauth-token
expect_status oauth_token_no_session 401
expect_body_contains oauth_token_no_session '"error":"No OAuth session found. Please try logging in again."'

if [[ "${FAILURES}" -gt 0 ]]; then
  printf '[smoke] FAILED with %s issue(s).\n' "${FAILURES}" >&2
  exit 1
fi

printf '[smoke] All checks passed.\n'
