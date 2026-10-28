"""Per-trial records that cannot be rebuilt after the trial: code/config identity and filesystem state.

Files written under the trial's ``agent/pimas/`` folder:

    run-info.json              versions, git commit, settings, config hashes, timings, filesystem summary
    config/models.json         the provider file used, with credential values redacted
    config/agents.json         the role profiles used
    config/prompts/<role>.md   each role's system prompt as used
    filesystem/before.tsv.gz   container manifest before the agent ran (path, mtime, size, mode)
    filesystem/after.tsv.gz    container manifest after the agent stopped
    filesystem/changes.tsv.gz  C/M/D lines: created, modified, deleted paths
"""

from __future__ import annotations

import hashlib
import json
import platform
import shlex
import socket
import subprocess
import sys
from datetime import datetime, timezone
from importlib import metadata
from pathlib import Path
from typing import Any

# Keep in sync with manifestCommand/diffCommand in PiMAS/src/filesystem.ts.
SNAPSHOT_DIR = "/tmp/.pimas"
PRUNED = ["/proc", "/sys", "/dev", "/run", "/logs", SNAPSHOT_DIR]
PERL_STAT = 'chomp; my @s = lstat($_) or next; printf "%s\\t%d\\t%d\\t%o\\n", $_, $s[9], $s[7], $s[2] & 07777'
SCAN_TIMEOUT_SECONDS = 600


def manifest_command(root: str, output: str) -> str:
    prune = "\\( " + " -o ".join(f"-path {shlex.quote(entry)}" for entry in PRUNED) + " \\) -prune -o"
    select = f"{shlex.quote(root)} {prune} \\( -type f -o -type l \\)"
    return (
        f"mkdir -p {shlex.quote(SNAPSHOT_DIR)} && if find / -maxdepth 0 -printf '' >/dev/null 2>&1; "
        f"then find {select} -printf '%p\\t%T@\\t%s\\t%m\\n'; "
        f"else find {select} -print | perl -ne {shlex.quote(PERL_STAT)}; fi > {shlex.quote(output)} 2>/dev/null; true"
    )


def diff_command(before: str, after: str, output: str) -> str:
    awk = (
        'NR==FNR { seen[$1] = $0; next } { if (!($1 in seen)) print "C\\t" $1; '
        'else if (seen[$1] != $0) print "M\\t" $1; delete seen[$1] } END { for (path in seen) print "D\\t" path }'
    )
    return f"awk -F '\\t' {shlex.quote(awk)} {shlex.quote(before)} {shlex.quote(after)} | LC_ALL=C sort > {shlex.quote(output)}"


def sha256_file(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def _git(root: Path, *args: str) -> str | None:
    try:
        result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def _version(command: list[str]) -> str | None:
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() or None


def _package_version(package_json: Path) -> str | None:
    try:
        return json.loads(package_json.read_text())["version"]
    except (OSError, ValueError, KeyError):
        return None


def redact_models(config: Any) -> Any:
    """Drop literal credentials; environment references such as "$OPENAI_API_KEY" are kept."""
    if isinstance(config, dict):
        redacted = {}
        for key, value in config.items():
            if key in ("apiKey", "headers") and not (isinstance(value, str) and value.startswith("$")):
                redacted[key] = "<redacted>" if value not in (None, "", "unused") else value
            else:
                redacted[key] = redact_models(value)
        return redacted
    if isinstance(config, list):
        return [redact_models(item) for item in config]
    return config


def snapshot_config(state: Path, models: Path, agents: Path) -> dict[str, Any]:
    """Copy the configuration actually used into the trial folder and return its hashes."""
    target = state / "config"
    (target / "prompts").mkdir(parents=True, exist_ok=True)
    record: dict[str, Any] = {
        "models": {"path": str(models), "sha256": sha256_file(models)},
        "agents": {"path": str(agents), "sha256": sha256_file(agents)},
        "prompts": {},
    }
    try:
        (target / "models.json").write_text(json.dumps(redact_models(json.loads(models.read_text())), indent=2) + "\n")
    except (OSError, ValueError) as error:
        record["models"]["copy_error"] = str(error)
    try:
        roles = json.loads(agents.read_text())["roles"]
        (target / "agents.json").write_text(json.dumps({"roles": roles}, indent=2) + "\n")
        for role, profile in roles.items():
            prompt = (agents.parent / profile["systemPrompt"]).resolve()
            record["prompts"][role] = {"path": str(prompt), "sha256": sha256_file(prompt)}
            if prompt.exists():
                (target / "prompts" / f"{role}.md").write_bytes(prompt.read_bytes())
    except (OSError, ValueError, KeyError) as error:
        record["agents"]["copy_error"] = str(error)
    return record


def code_identity(pimas_root: Path) -> dict[str, Any]:
    repo = pimas_root.parent
    status = _git(repo, "status", "--porcelain")
    try:
        harbor_version = metadata.version("harbor")
    except metadata.PackageNotFoundError:
        harbor_version = None
    return {
        "git_commit": _git(repo, "rev-parse", "HEAD"),
        "git_branch": _git(repo, "rev-parse", "--abbrev-ref", "HEAD"),
        # Uncommitted changes mean the commit alone does not identify the code that ran.
        "git_dirty": None if status is None else bool(status),
        "git_dirty_files": None if not status else status.splitlines(),
        "pimas_root": str(pimas_root),
        "pi_coding_agent_version": _package_version(pimas_root / "node_modules/@earendil-works/pi-coding-agent/package.json"),
        "harbor_version": harbor_version,
        "python_version": sys.version.split()[0],
        "host": socket.gethostname(),
        "platform": platform.platform(),
    }


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


class RunFilesystem:
    """Before/after manifests of the whole container, kept on the host after the container is gone."""

    def __init__(self, environment: Any, state: Path, root: str = "/"):
        self.environment = environment
        self.root = root
        self.directory = state / "filesystem"
        self.before = f"{SNAPSHOT_DIR}/harbor-run-before.tsv"
        self.after = f"{SNAPSHOT_DIR}/harbor-run-after.tsv"
        self.changes = f"{SNAPSHOT_DIR}/harbor-run-changes.tsv"

    async def _exec(self, command: str) -> Any:
        return await self.environment.exec(command, timeout_sec=SCAN_TIMEOUT_SECONDS)

    async def start(self) -> dict[str, Any]:
        started = datetime.now(timezone.utc)
        result = await self._exec(manifest_command(self.root, self.before))
        return {"ok": result.return_code == 0, "scan_seconds": (datetime.now(timezone.utc) - started).total_seconds()}

    async def finish(self) -> dict[str, Any]:
        started = datetime.now(timezone.utc)
        summary: dict[str, Any] = {}
        result = await self._exec(
            f"{manifest_command(self.root, self.after)} && {diff_command(self.before, self.after, self.changes)} && "
            f"for kind in C M D; do grep -c \"^$kind\" {shlex.quote(self.changes)} || true; done"
        )
        counts = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
        if result.return_code == 0 and len(counts) == 3:
            summary.update(created=int(counts[0]), modified=int(counts[1]), deleted=int(counts[2]))
        summary["scan_seconds"] = (datetime.now(timezone.utc) - started).total_seconds()
        self.directory.mkdir(parents=True, exist_ok=True)
        summary["files"] = {}
        for name, source in (("before", self.before), ("after", self.after), ("changes", self.changes)):
            summary["files"][name] = await self._download(source, name)
        await self._exec(f"rm -f {shlex.quote(self.before)} {shlex.quote(self.after)} {shlex.quote(self.changes)}")
        return summary

    async def _download(self, source: str, name: str) -> str | None:
        """Gzip in the container when possible; fall back to the raw file."""
        compressed = (await self._exec(f"gzip -c {shlex.quote(source)} > {shlex.quote(source)}.gz")).return_code == 0
        target = self.directory / (f"{name}.tsv.gz" if compressed else f"{name}.tsv")
        try:
            await self.environment.download_file(f"{source}.gz" if compressed else source, target)
        except Exception as error:  # noqa: BLE001 - a missing manifest must not fail the trial
            return f"download failed: {type(error).__name__}: {error}"
        finally:
            if compressed:
                await self._exec(f"rm -f {shlex.quote(source)}.gz")
        return target.name


def write_run_info(state: Path, info: dict[str, Any]) -> None:
    (state / "run-info.json").write_text(json.dumps(info, indent=2, default=str) + "\n")
