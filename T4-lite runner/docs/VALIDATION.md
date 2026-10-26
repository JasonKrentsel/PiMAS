# Validation

Validated on Windows with Python 3.11+ compatible source.

- `python -m unittest discover -s tests -v`: 79 tests passed. The Docker preflight tests inject a fake daemon check, so the suite does not need a running Docker engine.
- `python -m t4_lite verify`: 24 task packages and all 705 package files verified.
- `python -m t4_lite list`: 24 tasks, 333 solution checks.
- `python -m t4_lite pilot`: historical 7/24 task passes and 254/333 solution checks.
- Markdown local links and code fences checked.
- No populated API-key or Authorization fields found in copied pilot JSON evidence.
- Real Docker sweep, 2026-10-25 (Docker 29.9.2, Windows): all 24 tasks run with a stub harness that sends fixed probe commands and no solution. All 61 images pulled and started, including the three compose stacks. The harness probes passed on every task (cwd `/app`, exit codes, separate stdout/stderr, harness environment absent from the container, no Docker socket, timeout clamping and kill, background commands). 23 tasks recorded a clean `fail`; `live-database-cutover` records `error` by decision (its verifier fails a do-nothing agent before running checks). No containers, networks, or volumes were left behind. The sweep found and fixed three runner bugs: `0.0` rewards rejected, ontology's bootstrap report, and a root-only `/logs/verifier`.
- A do-nothing agent passes 44 of 333 solution checks (13.2%) across bun-sourcemap-leak, cargo-flight-dispatch, uefi-bootkit, distributed-dedup, coq-block-bound, mvcc-lsm-compaction, payments-pipeline-fix, and vllm-deepseek-streaming. Read the verification-check rate against that floor.
- Known resource deviation: `payments-pipeline-fix` is 4 CPU / 8192 MB in `task.toml` and 6 CPU / 12288 MB in the frozen manifest. The runner applies the manifest (6 CPU / 12288 MB). That difference is not silently corrected, and the manifest was not changed.

Tests cover selection reproducibility, parameterized case identity, health exclusions, no double-counting of React tests, fixed denominators, incomplete/error runs, CLI JSON/CSV behavior, native reward preservation, run/version/profile binding, immutable concurrent result commits, interrupted staging, evidence/result changes, duplicate JSON keys, path traversal, and the `run` execution backend (harness protocol, declared-artifact copy, committed task errors, verifier floor, and per-command cap).

This validates benchmark definitions, bookkeeping, and the runner that executes a harness. It is not a new Harbor/Pi/model evaluation. The bundled task images were not executed again in this check. A live Docker run still needs its own environment, isolation, and image preflight.
