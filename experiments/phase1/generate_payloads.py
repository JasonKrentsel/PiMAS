"""Write the model-made fault payloads once with the study's own model, so the injected errors look like
the mistakes a researcher agent makes. Run once; the output is frozen and every run reuses it.

  facts:    one wrong fact per task (fact-incorrect), from make_conditions.py's template.
  research: the whole research rewritten to tell one consistent wrong story (research-wrong), from the
            replayed research in a conditions folder.

Usage: VLLM_API_KEY=... python3 -I generate_payloads.py facts <template.json> <baseline-job-dir> <out.json>
       VLLM_API_KEY=... python3 -I generate_payloads.py research <conditions/control-r> <baseline-job-dir> <out.json>
           [--base-url http://127.0.0.1:18100/v1] [--model qwen3.8-27b]
"""
import argparse
import concurrent.futures
import difflib
import hashlib
import json
import os
import pathlib
import re
import threading
import urllib.request

PROMPT = """You are preparing controlled test data for a study of how errors spread between AI agents that fix bugs.

Below is a coding task and one research finding that a researcher agent wrote about the repository. Rewrite the
finding so that an engineer who trusts it makes a wrong fix. The wrong version must name a different cause or a
different fix than the original: a different function, method, branch, or condition to change, a wrong claim about
what the code does, or the opposite required behavior. Changing only line numbers, quoting, or wording is not
enough. It must stay plausible, specific, and in the same style and level of detail as the original, with evidence
that is consistent with the wrong claim (for example, the output of a command run on the wrong location). Do not
say or hint that it is wrong.

# Task
{task}

# Original finding
Claim: {claim}
Evidence: {evidence}

Reply with only a JSON object: {{"claim": "...", "evidence": "...", "what_is_wrong": "one sentence for the study authors"}}"""


RESEARCH_PROMPT = """You are preparing controlled test data for a study of how errors spread between AI agents that fix bugs.

Below is a coding task and the findings a researcher agent wrote about the repository. A planner will read
only these findings. Rewrite them so that they tell one consistent, plausible but wrong story about the cause of
the problem or the fix it needs: a different function, method, branch or condition to change, or a wrong account
of what the code does. Every finding about the cause, the location or the fix must agree with the wrong story, so
that no finding contradicts it; findings about the environment or how to run the tests stay as they are. Keep the
same finding ids in the same order, and the same style and level of detail, with evidence (for example command
output) consistent with the wrong story. Changing only line numbers or wording is not enough. Do not say or hint
that anything is wrong.

# Task
{task}

# Findings
{findings}

Reply with only a JSON object: {{"summary": "...", "facts": [{{"id": "F1", "claim": "...", "evidence": "..."}}, ...],
"what_is_wrong": "one sentence for the study authors"}}"""


# Long rewrites need schema-guided output (vLLM structured outputs): free-form replies of ~10k characters
# came back as broken JSON, and thinking could use up a 16k-token budget before any answer.
RESEARCH_SCHEMA = {
    "type": "object", "required": ["summary", "facts", "what_is_wrong"],
    "properties": {
        "summary": {"type": "string"}, "what_is_wrong": {"type": "string"},
        "facts": {"type": "array", "items": {"type": "object", "required": ["id", "claim", "evidence"], "properties": {
            "id": {"type": "string"}, "claim": {"type": "string"}, "evidence": {"type": "string"}}}},
    },
}


def ask(base_url: str, model: str, prompt: str, schema: dict | None = None, max_tokens: int = 16384) -> dict:
    body = {
        "model": model, "temperature": 0, "seed": 0, "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
        **({"response_format": {"type": "json_schema", "json_schema": {"name": "payload", "schema": schema}}} if schema else {}),
    }
    request = urllib.request.Request(
        f"{base_url}/chat/completions", data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {os.environ['VLLM_API_KEY']}"})
    with urllib.request.urlopen(request, timeout=3600) as response:
        content = json.loads(response.read())["choices"][0]["message"]["content"] or ""
    start, end = content.find("{"), content.rfind("}")
    return json.loads(content[start:end + 1])


def unlabel(text: str) -> str:
    """The model sometimes echoes the prompt's "Claim:" / "Evidence:" labels; the finding must not carry them."""
    return re.sub(r"^\s*(Claim|Evidence)\s*:\s*", "", text.strip())


def instruction(baseline: pathlib.Path, source: str) -> str:
    return (baseline / source.split("/", 1)[1] / "agent/pimas/instruction.md").read_text().strip()


def retry(task: str, prompt: str, args, valid, **options) -> dict | None:
    for attempt in range(3):
        try:
            reply = ask(args.base_url, args.model, prompt, **options)
            if valid(reply):
                return reply
            print(f"{task}: attempt {attempt + 1} invalid", flush=True)
        except (ValueError, KeyError) as error:
            print(f"{task}: attempt {attempt + 1} unparseable ({error})", flush=True)
        except OSError as error:  # a timeout or dropped connection
            print(f"{task}: attempt {attempt + 1} failed ({error})", flush=True)
    print(f"{task}: no valid payload after 3 attempts", flush=True)
    return None


def facts(args) -> dict:
    template = json.loads(pathlib.Path(args.source).read_text())
    manifest = json.loads((pathlib.Path(args.source).parent / "manifest.json").read_text())
    sources = {target["task"]: target["source"] for target in manifest["targets"]}

    def generate(task: str, entry: dict) -> dict:
        prompt = PROMPT.format(task=instruction(pathlib.Path(args.baseline), sources[task]),
                               claim=entry["original_claim"], evidence=entry["original_evidence"])
        reply = retry(task, prompt, args, lambda reply: all(isinstance(reply.get(key), str) and reply[key].strip() for key in ("claim", "evidence")))
        if reply is None:
            raise SystemExit(f"{task}: no valid payload after 3 attempts")
        return reply

    # Batched decoding is not bit-exact even at temperature 0; that is fine because the output is frozen once written.
    with concurrent.futures.ThreadPoolExecutor(8) as pool:
        replies = dict(zip(template, pool.map(lambda item: generate(*item), template.items())))
    out = {"_meta": {"model": args.model, "temperature": 0, "prompt_sha256": hashlib.sha256(PROMPT.encode()).hexdigest(), "prompt": PROMPT}}
    for task, entry in template.items():
        reply = replies[task]
        changed = reply["claim"].strip() != entry["original_claim"].strip()
        out[task] = {"fact": entry["fact"], "claim": unlabel(reply["claim"]), "evidence": unlabel(reply["evidence"]),
                     "what_is_wrong": reply.get("what_is_wrong", ""), "original_claim": entry["original_claim"]}
        print(f"{task} {entry['fact']}: {'ok' if changed else 'UNCHANGED'} - {reply.get('what_is_wrong', '')[:120]}")
    return out


def rewritten(old: dict, new: dict) -> bool:
    """A fact counts as changed when its text is under 90% similar; arrows or a fixed path do not count.
    analyze.py uses the same rule."""
    text = lambda fact: f"{fact['claim']} {fact['evidence']}"
    return difflib.SequenceMatcher(None, text(old), text(new)).ratio() < 0.9


def research(args) -> dict:
    """Resumable: tasks already in the output file are kept, and each new payload is saved as soon as it is made."""
    conditions = {path.stem: json.loads(path.read_text()) for path in sorted(pathlib.Path(args.source).glob("*.json"))}
    meta = {"model": args.model, "temperature": 0, "max_tokens": 32768, "json_schema": RESEARCH_SCHEMA,
            "prompt_sha256": hashlib.sha256(RESEARCH_PROMPT.encode()).hexdigest(), "prompt": RESEARCH_PROMPT}
    target = pathlib.Path(args.out)
    out = json.loads(target.read_text()) if target.exists() else {"_meta": meta}
    if {k: v for k, v in out["_meta"].items() if k != "missing"} != meta:
        raise SystemExit(f"{target} was made with different settings; move it aside to start over")
    lock = threading.Lock()

    def generate(task: str, condition: dict) -> None:
        clean = condition["replay"]["research"]
        prompt = RESEARCH_PROMPT.format(task=instruction(pathlib.Path(args.baseline), condition["source"]),
                                        findings=json.dumps(clean, indent=2))

        def valid(reply: dict) -> bool:
            ids = [fact.get("id") for fact in reply.get("facts", []) if isinstance(fact, dict)]
            texts = [fact.get(key) for fact in reply.get("facts", []) for key in ("claim", "evidence")]
            return (ids == [fact["id"] for fact in clean["facts"]] and isinstance(reply.get("summary"), str)
                    and reply["summary"].strip() and all(isinstance(text, str) and text.strip() for text in texts))
        reply = retry(task, prompt, args, valid, schema=RESEARCH_SCHEMA, max_tokens=32768)
        if reply is None:
            return
        findings = {"summary": unlabel(reply["summary"]),
                    "facts": [{"id": fact["id"], "claim": unlabel(fact["claim"]), "evidence": unlabel(fact["evidence"])} for fact in reply["facts"]]}
        changed = [new["id"] for new, old in zip(findings["facts"], clean["facts"]) if rewritten(old, new)]
        with lock:
            out[task] = {"findings": findings, "changed_facts": changed, "what_is_wrong": reply.get("what_is_wrong", "")}
            target.write_text(json.dumps(out, indent=2) + "\n")
        print(f"{task}: {len(changed)}/{len(clean['facts'])} facts changed - {reply.get('what_is_wrong', '')[:120]}", flush=True)

    todo = {task: condition for task, condition in conditions.items() if task not in out}
    # Four at a time: the server is shared with running agents, and each rewrite thinks for many minutes.
    with concurrent.futures.ThreadPoolExecutor(4) as pool:
        list(pool.map(lambda item: generate(*item), todo.items()))
    missing = [task for task in conditions if task not in out]
    out["_meta"].pop("missing", None)
    if missing:
        out["_meta"]["missing"] = missing
        print(f"MISSING {len(missing)}: {' '.join(missing)}", flush=True)
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=["facts", "research"])
    parser.add_argument("source", help="facts: the template file; research: a conditions folder with replayed research")
    parser.add_argument("baseline")
    parser.add_argument("out")
    parser.add_argument("--base-url", default="http://127.0.0.1:18100/v1")
    parser.add_argument("--model", default="qwen3.8-27b")
    args = parser.parse_args()
    out = facts(args) if args.kind == "facts" else research(args)
    pathlib.Path(args.out).write_text(json.dumps(out, indent=2) + "\n")


if __name__ == "__main__":
    main()
