#!/usr/bin/env bash
# Usage: [N=8] [K=1] launch.sh <job-name> <tasks-file> <agent args...>
#   oracle:   launch.sh swe-oracle tasks/pilot-32.txt -a oracle
#   pilot:    launch.sh swe-pilot tasks/pilot-30.txt --agent pimas_harbor.agent:PimasAgent -m Qwen/Qwen3.8-27B --agent-timeout-multiplier 2
#   baseline: K=3 launch.sh swe-baseline tasks/baseline-20.txt --agent pimas_harbor.agent:PimasAgent -m Qwen/Qwen3.8-27B --agent-timeout-multiplier 2
# Runs SWE-bench Verified through Harbor in the background of this script, logging to $JOBS_DIR/<job-name>.{log,guard.log}.
# A disk guard checks $DOCKER_MOUNT every 60 s and sends SIGTERM to harbor below 40 GB free
# (harbor ignores SIGINT when backgrounded).
source "$(dirname "$0")/env.sh"
tasks=$(realpath "$2"); name=$1; shift 2
mkdir -p "$JOBS_DIR"; log=$JOBS_DIR/$name.log; guard=$JOBS_DIR/$name.guard.log
VLLM_API_KEY=$(cat "$VLLM_API_KEY_FILE"); export VLLM_API_KEY
cd "$PIMAS_ROOT"; export PYTHONPATH=$PIMAS_ROOT
inc=(); while read -r t; do [ -n "$t" ] && inc+=(-i "swe-bench/$t"); done < "$tasks"
echo "start $(date -Is) free=$(df -BG --output=avail "$DOCKER_MOUNT" | tail -1)" > "$guard"
harbor run -d swe-bench/swe-bench-verified -n "${N:-8}" -k "${K:-1}" "${inc[@]}" "$@" \
  -o "$JOBS_DIR" --job-name "$name" < /dev/null > "$log" 2>&1 &
hp=$!; echo "harbor pid $hp" >> "$guard"
while kill -0 "$hp" 2>/dev/null; do
  free=$(df -BG --output=avail "$DOCKER_MOUNT" | tail -1 | tr -dc 0-9)
  echo "$(date +%T) free=${free}G" >> "$guard"
  if [ "$free" -lt 40 ]; then echo "$(date +%T) ABORT free=${free}G, SIGTERM $hp" >> "$guard"; kill -TERM "$hp"; fi
  sleep 60
done
wait "$hp"; rc=$?; echo "harbor rc=$rc $(date -Is)" >> "$guard"; exit $rc
