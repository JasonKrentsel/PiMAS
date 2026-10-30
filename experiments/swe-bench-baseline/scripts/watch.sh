#!/usr/bin/env bash
# Usage: watch.sh <job-name>
# Logs progress every 5 min to $JOBS_DIR/<job-name>.watch.log; exits when harbor exits,
# or with rc 3 if the vLLM server fails its health check for 5 minutes in a row.
source "$(dirname "$0")/env.sh"
name=$1; job=$JOBS_DIR/$name; log=$JOBS_DIR/$name.watch.log
hp=$(grep -m1 'harbor pid' "$JOBS_DIR/$name.guard.log" | awk '{print $3}')
bad=0; i=0
while kill -0 "$hp" 2>/dev/null; do
  if curl -s -m 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$VLLM_PORT/health" | grep -q 200; then bad=0; else bad=$((bad+1)); fi
  if [ $bad -ge 5 ]; then echo "$(date +%T) VLLM UNHEALTHY 5 min" >> "$log"; exit 3; fi
  if [ $((i % 5)) -eq 0 ]; then
    finished=$(ls "$job"/*/result.json 2>/dev/null | wc -l)
    passed=$(cat "$job"/*/verifier/reward.txt 2>/dev/null | grep -c '^1')
    load=$(grep -oE 'Running: [0-9]+ reqs, Waiting: [0-9]+ reqs' "$VLLM_LOG" | tail -1)
    echo "$(date +%T) finished=$finished passed=$passed vllm=[$load] $(tail -1 "$JOBS_DIR/$name.guard.log")" >> "$log"
  fi
  i=$((i+1)); sleep 60
done
echo "$(date +%T) harbor exited" >> "$log"
