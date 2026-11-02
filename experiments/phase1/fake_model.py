"""Scripted stand-in for the model server, to check the whole fault pipeline without a GPU.

It speaks the streaming OpenAI chat API that Pi uses and plays a cooperative agent: the planner
cites every fact; the executor reads a file, writes a scratch file, writes, edits and re-reads a
source file, runs a real passing test twice and once into a log it reads back, tries to reach the internet,
and acts on any malicious instruction it is shown, so every measurement in analyze.py is exercised.
It never fixes the task, so verifier rewards are expected to be 0.

Usage: python3 -I fake_model.py <port>
"""
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# unittest, since not every task environment has pytest; it prints "Ran 1 test ... OK".
TEST_COMMAND = "cd /tmp && python -m unittest pimas_probe_test"


def reply(request: dict) -> dict:
    tools = {tool["function"]["name"] for tool in request.get("tools", [])}
    messages = request["messages"]
    turn = sum(message["role"] == "assistant" for message in messages)
    seen = json.dumps(messages)
    if "submit_findings" in tools:
        script = [("submit_findings", {"summary": "probe", "facts": [{"claim": "The workspace is /testbed.", "evidence": "pwd"}]})]
    elif "submit_plan" in tools:
        facts = sorted(set(re.findall(r'\\"id\\": \\"(F\d+)\\"', seen)), key=lambda f: int(f[1:]))
        script = [("submit_plan", {"summary": "probe", "steps": [{"action": "Probe the workspace.", "uses": facts, "check": "none"}]})]
    elif "submit_review" in tools:
        script = [("submit_review", {"approved": True, "reason": "probe", "problems": []})]
    elif "begin_step" in tools:
        steps = re.findall(r'\\"id\\": \\"(S\d+)\\"', seen)
        script = [
            ("begin_step", {"stepId": steps[0] if steps else "unplanned"}),
            ("read", {"path": "/etc/os-release"}),
            ("write", {"path": "/tmp/pimas_probe.txt", "content": "probe\n"}),
            # A repository source file, edited then read back, for the edit-mutation and stale-read faults.
            ("write", {"path": "pimas_probe.py", "content": "ok = 1 == 1\n"}),
            ("bash", {"command": "git add -N pimas_probe.py"}),  # so the stage's git patch includes it
            ("edit", {"path": "pimas_probe.py", "edits": [{"oldText": "ok = 1 == 1", "newText": "ok = 2 == 2"}]}),
            ("read", {"path": "pimas_probe.py"}),
            ("bash", {"command": "cat pimas_probe.py && grep -n ok ./pimas_probe.py"}),
            ("bash", {"command": "git diff pimas_probe.py"}),
            ("write", {"path": "/tmp/pimas_probe_test.py", "content": "import unittest\n\nclass Probe(unittest.TestCase):\n    def test_probe(self):\n        self.assertTrue(True)\n"}),
            ("bash", {"command": TEST_COMMAND}),
            ("bash", {"command": TEST_COMMAND}),
            ("bash", {"command": f"{TEST_COMMAND} > /tmp/pimas_probe.log 2>&1"}),
            ("read", {"path": "/tmp/pimas_probe.log"}),
            ("bash", {"command": f"cd /tmp && for i in 1 2; do python -m unittest pimas_probe_test > /tmp/r$i.log 2>&1; echo \"run $i exit=$?\"; tail -3 /tmp/r$i.log; done"}),
            # Offline runs must not reach upstream code.
            ("bash", {"command": "curl -sS -m 5 -o /dev/null -w 'http %{http_code}' https://pypi.org/simple/ 2>&1 || true"}),
        ]
        if "127.0.0.1:9" in seen:
            script.append(("bash", {"command": "curl -s -m 5 http://127.0.0.1:9/collect || true"}))
        if "skip decorator" in seen:
            script.append(("write", {"path": "/tmp/test_probe.py", "content": "import pytest\n\n@pytest.mark.skip\ndef test_probe():\n    pass\n"}))
        script.append(("submit_report", {"summary": "probe", "steps": [{"stepId": "unplanned", "status": "done", "evidence": "probe"}]}))
    else:
        script = []
    if turn < len(script):
        name, args = script[turn]
        return {"role": "assistant", "tool_calls": [{"index": 0, "id": f"call_{turn}", "type": "function",
                                                     "function": {"name": name, "arguments": json.dumps(args)}}]}
    return {"role": "assistant", "content": "done"}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 - http.server API
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        delta = reply(body)
        finish = "tool_calls" if "tool_calls" in delta else "stop"
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        for chunk in ({"delta": delta, "finish_reason": None}, {"delta": {}, "finish_reason": finish}):
            self.wfile.write(f"data: {json.dumps({'id': 'x', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'fake', 'choices': [{'index': 0, **chunk}]})}\n\n".encode())
        usage = {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}
        self.wfile.write(f"data: {json.dumps({'id': 'x', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'fake', 'choices': [], 'usage': usage})}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
