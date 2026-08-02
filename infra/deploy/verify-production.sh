#!/usr/bin/env bash
set -euo pipefail

base_url=${1:-http://127.0.0.1:8787}
env_file=${DYNAMIC_AI_ENV_FILE:-/etc/dynamic-ai/gateway.env}
auth_tmp=$(mktemp -d)
trap 'rm -rf "$auth_tmp"' EXIT

control_password=$(sed -n 's/^CONTROL_CENTER_PASSWORD=//p' "$env_file")
if [[ -z "$control_password" ]]; then
  echo "CONTROL_CENTER_PASSWORD is missing." >&2
  exit 2
fi

login_json=$(printf '%s' "$control_password" | python3 -c 'import json,sys; print(json.dumps({"password": sys.stdin.read()}))')
login_response=$(curl -fsS -c "$auth_tmp/cookies" -H 'Content-Type: application/json' --data-binary "$login_json" "$base_url/api/v1/auth/login")
csrf=$(printf '%s' "$login_response" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["csrfToken"])')
printf '%s' "$login_response" | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print(f"login=ok role={d['"'"'role'"'"']} authenticated={d['"'"'authenticated'"'"']}")'

curl -fsS -b "$auth_tmp/cookies" "$base_url/api/v1/servers/server_main/status" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print(f"bridge_connected={d['"'"'connected'"'"']} tps={d['"'"'tps'"'"']} world={d['"'"'world'"'"']}")'

missing_csrf_status=$(curl -sS -o /dev/null -w '%{http_code}' -b "$auth_tmp/cookies" -H 'Content-Type: application/json' -X POST --data-binary '{}' "$base_url/api/v1/builds/build_01JMF6RIVER/pause")
if [[ "$missing_csrf_status" != "403" ]]; then
  echo "Expected missing-CSRF request to return 403, received $missing_csrf_status." >&2
  exit 3
fi
echo "missing_csrf_status=403"

curl -fsS -b "$auth_tmp/cookies" -H "X-CSRF-Token: $csrf" -X POST "$base_url/api/v1/auth/logout" >/dev/null
echo "logout=ok"
