"""Count tool calls that reached the network, per trial and stage.
"upstream" = GitHub or git fetch/clone (can reveal the real fix); "other" = pip, curl, wget, urllib, requests.
Usage: python3 -I network-use.py <job-dir> [out.csv]"""
import collections, csv, json, pathlib, re, sys

NET = re.compile(r"github\.com|githubusercontent|api\.github|pypi\.org|pip (install|download)|curl |wget |urllib\.request|requests\.get|git (fetch|clone|remote)", re.I)
UPSTREAM = re.compile(r"github\.com|githubusercontent|api\.github|git (fetch|clone)", re.I)

job = pathlib.Path(sys.argv[1])
counts = collections.defaultdict(collections.Counter)
for f in sorted(job.glob("*/agent/pimas/tool-calls.jsonl")):
    trial = f.parts[-4]
    for line in f.read_text().splitlines():
        call = json.loads(line)
        args = json.dumps(call["args"])
        if NET.search(args):
            counts[trial][(call["stageId"], "upstream" if UPSTREAM.search(args) else "other")] += 1
upstream = [t for t, c in counts.items() if any(kind == "upstream" for _, kind in c)]
print(f"{len(counts)} trials made network calls; {len(upstream)} contacted GitHub")
for trial, c in counts.items():
    print(trial, {f"{stage}:{kind}": n for (stage, kind), n in sorted(c.items())})
if len(sys.argv) > 2:
    with open(sys.argv[2], "w", newline="") as out:
        w = csv.writer(out)
        w.writerow(["trial", "stage", "kind", "calls"])
        for trial, c in counts.items():
            for (stage, kind), n in sorted(c.items()):
                w.writerow([trial, stage, kind, n])
