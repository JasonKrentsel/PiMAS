"""Stands in for `node src/pipeline-bridge.ts` in the agent relay test; ignores the node/tsx arguments."""

import json
import sys
from pathlib import Path

args = sys.argv[1:]
state = Path(args[args.index("--state") + 1])
task = json.loads(sys.stdin.readline())
send = lambda message: (sys.stdout.write(json.dumps(message) + "\n"), sys.stdout.flush())

send({"type": "exec", "id": 1, "command": f"cd {task['cwd']} && echo hello > out.txt && cat out.txt", "timeout": None})
send({"type": "exec", "id": 2, "command": "sleep 90", "timeout": 1})
send({"type": "exec", "id": 3, "command": "sleep 30", "timeout": None})
send({"type": "cancel", "id": 3})
results = {}
while len(results) < 2:
    message = json.loads(sys.stdin.readline())
    results[message["id"]] = message

events = [
    {"type": "run_start", "mode": "single", "review": False, "request": task["prompt"]},
    {"type": "stage_start", "id": "solve", "stage": "solve", "role": "executor", "parents": []},
    {"type": "tool_call", "stageId": "solve", "call": {"tool": "bash"}},
    {"type": "stage_end", "artifact": {"id": "solve", "status": "submitted", "latencyMs": 5, "changedFiles": ["/x"],
                                       "usage": {"input": 7, "cacheRead": 3, "output": 2}}},
    {"type": "run_end", "status": "completed", "durationMs": 9},
]
(state / "provenance.jsonl").write_text("".join(json.dumps(event) + "\n" for event in events))
(state / "sessions").mkdir(exist_ok=True)
(state / "sessions" / "s.jsonl").write_text(json.dumps({"type": "message", "message": {"role": "assistant", "usage": {"input": 7, "cacheRead": 3, "output": 2}}}) + "\n")
(state / "relay-results.json").write_text(json.dumps(results))
send({"type": "done", "status": "completed"})
