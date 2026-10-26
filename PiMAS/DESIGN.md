# Autonomous Multi-Agent Tasks and Recovery

## Goal and boundary

Build a readable TypeScript multi-agent system on Pi Agent 1.4.0. An LLM orchestrator coordinates planning, execution, review, and correction, with independent asynchronous workers. A host process submits a task and can reopen its saved run after interruption without interactive human input.

Success means preserving the original task, orchestrator conversation, worker conversations, and coordination decisions; making uncertain outcomes explicit; and continuing without silently losing notifications or repeating recorded coordination operations. It does not mean restoring a frozen process or guaranteeing autonomous task success.

The application lives under `PiMAS/` in the repository. `TaskRun` is the host boundary, not a human-facing CLI. Existing inspection CLI behavior is deliberately separate; CLI syntax, terminal output, and human approval flows are not part of this increment. Build fresh rather than importing the archived prototype.

Preserve async-only dynamic spawning with **no concurrency cap**, separate configured sessions per role, automatic compaction, 100 provider-level retries, and disabled agent-level retries. Exclude distributed execution, sandboxing, rollback, external-effect replay, exactly-once execution, power-loss durability, benchmarking, recovery plugins, and generic fault-injection infrastructure. One live owner per run is a required host constraint, not a lock currently enforced by the application.

## Ownership and reuse

- **Pi** owns each conversation, model/tool loop, compaction, JSONL transcript, abort, and session disposal. `SessionManager` remains authoritative for finalized conversation history.
- **TaskRun** owns the original request, orchestrator session, execution lifecycle, safe event delivery into that session, recovery, and final host outcome.
- **AgentRuntime** owns worker IDs, independent sessions, asynchronous tasks, questions, event selection, and worker cleanup. Workers do not contact peers.
- **RunStore** owns versioned workflow state and serialized checkpoint transitions. It is the authority for coordination decisions, not for what a model understood or an external command actually did.

Continue using explicit models and role configuration, Pi session APIs, and Node filesystem operations. A database, durable-execution engine, or generic mailbox framework would add deployment and maintenance cost without removing the transcript/external-effect boundary. Keep the new coordination records domain-specific and local to one run.

## Roles and eventual workflow

The orchestrator inspects and coordinates but does not edit or run shell commands. Planners inspect and propose plans. Executors will gain edit/write/shell permissions for scoped assignments. Reviewers will inspect evidence and explicitly approve or reject work without editing or executing commands. Only the orchestrator can spawn or resume workers; configuration cannot widen role permissions. Tool permissions are not a filesystem sandbox.

Each assignment gets its own session and self-contained context. Workers run concurrently, without a queued backlog, batch barrier, dependency graph, or automatic scope scheduler. The orchestrator chooses ordering and answers worker questions from task context. If it cannot safely resolve a blocker, it records an honest unsuccessful outcome instead of requesting interactive input.

Plan acceptance, execution/review roles, and stage guards are the following increment, not existing guarantees. Their target ordering remains: planning evidence before accepting a plan; an accepted plan before execution; settled execution before review; and explicit approval from every latest reviewer before successful implementation completion. New execution invalidates prior approval.

## Current foundation and next boundary

The existing headless API creates a run in an explicit directory, persists the original task and orchestrator history before inference, executes asynchronously delegated planning, and reopens orchestrator and interrupted worker conversations. Completed tasks return their saved report without another model call. Recovery closes unfinished tool calls with interruption results rather than executing them. Required-history validation, overwrite prevention, workspace/models-path checks, and cancelled-wait removal are present.

The remaining coordination gaps are specific: events live in memory; summaries reproduce saved state but do not track delivery; tool-call IDs are discarded by coordination tools; live launch/dispose races are not fully owned; and questions do not yet have a single durable delivery path into the headless orchestrator. These are the next implementation scope. Saving a checkpoint alone is not proof that these gaps are closed.

## Durable coordination state

Keep one `run.json` alongside Pi-managed `sessions/*.jsonl`. Extend the schema with a new explicit version rather than silently changing the meaning of existing version-1 records. Store:

- Run identity, request, canonical workspace/configuration paths, orchestrator session/status/outcome, and non-secret role/model identity needed to detect incompatible recovery.
- Worker assignments, session references, statuses, continuation attempts, and saved reports/errors.
- Coordination operations identified by their originating session and tool call, with operation kind, validated arguments, affected records, and committed coordination outcome.
- Questions with stable question IDs, originating worker call, question text, answer when recorded, resolution state, and the persisted two-minute answer deadline.
- Events with stable IDs, payload, source operation or worker attempt, and optional transcript delivery receipt.

Do not copy credentials into the checkpoint or hash credential-bearing configuration wholesale. Validate non-secret identities deliberately; a matching file path alone does not prove that the model profile is unchanged. Do not invent consumed budgets that were never recorded; future budgets/deadlines must survive recovery when introduced.

Version-1 migration is a deterministic schema conversion before launching work. Preserve existing requests, histories, statuses, and reports; leave unknown operation/delivery history explicitly unknown. Do not fabricate earlier operation IDs or assert that legacy events were acknowledged. Legacy worker-only checkpoints remain ineligible for autonomous TaskRun recovery because they lack the orchestrator/request. Exact field shapes and migration fixtures are resolved in the storage step.

Checkpoint transitions update related workflow records together and await one serialized temporary-write/rename replacement before acknowledgement or launch. Initial creation remains exclusive. A failed write must surface and prevent the dependent action; it must not become model success or an unobserved rejected background promise. Storage failure stops further workflow mutations and triggers owned cleanup. Atomic replacement is not a transaction across checkpoint, transcripts, and external effects, and does not promise power-loss durability.

## Operation identity and uncertain tool outcomes

A coordination operation ID is derived from `(originating session ID, tool-call ID)`, never from assignment text. Include both parts because call IDs can collide across conversations. Retain the operation kind and canonical validated arguments; reuse of an ID with different inputs is an error.

For `spawn_agent`, prepare the worker session and persist its assignment/history reference, registry entry, and operation outcome before starting inference. Record the session's initial input before checkpointing its launch reference so an accepted launch cannot point only to a not-yet-created file. Session creation that fails before checkpoint commitment may leave an unreferenced file; recovery must not adopt it as work.

For `resume_agent`, persist the continuation intent and attempt identity before starting a new turn. For `answer_worker`, identify the exact question, save its answer and operation outcome before releasing the live waiter. A new question cannot accidentally inherit an earlier answer.

Repeating the same committed operation returns its recorded coordination outcome without spawning, releasing, or starting work again. This is local deduplication of the same call, not semantic deduplication of a new model decision. A new call ID can intentionally request new work; prompts and saved state still matter.

If an originating tool result is absent after restart, close the unmatched call with an explicit interruption result that references the known operation and affected records. Say whether a workflow decision was committed and that execution may have begun; do not fabricate the original response or infer that a worker completed. If no operation was committed, report that absence without executing the saved call. Unknown external effects remain unknown. Recovery does not replay tool calls or reconstruct lost model output.

## Event persistence and delivery receipts

Use one durable event collection for settlements, failures, questions, and pauses. Worker completion and its event are saved in the same checkpoint transition. Questions are saved before publication; expiration of the persisted answer deadline creates a separate pause event without failing the worker or closing its pending call.

Delivery has two phases:

1. Select an unacknowledged event and reserve it for one in-process delivery path. Returning it from an in-memory wait does not remove it durably.
2. Acknowledge only after the orchestrator's persisted history contains the matching event ID and payload reference. Record the session/entry receipt in `run.json`.

`wait_for_agents` tool results carry event IDs in details. Host-injected messages also carry machine-readable event IDs. A notifier is a wake-up hint, not an alternative channel that discards an event after a callback. TaskRun owns delivery; callers do not wire competing payload consumers.

Pi 1.4 emits ordinary `message_end` callbacks before appending the message to SessionManager. Therefore that callback alone is not a persistence acknowledgement. Reconcile receipts against saved session entries at safe boundaries and on recovery. Scan authoritative raw active-branch history, including entries no longer in current model context after compaction, rather than searching only current context or matching text. The host does not navigate branches in this increment.

If interruption occurs before transcript delivery, the event remains eligible. If it occurs after transcript delivery but before checkpoint acknowledgement, recovery finds the receipt and acknowledges without another injection. If persistence cannot be established, prefer possible redelivery with the same event ID to silent loss. This is at-least-once notification, not proof the model read, understood, or acted on it. Retain event records for reconciliation; pruning policy is deferred.

## Autonomous liveness and shutdown

A question is persisted and routed immediately, with model observation at Pi's next safe boundary. When the orchestrator is idle, TaskRun schedules a turn. When it is generating, use Pi's supported queued/steering message delivery rather than a concurrent prompt. An event stays unacknowledged until actual transcript persistence, not merely queue acceptance.

Questions and pauses are control events for the whole run. A wait filtered to worker A must not prevent delivery of a question from worker B. The wait tool may return an urgent question/pause regardless of its report filter; its description must document this exception. Do not abort a model response or replay a tool just to wake a blocked runtime wait.

After an orchestrator turn ends, TaskRun drains eligible events or waits for active work rather than accepting a final message that abandons workers. Interrupted assignments must be resumed or explicitly resolved as no longer required before successful task completion; a lack of live promises is not evidence of completed work. Until stronger finish/stage tools exist, unresolved work must surface as interruption/blockage rather than silently successful completion.

Introduce explicit open/closing/closed runtime ownership. Track session creation and worker-run promises. Shutdown rejects new launches, cancels/removes waiters, records interrupted live work, aborts sessions, and waits for owned work to settle. A session whose creation finishes during closing is disposed rather than launched. Cleanup must still run when checkpoint persistence fails, while preserving the original failure. This lifecycle rule is not a concurrency cap.

## Restart sequence

1. Read and validate the entire checkpoint and required referenced histories before applying repairs. Check schema, identities, unique IDs, references, session workspace, and transcript integrity. Missing/corrupt required state fails without silently starting fresh or partially repairing earlier histories. A prior-process live session reference is required; session references must belong to this run.
2. Reconcile persisted event receipts and coordination operations. Do not execute unmatched saved calls. Preserve completed work and known failures; a partial response or uncheckpointed final message is not automatically accepted as a completed task.
3. Convert prior running/waiting work to interrupted in a checkpoint transition. Questions/answers and continuation intent remain evidence; promises and timers are not resurrected. A recorded answer not delivered before interruption remains available for the orchestrator's next continuation instruction.
4. Apply idempotent interruption repairs to incomplete calls, reopen the original orchestrator and interrupted worker conversations, and persist any remaining recovery bookkeeping before new inference. Repeating recovery must not create extra repairs, operations, or completion events.
5. Supply a structured recovery summary identifying the original task, saved outcomes, unresolved assignments/questions, uncertain operations, and undelivered events. The summary does not acknowledge unrelated events merely by existing. Continue through TaskRun.execute without human input. Completed runs return their saved result; recorded terminal failures are not automatically retried as new tasks.

A crash after operation commitment but before launch leaves an interrupted assignment to resolve, not an instruction to auto-launch it. A crash during inference loses in-flight output. A crash after recording a worker report but before notifying the orchestrator preserves both the report and event. A crash after external side effects leaves those effects in place. None of these boundaries grants automatic replay or rollback.

## Implementation sequence and verification

Implement through separately approved, understandable steps:

1. Versioned coordination schema, validation/migration, serialized transitions, and non-secret identity policy.
2. Stable operation/question/attempt IDs, early worker transcript persistence, and operation-aware interruption repair without replay.
3. Durable events, transcript receipt reconciliation, and one TaskRun delivery path, including urgent questions during filtered waits.
4. Owned launch/shutdown promises and unresolved-work completion checks; integrate the complete restart sequence.
5. Scripted headless recovery regressions and README/API updates. Then enable executor/reviewer roles with plan and review guards in a separate increment.

Use focused storage tests and the real Pi SDK against scripted loopback HTTP, not live providers. Verify saved states on both sides of commitment, transcript delivery, event acknowledgement, question answering, and worker completion. Cover two identical calls versus two different call IDs, repeated recovery, compaction-aware receipts, old-checkpoint migration, missing/corrupt references, storage failure propagation, a question during an unrelated filtered wait, cancelled delivery, and creation completing during shutdown. Normal recovery fixtures and controlled test doubles are sufficient; do not build a general fault-injection framework. Tests must distinguish saved-state recovery from actual OS-kill/power-loss durability, and SDK integration from the still-separate CLI.

This revision is a recovery-first proposal. Field details and exact test fixtures are implementation decisions; there is no unresolved choice requiring human runtime interaction. Design agreement does not authorize code changes, test commands, commits, or pushes.
