# Readable Multi-Agent Research Baseline

## Goal and boundary

Build an understandable TypeScript system using Pi Agent 1.4.0: an LLM orchestrator leads planning, execution, review, and correction. Success includes asynchronous workers the orchestrator spawns dynamically, live questions, honest outcomes, and continuing an interrupted run from saved local state.

Replace the prototype's pi-durable runtime, dependency scheduler, and mailbox framework. Retain a basic terminal interface and OpenAI-compatible configuration where practical. Removing pi-durable does **not** remove persistence. Fault injection, benchmarking infrastructure, recovery plugins, distributed execution, sandboxing, rich UI, exactly-once tool execution, and rollback are excluded.

## Roles

Each agent is its own Pi session with its own conversation. A role's provider, model, thinking level, and Markdown prompt come from explicit configuration; its tool set is fixed in code and cannot be widened by configuration. Every worker's final message is its report, and an error, abort, or empty report is a failure surfaced to the orchestrator rather than a successful result.

- **Orchestrator** — read/search plus delegation tools (spawn, wait, answer, finish). Decides what work happens, spawns agents, answers their questions, accepts plans, and records the final outcome. It never edits files or runs commands.
- **Planner** — read/search only. Returns a concrete plan with interfaces, affected files, dependencies, risks, acceptance checks, and explicit assumptions and questions. It cannot edit, run commands, or contact peers.
- **Executor** — read/search plus edit/write and shell. Implements one scoped assignment, respects agreed interfaces and existing human changes, and reports files changed, checks actually run, and remaining limitations.
- **Reviewer** — read/search only. Checks work against the accepted plan and acceptance criteria, reports concrete defects with evidence, and states approval or rejection. It cannot edit, run commands, or contact peers; missing execution checks are requested through the orchestrator.

## Asynchronous orchestration

The orchestrator spawns agents dynamically: a spawn tool takes a role and a self-contained assignment, creates a new Pi session, starts it, and returns an agent id immediately. Agents run concurrently with no concurrency cap. There is no queued backlog, dependency graph, or automatic scope scheduler; the orchestrator decides ordering and may keep working while agents run. This is the only delegation path: there is no separate synchronous delegation tool.

The application owns a small runtime holding the agent registry (id, role, session, status, promise) and workflow state. Pi owns each conversation and tool loop; the runtime owns cross-agent coordination.

Results reach the orchestrator through a wait tool that returns the next settled report, failure, question, or pause notification, optionally filtered by agent id, instead of blocking on a fixed batch. A worker can call `ask_orchestrator`, which delivers the question to the orchestrator as a message and waits up to two minutes for an answer. If no answer arrives, the worker pauses: its pending call stays open and the pause is reported as a separate notification, so the orchestrator can see both the question and the stalled worker. `answer_worker` resolves the pending call and lets the worker continue. An unanswered question therefore parks a worker rather than failing it. The orchestrator may then spawn replacements, request planning, assign fixes, request review, or finish unsuccessfully.

Code enforces stage order: planning reports before plan acceptance, an accepted plan before execution, settled execution before review, and explicit approval from every latest reviewer before success. New execution invalidates earlier approval. Only the orchestrator delegates; workers cannot spawn agents or contact peers.

## Local storage and restart

Each run has a directory under `data/runs/` containing Pi-managed JSONL conversations and a versioned `run.json` checkpoint. Pi's `SessionManager.create`/`open` APIs own transcript persistence; the checkpoint owns the request, workspace and model identity, session references, assignments and statuses (pending, running, waiting, settled, failed, interrupted), stage, accepted plan, reports, review validity, questions and answers, unread events, and consumed budgets/deadlines. Credentials are supplied at startup, not copied into the checkpoint.

Use Node filesystem operations with serialized checkpoint writes: write a temporary file then rename over `run.json`. Persist workflow changes before acknowledging state-changing tools or launching work. Stable operation ids prevent duplicate spawning or answers if a result was not recorded in the orchestrator transcript. This is not a transaction across transcripts, checkpoints, and external effects; the checkpoint is authoritative for workflow decisions.

An explicit resume-by-run-id entry point validates saved state, reopens conversations, and supplies the orchestrator a recovery summary. Completed work remains completed. Previously running or waiting agents become interrupted; saved questions and answers remain context, but promises are not restored. The orchestrator can resume an interrupted agent's conversation or spawn replacement work. Budgets are not reset. Missing or corrupt required state produces a clear error, not a silently fresh run.

In-flight model responses and tool calls may be lost. Unmatched persisted calls receive an interruption result before further prompting; they are not automatically executed. Partial edits remain, and external commands may already have acted. There is no output reconstruction, automatic replay, rollback, or exactly-once guarantee. Resume recovers saved state, not a frozen process. One live process per run is required; power-loss durability is not promised.

## Reuse, failures, and trade-offs

Pin the MIT-licensed Pi SDK and pi-ai to 1.4.0 on Node 22.19+. Pi supplies conversations, tool selection, events, and abort/dispose; we own workflow and checkpoint rules. Explicit resources avoid ambient extensions and settings. Compaction is enabled with Pi defaults so long runs stay within context, and retries use one provider-level budget (100 retries) with agent-level retry disabled, so failures surface once instead of twice. Failed agents report errors. Unanswered questions pause a worker, and the orchestrator may answer later, cancel it, or finish with it outstanding. Cancellation rejects waits and aborts and cleans up sessions.

Providers and per-role model choices live in explicit JSON files supplied on the command line; the application validates them and never discovers them. File checkpoints avoid a database or service; retaining pi-durable would add machinery beyond the accepted restart guarantee. Transcript-only persistence is simpler but cannot recover the workflow.

## Sequence, verification, and progress

1. Done: role-aware Pi sessions with explicit provider/model configuration, read-only permissions, independent persisted histories, and abort/cleanup.
2. Next: the asynchronous runner — spawn returning an id immediately, wait returning the next settled report or failure, with no concurrency cap. Questions, answers, and pause notifications follow. Focused scripted tests, without CLI wiring.
3. Then: checkpoint storage, stage guards, execution and review roles, and CLI resume; update README and test crash/restart with a scripted model.

Assume a shared workspace. Exact schemas, limits, and CLI syntax are resolved in their increments. Revision 3 established the readable baseline; this revision records asynchronous dynamic spawning, the role outline, the question/pause behavior, and no concurrency cap, and awaits approval.
