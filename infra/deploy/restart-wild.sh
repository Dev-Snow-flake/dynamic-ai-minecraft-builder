#!/usr/bin/env bash
set -euo pipefail

player_count=$(ss -tn state established '( sport = :25567 )' | tail -n +2 | wc -l)
if [[ "$player_count" -ne 0 ]]; then
  echo "Wild server has $player_count active connection(s); restart aborted." >&2
  exit 20
fi

if tmux has-session -t wild 2>/dev/null; then
  tmux send-keys -t wild:0.0 'stop' Enter
fi

for _ in $(seq 1 45); do
  if ! ss -ltn | grep -q ':25567 '; then
    break
  fi
  sleep 1
done

if ss -ltn | grep -q ':25567 '; then
  echo "Wild server did not stop within 45 seconds." >&2
  exit 21
fi

tmux kill-session -t wild >/dev/null 2>&1 || true
tmux new-session -d -s wild -c /root/dev '/usr/lib/jvm/zulu25-ca-amd64/bin/java -Xms1G -Xmx3G -Dfile.encoding=UTF-8 -jar paper.jar nogui'

for _ in $(seq 1 90); do
  if ss -ltn | grep -q ':25567 '; then
    echo "Wild Paper server restarted."
    exit 0
  fi
  sleep 1
done

echo "Wild server did not open port 25567 within 90 seconds." >&2
exit 22
