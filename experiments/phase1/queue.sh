#!/usr/bin/env bash
# Usage: queue.sh <log> <condition[:verify]>...
# Runs conditions one after another with run.sh (plain at K runs per task, default 2; verify at 1; N=4 each,
# so two queues fill 8 streams).
# Stops before a job if the model server is unhealthy, and skips a condition with no condition files.
here=$(cd "$(dirname "$0")" && pwd)
log=$1; shift
source "$here/../swe-bench-baseline/scripts/env.sh"
for item in "$@"; do
  condition=${item%%:*}; verify=; [ "$item" != "$condition" ] && verify=verify
  if ! curl -s -m 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$VLLM_PORT/health" | grep -q 200; then
    echo "$(date +%T) model server unhealthy; stopping before $item" >> "$log"; exit 3
  fi
  if [ ! -d "$here/conditions/$condition" ]; then echo "$(date +%T) skip $item: no condition files" >> "$log"; continue; fi
  echo "$(date +%T) start $item" >> "$log"
  if [ -n "$verify" ]; then K=1 N=4 "$here/run.sh" "$condition" verify; else K=${K:-2} N=4 "$here/run.sh" "$condition"; fi
  echo "$(date +%T) done $item rc=$? free=$(df -BG --output=avail "$DOCKER_MOUNT" | tail -1 | tr -d ' ')" >> "$log"
done
echo "$(date +%T) queue finished" >> "$log"
