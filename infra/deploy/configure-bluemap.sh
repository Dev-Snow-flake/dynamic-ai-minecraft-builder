#!/usr/bin/env bash
set -euo pipefail

server_dir=/root/dev
config="$server_dir/plugins/BlueMap/core.conf"

if ! grep -qx 'eula=true' "$server_dir/eula.txt"; then
  echo "Minecraft EULA has not been accepted; BlueMap resource download remains disabled." >&2
  exit 30
fi

if [[ ! -f "$config" ]]; then
  echo "BlueMap core config is missing: $config" >&2
  exit 31
fi

sed -i 's/^accept-download: false$/accept-download: true/' "$config"
grep -qx 'accept-download: true' "$config"

# Paper 1.21.11 stores each region below a dimension folder while level.dat
# remains at the world root. BlueMap needs a metadata snapshot next to each
# region folder; regular copies avoid Paper's intentional symlink prohibition.
for dimension in overworld the_nether the_end; do
  dimension_dir="$server_dir/world/dimensions/minecraft/$dimension"
  if [[ -L "$dimension_dir/level.dat" ]]; then
    unlink "$dimension_dir/level.dat"
  fi
  install -m 0600 "$server_dir/world/level.dat" "$dimension_dir/level.dat"
  sed -i "s|^world: .*|world: \"world/dimensions/minecraft/$dimension\"|" "$server_dir/plugins/BlueMap/maps/$dimension.conf"
done

sed -i 's|^#\?start-location: .*|start-location: "overworld:0:80:0:390:0.1:0.19:0:0:perspective"|' "$server_dir/plugins/BlueMap/webapp.conf"

tmux send-keys -t wild:0.0 'bluemap reload' Enter

for _ in {1..45}; do
  if ss -ltn | grep -q ':8100 '; then
    echo "BlueMap webserver is listening."
    exit 0
  fi
  sleep 1
done

echo "BlueMap did not open port 8100 in time." >&2
exit 32
