#!/usr/bin/env bash
set -euo pipefail

env_file=/etc/dynamic-ai/gateway.env
if [[ ! -f "$env_file" ]]; then
  echo "Missing $env_file" >&2
  exit 2
fi

new_password=$(openssl rand -base64 24 | tr -d '\n')
temporary=$(mktemp /etc/dynamic-ai/gateway.env.XXXXXX)
trap 'rm -f "$temporary"' EXIT
awk -v replacement="CONTROL_CENTER_PASSWORD=$new_password" '
  BEGIN { replaced = 0 }
  /^CONTROL_CENTER_PASSWORD=/ { print replacement; replaced = 1; next }
  { print }
  END { if (!replaced) print replacement }
' "$env_file" > "$temporary"
chmod 0600 "$temporary"
mv "$temporary" "$env_file"
trap - EXIT
systemctl restart dynamic-ai-gateway.service
printf '%s\n' "$new_password"
