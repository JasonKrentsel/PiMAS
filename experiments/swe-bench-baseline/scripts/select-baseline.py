"""Pick clean-baseline tasks from the pilot with the rule fixed before the pilot ran:
pilot passes (oracle already passed), non-Django first, then Django, each in pilot-list order, up to 20.
Usage: python3 -I select-baseline.py <pilot-job-dir> <pilot-task-list> <output>"""
import pathlib
import sys

job, task_list, output = map(pathlib.Path, sys.argv[1:])
passed = set()
for reward in job.glob("*/verifier/reward.txt"):
    if reward.read_text().strip() == "1":
        passed.add(reward.parent.parent.name.rsplit("__", 1)[0])
order = [line.strip() for line in task_list.read_text().splitlines() if line.strip()]
chosen = [t for t in order if t in passed and not t.startswith("django__")]
chosen += [t for t in order if t in passed and t.startswith("django__")]
chosen = chosen[:20]
output.write_text("\n".join(chosen) + "\n")
print(f"{len(passed)} pilot passes; chose {len(chosen)}")
print("\n".join(chosen))
