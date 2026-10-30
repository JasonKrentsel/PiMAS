"""Per-trial CSV and per-task summary for a PiMAS SWE-bench Harbor job.
Usage: python3 -I report.py <job-dir> <out.csv>"""
import csv, json, pathlib, statistics as st, sys
from datetime import datetime
from collections import defaultdict

job, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
def t(s): return datetime.fromisoformat(s.replace("Z", "+00:00"))
rows = []
for d in sorted(p for p in job.iterdir() if p.is_dir() and "__" in p.name):
    r = json.loads((d / "result.json").read_text())
    task = d.name.rsplit("__", 1)[0]
    rew = (r.get("verifier_result") or {}).get("rewards", {}).get("reward")
    ex = (r.get("exception_info") or {}).get("exception_type", "")
    ae = r.get("agent_execution") or {}
    agent_s = (t(ae["finished_at"]) - t(ae["started_at"])).total_seconds() if ae.get("finished_at") else None
    total_s = (t(r["finished_at"]) - t(r["started_at"])).total_seconds()
    row = dict(trial=d.name, task=task, reward=rew, exception=ex, agent_min=round(agent_s / 60, 1) if agent_s else None,
               total_min=round(total_s / 60, 1))
    sp = d / "agent/pimas/summary.json"
    stages, tools, out_tok, in_tok, cache_tok, track_ms, steps, patch_b = [], 0, 0, 0, 0, 0, 0, None
    if sp.exists():
        s = json.loads(sp.read_text())
        row["pipeline_status"] = s.get("status")
        for a in s["artifacts"]:
            stages.append(f'{a["stage"]}:{a["status"]}')
            tools += len(a["toolCalls"])
            u = a["usage"]; out_tok += u["output"]; in_tok += u["input"]; cache_tok += u["cacheRead"]
            track_ms += ((a.get("fileChanges") or {}).get("overheadMs") or 0)
            if a["stage"] == "plan" and isinstance(a["content"], dict):
                steps = len(a["content"].get("steps", []))
            if a.get("workspacePatch"): patch_b = a["workspacePatch"]["bytes"]
    else:
        # killed before summary: count from provenance
        pv = d / "agent/pimas/provenance.jsonl"
        row["pipeline_status"] = "no-summary"
        if pv.exists():
            for line in pv.read_text().splitlines():
                e = json.loads(line)
                if e["type"] == "tool_call": tools += 1
                if e["type"] == "stage_end":
                    a = e["artifact"]; stages.append(f'{a["stage"]}:{a["status"]}')
                    u = a["usage"]; out_tok += u["output"]; in_tok += u["input"]; cache_tok += u["cacheRead"]
                    track_ms += ((a.get("fileChanges") or {}).get("overheadMs") or 0)
    row.update(stages=" ".join(stages), tool_calls=tools, out_tok=out_tok, in_tok=in_tok, cache_tok=cache_tok,
               plan_steps=steps, track_s=round(track_ms / 1000, 1), patch_bytes=patch_b,
               track_pct=round(100 * track_ms / 1000 / agent_s, 2) if agent_s else None)
    rp = d / "verifier/report.json"
    if rp.exists():
        ts = next(iter(json.loads(rp.read_text()).values()))["tests_status"]
        row["f2p_fail"] = len(ts["FAIL_TO_PASS"]["failure"]); row["p2p_fail"] = len(ts["PASS_TO_PASS"]["failure"])
        row["p2p_total"] = len(ts["PASS_TO_PASS"]["failure"]) + len(ts["PASS_TO_PASS"]["success"])
    rows.append(row)

keys = list(dict.fromkeys(k for r in rows for k in r))
with out.open("w", newline="") as f:
    w = csv.DictWriter(f, keys); w.writeheader(); w.writerows(rows)

by = defaultdict(list)
for r in rows: by[r["task"]].append(r)
print(f'{"task":40} pass  agent_min(med)  out_tok(med)  tools(med) steps')
for task, rs in sorted(by.items(), key=lambda kv: (sum((x["reward"] or 0) for x in kv[1]), kv[0])):
    p = sum(1 for x in rs if x["reward"] == 1)
    print(f'{task:40} {p}/{len(rs)}  {st.median(x["agent_min"] for x in rs):6.1f}        {st.median(x["out_tok"] for x in rs):8.0f}     {st.median(x["tool_calls"] for x in rs):5.0f}   {"/".join(str(x["plan_steps"]) for x in rs)}')
def q(k):
    v = sorted(x[k] for x in rows if x.get(k) is not None)
    if not v: return "n/a"
    return f'median {st.median(v)} p90 {v[int(.9*len(v))-1]} max {v[-1]} sum {round(sum(v),1)}'
print()
print("pass", sum(1 for x in rows if x["reward"] == 1), "/", len(rows))
for k in ("agent_min", "total_min", "out_tok", "in_tok", "cache_tok", "tool_calls", "track_s", "track_pct", "patch_bytes"): print(k, q(k))
print("exceptions", [(x["trial"], x["exception"]) for x in rows if x["exception"]])
print("p2p regressions", [(x["trial"], x["p2p_fail"]) for x in rows if x.get("p2p_fail")])
print("f2p misses", [(x["trial"], x["f2p_fail"]) for x in rows if x.get("f2p_fail")])
print("non-submitted stages", [(x["trial"], x["stages"]) for x in rows if "submitted" not in x["stages"] or x["stages"].count("submitted") < 3])
