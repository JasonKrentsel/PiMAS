# Readable Multi-Agent Research Baseline

## Goal and boundary

Build an understandable TypeScript system using Pi Agent 1.4.0: an LLM orchestrator leads planning, execution, review, and correction. Success includes parallel workers, live questions, honest outcomes, and continuing an interrupted run from saved local state.

Replace the prototype's pi-durable runtime, dependency scheduler, and mailbox framework. Retain a basic terminal interface and OpenAI-compatible configuration where practical. Removing pi-durable does **not** remove persistence. Fault injection, benchmarking infrastructure, recovery plugins, distributed execution, sandboxing, rich UI, exactly-once tool execution, and rollback are excluded.

## Workflow and permissions

The orchestrator reads/searches the project and outlines high-level work. Planning agents inspect and propose detailed assignments. The orchestrator reviews their reports, records a consolidated plan with interfaces and acceptance criteria, then commissions executor batches and reviewers. After feedback it may request planning, assign fixes followed by review, or stop unsuccessfully.

Orchestrator, planners, and reviewers have read/search tools. Only executors edit files and run shell commands. Reviewers request missing execution checks through the orchestrator. Only the orchestrator delegates; workers cannot spawn agents or contact peers. These are tool-access boundaries, not filesystem isolation.

## Background execution

Use one orchestrator Pi session and a separate session per assignment. A small runtime owns workflow state and active promises. Orchestrator tools start a same-role batch, wait for updates, answer questions, accept a plan, resume interrupted agents, and finish the run. Starting a batch returns immediately. A worker's `ask_orchestrator` publishes a question and pauses only that worker; peers continue.

The orchestrator launches the next batch after the current batch settles. It separates dependent work and conflicting edits into later batches; there is no queued backlog, dependency graph, or automatic scope scheduler. A small update list and question-to-promise map provide live delivery, without a separate messaging framework.

Code requires planning reports before plan acceptance, an accepted plan before execution, and completed execution before review. Correction can return to planning or execution. New execution invalidates prior approval. Success requires explicit approval from every latest reviewer, no active workers, and a recorded successful outcome.

## Local storage and restart

Each run has a directory under `data/runs/` containing Pi-managed JSONL conversations and a versioned `run.json` checkpoint. Pi's documented `SessionManager.create`/`open` APIs own transcript persistence; our checkpoint owns the request, workspace/model identity, session references, assignments/statuses, stage, accepted plan, reports, review validity, questions/answers, unread updates, and consumed budgets/deadlines. Credentials are supplied at startup, not copied into the checkpoint.

Use Node filesystem operations with serialized checkpoint writes: write a temporary file then rename over `run.json`. Persist workflow changes before acknowledging state-changing tools or launching work. Stable operation IDs prevent duplicate delegation or answers if a result was not recorded in the orchestrator transcript. This is not a transaction across transcripts, checkpoints, and external effects; the checkpoint is authoritative for workflow decisions.

An explicit resume-by-run-ID entry point validates saved state, reopens conversations, and supplies the orchestrator a recovery summary. Completed work remains completed. Previously running/waiting agents become interrupted; saved questions and answers remain context, but promises are not restored. The orchestrator can resume an interrupted agent's conversation or commission replacement work. Budgets are not reset. Missing/corrupt required state produces a clear error, not a silently fresh run.

In-flight model responses and tool calls may be lost. Unmatched persisted calls receive an interruption result before further prompting; they are not automatically executed. Partial edits remain, and external commands may already have acted. There is no output reconstruction, automatic replay, rollback, or exactly-once guarantee. Resume recovers saved state, not a frozen process. One live process per run is required; power-loss durability is not promised.

## Reuse, failures, and trade-offs

Pin the MIT-licensed Pi SDK and pi-ai to 1.4.0 on Node 22.19+. Pi supplies conversations, tool selection, events, and abort/dispose; we own workflow and checkpoint rules. Explicit resources avoid ambient extensions/settings. Initially disable automatic agent/provider retries and compaction so hidden requests do not obscure behavior. Failed agents report errors; timeouts include question waiting. Cancellation rejects waits and aborts/cleans up sessions.

File checkpoints avoid a database/service; retaining pi-durable would add machinery beyond the accepted restart guarantee. Transcript-only persistence is simpler but cannot recover the workflow.

## Sequence, verification, and progress

1. Add persistent SDK session/model setup and role definitions in `src/agents/`; test permissions, independent histories, reopen/continue, interrupted calls, and cleanup without CLI wiring.
2. Add checkpoint storage in `src/storage/` and replace `src/orchestration/` with the small runtime/tools. Test phase guards, parallel questions, review correction, write interruption, and recovery consistency.
3. Rewire application/CLI with explicit resume; remove obsolete durable/scheduler/mailbox code and dependencies, update README, and test process-crash/restart using a scripted model without a live provider.

Assume a shared workspace and initially one model configuration. Exact schemas, limits, and CLI syntax are resolved in their increments. Revision 1 was approved, but its first increment was only proposed: no implementation or checks ran. That in-memory proposal is superseded. This revision awaits approval; next is a replacement persistent-session increment. No blocking questions remain.

<!-- pair-progress:start -->
## Pair progress

- Preserve the prototype in src_old before the clean rebuild: Created src_old/ as a reference archive containing all 13 existing source files, preserving the agents/, orchestration/, and storage/ structure. The active src/ tree was not modified. Scripts, dependencies, tests, and saved data were left untouched. This completes the archival-only first half of the staged move; no fresh application code or full-run recovery has been implemented yet. Next, subject to a separate proposal and approval, replace the active prototype with the smallest runnable fresh Pi application rather than adapting/importing archived modules.
  Verification: Ran the exact approved Node copy command with a refusal to overwrite an existing src_old directory; it succeeded. Ran the exact approved recursive file-list and byte comparison; it passed with: 'Verified 13 archived files are byte-for-byte identical.' TypeScript checking, the test suite, and live-model execution were intentionally not run, as specified for this source-preserving archival-only increment.
- Replace src with a small runnable Pi application: Replaced the active prototype with a fresh two-file Pi 1.4.0 application. src/index.ts now handles a one-shot terminal request, environment configuration, a per-request local session directory, final response/error reporting, and interruption/cleanup. src/agent.ts constructs the actual SDK session with an explicit OpenAI-compatible model, read-only tools, a readable baseline prompt, and isolated resources/settings/credentials. Pi persists conversations from the initial input. The new source contains only agent.ts and index.ts and has no references to src_old, pi-durable, or chord. The archive and existing saved data were left untouched. Pinned pi-ai and pi-coding-agent to 1.4.0 without installing dependencies. Redirected existing reference tests to src_old, added the fresh application's scripted-model tests, and rewrote README to explain the current stage and limitations. This is a runnable single-agent foundation, not the completed multi-agent system: delegation, execution/review stages, background questions, run.json, interrupted-call repair, and application crash-resume remain unimplemented.
  Verification: Before deletion, ran the exact approved guard: verified the entire src/src_old file lists matched, required exactly 13 files, and compared every file's bytes; it passed and then cleared/recreated src. npm run check: passed. node --import tsx --test tests/fresh-app.test.ts: 6 passed, 0 failed. npm test: 18 passed, 0 failed, including the legacy end-to-end workflow against src_old. Fresh tests exercised CLI usage without model calls, configured endpoint/model, read-only tool exposure, reading a temporary project file, persisted JSONL without the supplied credential, isolated histories, close/reopen/continue of a completed session, explicit disabled retry/compaction/cache-warming settings, provider failures without retries, empty-answer errors, persistence before the first response, and SDK abort/dispose cleanup. Reviewed both new source files, README, manifest/lock root metadata, and retargeted test paths. find confirmed only the two intended source files; grep found no archive/durable/chord references in src. No live model test, manual terminal Ctrl+C test, or whole-run recovery check was performed; cancellation coverage exercised the SDK, and whole-run recovery is deferred.

Latest increment awaits human review.
<!-- pair-progress:end -->
