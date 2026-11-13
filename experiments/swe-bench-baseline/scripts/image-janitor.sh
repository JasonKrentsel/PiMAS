#!/usr/bin/env bash
# Usage: image-janitor.sh <log> <pid>...
# Removes SWE-bench task images (swebench/sweb.eval.*) once nothing uses them, so a sweep on a nearly full disk keeps
# only the images of trials in flight. Harbor's --delete removes only the small image it builds on top of each one.
# An image is removed only when it was pulled after the janitor started, has been present for 10 minutes (so a build
# that just pulled it is not raced), and no container or Harbor-built image names its task. A task's image may then be
# pulled again by a later trial of another condition. Runs until every given pid has exited.
set -u
log=$1; shift
images() { docker images --format '{{.Repository}}:{{.Tag}}' | grep '^swebench/sweb\.eval\.' | sort; }
kept=$(images)
declare -A first
echo "$(date +%T) janitor start; keeping $(grep -c . <<<"$kept") images present before" >> "$log"
while :; do
  alive=0; for pid in "$@"; do kill -0 "$pid" 2>/dev/null && alive=1; done
  now=$(date +%s)
  # Everything that may still use a task image: containers (any state) and images Harbor built for a trial.
  users=$( { docker ps -a --format '{{.Names}} {{.Image}}'; docker images --format '{{.Repository}}' | grep -v '^swebench/'; } | tr 'A-Z' 'a-z')
  for image in $(images); do
    grep -qxF "$image" <<<"$kept" && continue
    : "${first[$image]:=$now}"
    (( now - first[$image] < 600 )) && continue
    task=${image##*_1776_}; task=${task%%:*}   # e.g. astropy-14309
    grep -qF -- "$task" <<<"$users" && continue
    if docker rmi "$image" >/dev/null 2>&1; then
      echo "$(date +%T) removed $image free=$(df -BG --output=avail "${DOCKER_MOUNT:-/}" | tail -1 | tr -d ' ')" >> "$log"
      unset "first[$image]"
    fi
  done
  [ "$alive" = 0 ] && break
  sleep 60
done
echo "$(date +%T) janitor done" >> "$log"
