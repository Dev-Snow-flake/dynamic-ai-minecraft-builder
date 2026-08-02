#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/dynamic-ai
ARCHIVE=/tmp/dynamic-ai-deploy.tar.gz
NODE_VERSION=24.16.0
NODE_DIR=/opt/node-v${NODE_VERSION}-linux-x64
GRADLE_VERSION=9.6.1
GRADLE_DIR=/opt/gradle-${GRADLE_VERSION}
GRADLE_SHA256=9c0f7faeeb306cb14e4279a3e084ca6b596894089a0638e68a07c945a32c9e14

if [[ ! -f "$ARCHIVE" ]]; then
  echo "Deployment archive is missing: $ARCHIVE" >&2
  exit 2
fi

if ! id dynamic-ai >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin dynamic-ai
fi

if [[ ! -x "$NODE_DIR/bin/node" ]]; then
  node_tmp=$(mktemp -d)
  trap 'rm -rf "$node_tmp"' EXIT
  curl -fsSLo "$node_tmp/node.tar.xz" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
  curl -fsSLo "$node_tmp/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  expected=$(grep " node-v${NODE_VERSION}-linux-x64.tar.xz$" "$node_tmp/SHASUMS256.txt" | awk '{print $1}')
  actual=$(sha256sum "$node_tmp/node.tar.xz" | awk '{print $1}')
  [[ -n "$expected" && "$expected" == "$actual" ]]
  tar -xJf "$node_tmp/node.tar.xz" -C /opt
  rm -rf "$node_tmp"
  trap - EXIT
fi

if [[ ! -x "$GRADLE_DIR/bin/gradle" ]]; then
  gradle_tmp=$(mktemp -d)
  trap 'rm -rf "$gradle_tmp"' EXIT
  curl -fsSLo "$gradle_tmp/gradle.zip" "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip"
  echo "$GRADLE_SHA256  $gradle_tmp/gradle.zip" | sha256sum -c -
  python3 -m zipfile -e "$gradle_tmp/gradle.zip" /opt
  rm -rf "$gradle_tmp"
  trap - EXIT
fi
chmod 0755 "$GRADLE_DIR/bin/gradle"

if [[ "${DYNAMIC_AI_RESUME:-0}" != "1" ]]; then
  staging=$(mktemp -d /opt/dynamic-ai.new.XXXXXX)
  tar -xzf "$ARCHIVE" -C "$staging"
  if [[ -e "$APP_DIR" ]]; then
    backup="/opt/dynamic-ai.backup.$(date +%Y%m%d%H%M%S)"
    mv "$APP_DIR" "$backup"
  fi
  mv "$staging" "$APP_DIR"
fi
find "$APP_DIR" -type d -exec chmod 0755 {} +
find "$APP_DIR" -type f -exec chmod 0644 {} +
find "$APP_DIR/infra/deploy" -type f -name '*.sh' -exec chmod 0755 {} +
install -d -o dynamic-ai -g dynamic-ai -m 0750 "$APP_DIR/data"
chown -R dynamic-ai:dynamic-ai "$APP_DIR"

runuser -u dynamic-ai -- sh -c "cd '$APP_DIR' && PATH='$NODE_DIR/bin:/usr/bin:/bin' '$NODE_DIR/bin/npm' ci --no-audit --no-fund"
runuser -u dynamic-ai -- sh -c "cd '$APP_DIR' && PATH='$NODE_DIR/bin:/usr/bin:/bin' SKIP_MINECRAFT_ASSET_PREP=1 '$NODE_DIR/bin/npm' run build"

"$GRADLE_DIR/bin/gradle" -p "$APP_DIR/plugins/paper-bridge" clean build --no-daemon

install -d -m 0750 /etc/dynamic-ai
if [[ ! -f /etc/dynamic-ai/gateway.env ]]; then
  bridge_secret=$(openssl rand -hex 32)
  control_password=$(openssl rand -base64 24 | tr -d '\n')
  key_encryption_secret=$(openssl rand -hex 32)
  umask 077
  printf 'GATEWAY_HOST=0.0.0.0\nGATEWAY_PORT=8787\nWEB_ORIGIN=https://map.work-plus.kr\nBRIDGE_SHARED_SECRET=%s\nCONTROL_CENTER_PASSWORD=%s\nCONTROL_CENTER_STATE_PATH=/var/lib/dynamic-ai/control-center-state.json\nOPENAI_API_KEY=\nOPENAI_MODEL=gpt-5.6-sol\nOPENAI_KEY_ENCRYPTION_SECRET=%s\nOPENAI_KEY_STORE_PATH=/var/lib/dynamic-ai/openai-key.json\nARCHITECT_RATE_LIMIT_PER_HOUR=12\n' "$bridge_secret" "$control_password" "$key_encryption_secret" > /etc/dynamic-ai/gateway.env
fi
if ! grep -q '^CONTROL_CENTER_PASSWORD=' /etc/dynamic-ai/gateway.env; then
  printf 'CONTROL_CENTER_PASSWORD=%s\n' "$(openssl rand -base64 24 | tr -d '\n')" >> /etc/dynamic-ai/gateway.env
fi
if ! grep -q '^OPENAI_KEY_ENCRYPTION_SECRET=' /etc/dynamic-ai/gateway.env; then
  printf 'OPENAI_KEY_ENCRYPTION_SECRET=%s\n' "$(openssl rand -hex 32)" >> /etc/dynamic-ai/gateway.env
fi
if ! grep -q '^OPENAI_KEY_STORE_PATH=' /etc/dynamic-ai/gateway.env; then
  printf 'OPENAI_KEY_STORE_PATH=/var/lib/dynamic-ai/openai-key.json\n' >> /etc/dynamic-ai/gateway.env
fi
if ! grep -q '^CONTROL_CENTER_STATE_PATH=' /etc/dynamic-ai/gateway.env; then
  printf 'CONTROL_CENTER_STATE_PATH=/var/lib/dynamic-ai/control-center-state.json\n' >> /etc/dynamic-ai/gateway.env
fi
if ! grep -q '^ALLOW_PUBLIC_SERVER_ENROLLMENT=' /etc/dynamic-ai/gateway.env; then
  printf 'ALLOW_PUBLIC_SERVER_ENROLLMENT=true\n' >> /etc/dynamic-ai/gateway.env
fi
if ! grep -q '^TENANT_REGISTRY_PATH=' /etc/dynamic-ai/gateway.env; then
  printf 'TENANT_REGISTRY_PATH=/var/lib/dynamic-ai/tenant-registry.json\n' >> /etc/dynamic-ai/gateway.env
fi
if ! grep -q '^TENANT_STATE_DIRECTORY=' /etc/dynamic-ai/gateway.env; then
  printf 'TENANT_STATE_DIRECTORY=/var/lib/dynamic-ai/servers\n' >> /etc/dynamic-ai/gateway.env
fi
if ! grep -q '^TENANT_KEY_DIRECTORY=' /etc/dynamic-ai/gateway.env; then
  printf 'TENANT_KEY_DIRECTORY=/var/lib/dynamic-ai/keys\n' >> /etc/dynamic-ai/gateway.env
fi
chmod 0600 /etc/dynamic-ai/gateway.env
install -d -o dynamic-ai -g dynamic-ai -m 0700 /var/lib/dynamic-ai

install -m 0644 "$APP_DIR/infra/systemd/dynamic-ai-gateway.service" /etc/systemd/system/dynamic-ai-gateway.service
systemctl daemon-reload
systemctl enable dynamic-ai-gateway.service
systemctl restart dynamic-ai-gateway.service

bridge_secret=$(sed -n 's/^BRIDGE_SHARED_SECRET=//p' /etc/dynamic-ai/gateway.env)
plugin_dir=/root/dev/plugins/DynamicAiBridge
install -d -m 0700 "$plugin_dir"
umask 077
plugin_config="$plugin_dir/config.yml"
if [[ ! -f "$plugin_config" ]]; then
  printf '%s\n' \
    'gateway:' \
    '  uri: "ws://127.0.0.1:8787/bridge"' \
    "  shared-secret: \"$bridge_secret\"" \
    '  reconnect-delay-ticks: 100' \
    'server-id: "server_main"' \
    'policy:' \
    '  allow-world-writes: false' \
    '  allowed-worlds:' \
    '    - "world"' \
    '  allowed-regions: []' \
    '  allowed-blocks:' \
    '    - "minecraft:spruce_planks"' \
    '    - "minecraft:stone_bricks"' \
    '    - "minecraft:glass"' \
    '    - "minecraft:oxidized_copper"' \
    '  minimum-tps: 18.0' \
    '  maximum-mspt: 40.0' \
    '  maximum-total-blocks: 12000' \
    '  maximum-batch-blocks: 250' \
    '  player-exclusion-radius: 24' > "$plugin_config"
else
  config_tmp=$(mktemp "$plugin_dir/config.yml.XXXXXX")
  awk -v secret="$bridge_secret" '
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
fi
add_allow=0
add_regions=0
grep -q '^[[:space:]]*allow-world-writes:' "$plugin_config" || add_allow=1
grep -q '^[[:space:]]*allowed-regions:' "$plugin_config" || add_regions=1
if [[ "$add_allow" -eq 1 || "$add_regions" -eq 1 ]]; then
  config_tmp=$(mktemp "$plugin_dir/config.yml.XXXXXX")
  awk -v add_allow="$add_allow" -v add_regions="$add_regions" '
    /^policy:[[:space:]]*$/ {
      print
      if (add_allow == 1) print "  allow-world-writes: false"
      if (add_regions == 1) print "  allowed-regions: []"
      next
    }
    { print }
  ' "$plugin_config" > "$config_tmp"
  install -m 0600 "$config_tmp" "$plugin_config"
  rm -f "$config_tmp"
fi
chmod 0600 "$plugin_dir/config.yml"
rm -f /root/dev/plugins/DynamicAiBridge-0.1.0.jar
install -m 0644 "$APP_DIR/plugins/paper-bridge/build/libs/dynamic-ai-paper-bridge-0.2.0.jar" /root/dev/plugins/DynamicAiBridge.jar

for _ in {1..30}; do
  if systemctl is-active --quiet dynamic-ai-gateway.service && curl -fsS http://127.0.0.1:8787/health >/dev/null; then
    echo "Dynamic AI Gateway installed and healthy."
    exit 0
  fi
  sleep 0.5
done
systemctl --no-pager --full status dynamic-ai-gateway.service >&2 || true
exit 1
