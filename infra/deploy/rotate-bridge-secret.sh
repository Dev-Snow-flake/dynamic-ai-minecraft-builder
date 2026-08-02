#!/usr/bin/env bash
set -euo pipefail

env_file=/etc/dynamic-ai/gateway.env
plugin_config=/root/dev/plugins/DynamicAiBridge/config.yml
new_secret=$(openssl rand -hex 32)
env_tmp=$(mktemp /etc/dynamic-ai/gateway.env.XXXXXX)
trap 'rm -f "$env_tmp"' EXIT
umask 077

found=0
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == BRIDGE_SHARED_SECRET=* ]]; then
    printf 'BRIDGE_SHARED_SECRET=%s\n' "$new_secret" >> "$env_tmp"
    found=1
  else
    printf '%s\n' "$line" >> "$env_tmp"
  fi
done < "$env_file"
if [[ "$found" -eq 0 ]]; then
  printf 'BRIDGE_SHARED_SECRET=%s\n' "$new_secret" >> "$env_tmp"
fi
install -m 0600 "$env_tmp" "$env_file"

install -d -m 0700 "$(dirname "$plugin_config")"
if [[ ! -f "$plugin_config" ]]; then
  echo "Plugin config is missing: $plugin_config" >&2
  exit 41
fi
config_tmp=$(mktemp "$(dirname "$plugin_config")/config.yml.XXXXXX")
awk -v secret="$new_secret" '
  BEGIN { replaced = 0 }
  /^[[:space:]]*shared-secret:/ && replaced == 0 {
    printf "  shared-secret: \"%s\"\n", secret
    replaced = 1
    next
  }
  { print }
  END { if (replaced == 0) exit 42 }
' "$plugin_config" > "$config_tmp"
install -m 0600 "$config_tmp" "$plugin_config"
rm -f "$config_tmp"
chmod 0600 "$plugin_config"

systemctl restart dynamic-ai-gateway.service
"$(dirname "$0")/restart-wild.sh"

for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:8787/health >/dev/null && grep -q 'Bridge connected for server server_main' /root/dev/logs/latest.log; then
    echo "Paper bridge credential rotated and connection restored."
    exit 0
  fi
  sleep 1
done

echo "Paper bridge did not reconnect after credential rotation." >&2
exit 40
