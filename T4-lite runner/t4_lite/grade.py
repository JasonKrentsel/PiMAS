"""Map a verifier's native output onto the frozen check catalog."""
from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass

CTRF_STATUS = {"passed": "pass", "failed": "fail", "skipped": "skipped", "pending": "not_run", "other": "not_run"}
# Verifiers that fail a missing submission with one sentinel entry instead of reporting their catalog.
# With reward 0 that is a candidate failure: every check is not_run. Seen on real Docker, 2026-10-25.
BOOTSTRAP_FAILURES = {"ontology-kg-querying": "verifier_bootstrap"}


@dataclass(frozen=True)
class Grade:
    status: str
    reward: int | None
    checks: dict[str, str]
    health: dict[str, str]
    notes: str


def parse_reward(text: str) -> int | None:
    """Harbor reads reward.txt as a number (heat-pump writes `0.0`). Only exactly 0 or 1 is a binary reward."""
    try:
        value = float(text.strip())
    except ValueError:
        return None
    return int(value) if value in (0.0, 1.0) else None


def load_json(raw: bytes | None) -> dict | None:
    """A verifier JSON object, or None when absent, empty, malformed, or not an object."""
    if not raw:
        return None
    try:
        value = json.loads(raw.decode("utf-8-sig"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _from_trace(check: dict) -> bool:
    return check.get("unit") == "claim_case" or check.get("source") == "trace_results.json"


def _from_ctrf(check: dict) -> bool:
    return check.get("unit") != "composite_acceptance_test" and not _from_trace(check)


def _outcome(check: dict, groups: dict[str, list], trace: dict | None, reward: int | None) -> str | None:
    if check.get("unit") == "composite_acceptance_test":
        if reward not in (0, 1):
            return None
        return "pass" if reward == 1 else "fail"
    if _from_trace(check):
        case = ((trace or {}).get("cases") or {}).get(check["name"])
        if not isinstance(case, dict) or type(case.get("passed")) is not bool:
            return None
        return "pass" if case["passed"] else "fail"
    found = groups.get(check["name"], [])
    occurrence = int(check.get("occurrence") or 1)
    if len(found) < occurrence:
        return None
    return CTRF_STATUS.get(found[occurrence - 1].get("status"))


def map_grade(task: dict, *, reward: int | None, ctrf: dict | None, trace: dict | None) -> Grade:
    if reward is None:
        return Grade("error", None, {}, {}, "Verifier did not write a binary reward.txt")
    groups: dict[str, list] = {}
    for test in ((ctrf or {}).get("results") or {}).get("tests") or []:
        groups.setdefault(test.get("name"), []).append(test)
    sentinel = BOOTSTRAP_FAILURES.get(task["id"])
    if (reward == 0 and sentinel and list(groups) == [sentinel] and len(groups[sentinel]) == 1
            and groups[sentinel][0].get("status") == "failed"):
        return Grade("fail", 0, {c["id"]: "not_run" for c in task["checks"]},
                     {c["id"]: "not_run" for c in task["health_checks"]},
                     f"Verifier bootstrap failed the submission: {groups[sentinel][0].get('message', '')}".strip())
    checks = {c["id"]: _outcome(c, groups, trace, reward) for c in task["checks"]}
    health = {c["id"]: _outcome(c, groups, trace, reward) for c in task["health_checks"]}
    if None in checks.values() or None in health.values():
        return Grade("error", None, {k: v for k, v in checks.items() if v}, {k: v for k, v in health.items() if v},
                     "Verifier report is missing a cataloged check")
    # A CTRF test beyond the catalog (or a name repeated more often) means the verifier or catalog drifted.
    expected = Counter(c["name"] for c in [*task["checks"], *task["health_checks"]] if _from_ctrf(c))
    extra = sorted(str(name) for name, tests in groups.items() if expected and len(tests) > expected[name])
    if extra:
        return Grade("error", None, checks, health, "Verifier reported tests outside the catalog: " + ", ".join(extra))
    if any(value != "pass" for value in health.values()):
        return Grade("error", None, checks, health, "Verifier health check failed")
    return Grade("pass" if reward == 1 else "fail", reward, checks, health, "")
