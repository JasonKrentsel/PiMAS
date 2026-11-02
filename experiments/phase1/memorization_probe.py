"""Closed-book memorization probe: can the model write each task's fix from the issue text alone?

Usage: VLLM_API_KEY=... python3 -I memorization_probe.py <tasks.txt> <out-dir> [--port 18100] [--model qwen3.8-27b]

The model gets only the repository name and the issue text (no code, no tools) and is asked for the merged patch.
Recall is the share of the gold patch's added code lines that appear in the answer, leaving out lines already
quoted in the issue. High recall from the issue alone means the fix is likely memorized.
"""
import argparse
import concurrent.futures
import glob
import json
import os
import re
import urllib.request

PACKAGES = os.path.join(os.path.dirname(__file__), "../../.local/cache/harbor/tasks/packages/swe-bench")
PROMPT = """Below is a GitHub issue from the {repo} repository. You cannot see the code. From memory, write the
patch the maintainers merged to fix it, as a unified diff of the library source (not tests) with real file
paths. Output only the diff.

{issue}"""


def norm(line: str) -> str:
    return re.sub(r"\s+", "", line)


def gold_lines(solve: str) -> tuple[list[str], set[str]]:
    patch = solve.split("<<", 1)[-1]
    files = set(re.findall(r"^\+\+\+ b/(\S+)", patch, re.M))
    added = [l[1:].strip() for l in patch.splitlines() if l.startswith("+") and not l.startswith("+++")]
    code = [l for l in added if len(norm(l)) >= 8 and not l.startswith(("#", '"""', "'''"))]
    return code, files


def ask(port: int, model: str, prompt: str) -> str:
    body = {"model": model, "temperature": 0, "max_tokens": 4096, "messages": [{"role": "user", "content": prompt}],
            "chat_template_kwargs": {"enable_thinking": False}}
    request = urllib.request.Request(f"http://127.0.0.1:{port}/v1/chat/completions", json.dumps(body).encode(),
                                     {"Content-Type": "application/json", "Authorization": f"Bearer {os.environ['VLLM_API_KEY']}"})
    with urllib.request.urlopen(request, timeout=900) as response:
        return json.load(response)["choices"][0]["message"]["content"] or ""


def probe(task: str, port: int, model: str) -> dict:
    root = glob.glob(f"{PACKAGES}/{task}/*/")[0]
    issue = open(f"{root}/instruction.md").read()
    code, files = gold_lines(open(f"{root}/solution/solve.sh").read())
    in_issue = norm(issue)
    novel = [l for l in code if norm(l) not in in_issue]
    answer = ask(port, model, PROMPT.format(repo=task.split("__")[0], issue=issue))
    said = {norm(l.lstrip("+-")) for l in answer.splitlines()}
    hits = [l for l in novel if norm(l) in said]
    return {"task": task, "gold_files": sorted(files), "file_named": any(f in answer for f in files),
            "novel_lines": len(novel), "recalled": len(hits), "recall": round(len(hits) / len(novel), 2) if novel else None,
            "recalled_lines": hits, "answer": answer}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("tasks"); parser.add_argument("out")
    parser.add_argument("--port", type=int, default=18100); parser.add_argument("--model", default="qwen3.8-27b")
    args = parser.parse_args()
    tasks = [t.strip().split("/")[-1] for t in open(args.tasks) if t.strip()]
    os.makedirs(args.out, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        rows = list(pool.map(lambda t: probe(t, args.port, args.model), tasks))
    json.dump(rows, open(f"{args.out}/probe.json", "w"), indent=1)
    print(f"{'task':38} file  recall")
    for r in rows:
        print(f"{r['task']:38} {'yes' if r['file_named'] else 'no ':4}  {r['recalled']}/{r['novel_lines']}")
    full = [r for r in rows if r["recall"] is not None]
    print(f"file named {sum(r['file_named'] for r in rows)}/{len(rows)}; mean recall {sum(r['recall'] for r in full) / len(full):.2f}; "
          f"tasks with recall >= 0.5: {sum(r['recall'] >= 0.5 for r in full)}/{len(full)}")


if __name__ == "__main__":
    main()
