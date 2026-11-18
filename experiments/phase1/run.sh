#!/usr/bin/env bash
# Usage: [K=2] [N=8] [TASKS=file] [PHASE1_JOBS_DIR=dir] run.sh <condition> [verify] [--watchdog true|false]
# Runs one Phase 1 condition on the 19 reliable baseline tasks, writing jobs/phase1/<condition>[+verify].
# "verify" adds the reviewer and one correction round (the always-verify comparison).
# The agent works offline (PIMAS_OFFLINE=1), so it cannot look up the upstream fix; grading has the network.
# Needs the model server from ../swe-bench-baseline/scripts/serve-vllm.sh.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
condition=${1:?Usage: run.sh <condition> [verify] [--watchdog true|false]}; shift
verify=; watchdog=${PIMAS_WATCHDOG:-false}
while [ "$#" -gt 0 ]; do
  case "$1" in
    verify) verify=verify; shift ;;
    --watchdog)
      [ "$#" -ge 2 ] || { echo "--watchdog requires true or false" >&2; exit 2; }
      watchdog=$2; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$watchdog" in true|false) ;; *) echo "--watchdog must be true or false" >&2; exit 2 ;; esac
[ -d "$here/conditions/$condition" ] || { echo "No condition $condition in $here/conditions" >&2; exit 2; }
name=$condition; review=0
if [ "$verify" = verify ]; then name=$condition+verify; review=1; fi
# Not JOBS_DIR: env.sh sets that to the baseline folder, and Phase 1 jobs must not land there.
export JOBS_DIR=${PHASE1_JOBS_DIR:-$(cd "$here/../.." && pwd)/jobs/phase1}
export K=${K:-2}
exec "$here/../swe-bench-baseline/scripts/launch.sh" "$name" "${TASKS:-$here/tasks-19.txt}" \
  --agent pimas_harbor.agent:PimasAgent -m Qwen/Qwen3.8-27B --agent-timeout-multiplier 2 \
  --ae "PIMAS_CONDITIONS=$here/conditions/$condition" --ae "PIMAS_REVIEW=$review" --ae "PIMAS_OFFLINE=${PIMAS_OFFLINE:-1}" \
  --ae "PIMAS_WATCHDOG=$watchdog"
