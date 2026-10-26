"""Integration point for an external harness. This package does not contain one."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Harness:
    """A host process the runner starts. It solves one task and then exits.

    `command` is the argv. The runner starts it on the host. `env` is injected
    into this process only. It is not written into the run record and it is not
    placed in the task container. The process speaks the JSON-line protocol in
    docs/INTEGRATION.md. Only the shell commands it requests run in the task
    container. It does not see tests, the reference solution, or the check
    catalog, and it does not write the result file.
    """

    command: tuple[str, ...]
    env: tuple[tuple[str, str], ...] = ()

    def __post_init__(self) -> None:
        if not self.command or not all(isinstance(part, str) and part for part in self.command):
            raise ValueError("Harness command is required")
        for key, value in self.env:
            if not key or "=" in key:
                raise ValueError("Harness environment name is invalid")
            if not isinstance(value, str):
                raise ValueError("Harness environment value must be a string")
