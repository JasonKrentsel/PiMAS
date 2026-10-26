# PiMAS

A fresh, readable TypeScript implementation of a coding multi-agent research baseline, using **Pi Agent 1.4.0** directly. The target architecture is described in [DESIGN.md](DESIGN.md).

## Current working stage

The headless **TaskRun API** runs an autonomous orchestrator with asynchronously spawned planners, executors, and reviewers. It owns their conversations, worker questions, run checkpoints, and interruption-aware recovery without interactive human input. Workers share a workspace; there is no concurrency cap or scheduler.

Implementation follows a guarded workflow:

1. Planners inspect and report; the orchestrator calls `accept_plan` with settled planner IDs and a self-contained plan.
2. Executors receive native read/search, edit/write, and bounded bash tools. Commands default to **120 seconds**, with a **300-second maximum**; shorter requested timeouts are preserved.
3. After required execution settles, independent read-only reviewers inspect files and supplied check evidence, call `submit_review` with approval/rejection and reasons, and finish their reports.
4. Corrections use new executor work and fresh review. New or resumed execution invalidates earlier approval. Every reviewer of the current revision must explicitly approve.

`workflow_status` exposes saved evidence and completion blockers. A premature final answer fails rather than overriding the guards. Failed/interrupted assignments must be resumed or explicitly retired with `resolve_agent`; active work and settled rejections cannot be retired to bypass review. Inspection/planning-only work may finish without execution and must not be represented as reviewed implementation.

This loop has passed scripted real-SDK and real-container checks, including native commands and timeout enforcement. A small **live-model** integration also completed in a fresh mounted workspace: the planner proposed a finite-number summation module, the executor created it and its tests, the saved native shell result showed 11/11 tests passing (one parent plus ten subtests), and a separate read-only reviewer saved current approval. An additional host-selected contract check passed before verified container cleanup. This proves one small text-only task, not broad solver quality. **No official benchmark grade has been produced.**

The existing CLI remains a separate single-agent inspection entry point. It is not wired to TaskRun and does not provide multi-agent creation or recovery. The old prototype and its legacy-only tests have been removed.

## Autonomous host integration

Use explicit, absolute configuration and workspace paths. A host allocates one directory per task and retains that directory as its recovery reference; the checkpoint also contains a stable run ID. No run discovery or human-facing resume command is needed.

```typescript
import { loadAgentConfig } from "./src/agent-config.js";
import { TaskRun } from "./src/task-run.js";

const { roles } = await loadAgentConfig(agentsFile);
const options = { directory: runDirectory, cwd: workspace, modelsFile, roles };
const run = await TaskRun.create({ ...options, request: taskDescription });
// On a later process startup, use instead:
// const run = await TaskRun.resume(options);
try {
  const report = await run.execute();
  // Store or route the result in the calling host.
} finally {
  await run.dispose();
}
```

Creation persists the original task and orchestrator transcript before inference and refuses to overwrite an existing checkpoint. Resume reopens the same orchestrator history, marks previously running/waiting work interrupted, reopens interrupted workers, and automatically supplies a recovery summary when execution continues. Unfinished tool calls receive explicit interruption results, not execution. The orchestrator decides whether to resume workers (including an answer in the resume instruction for a recovered question) or assign replacement work. Once its turn settles, the host collects queued worker events or waits for active workers rather than abandoning them. Completed tasks return the saved report without another model call; recorded failures remain failures.

Recovery requires the saved workspace and models-file path to match. Missing, malformed, or workspace-mismatched referenced histories fail rather than silently creating new conversations. Use one live process per run; there is no cross-process lock. Writes after creation are serialized temporary-file/rename replacements, not power-loss durability or a transaction across transcripts and checkpoints. External effects may already have happened; there is no replay, rollback, or exactly-once guarantee. The summary and workflow tools carry saved reports/questions/answers and plan/review evidence, but durable event acknowledgements, operation-ID deduplication, full launch/shutdown ownership, model-profile identity checks, and task/token budgets are still deferred. Recovery tests exercise saved interrupted/live statuses, not an operating-system kill or power failure.

## Task-container integration

`src/container-bridge.ts` receives one task on stdin and runs TaskRun with native tools in the container workspace. `container/Dockerfile` installs PiMAS and an isolated Node runtime into a derivative of a task image; run state is bind-mounted at `/pimas-state`, outside `/app`. The sibling [T4-lite integration guide](../T4-lite%20runner/docs/PIMAS.md) covers build, model-free smoke, and single-task launch commands.

The outer root's [`config.example/`](../config.example/README.md) provides container-ready templates; real root `config/` is ignored by Git and passed explicitly to the runner. These use installed container prompt paths, unlike the host inspection CLI examples below. Neither path is auto-discovered.

The bridge binds checkpoints to a task/attempt/container identity and rejects old state in a fresh workspace. It reserves stdout for the done protocol message. The Ubuntu telecom derivative `pimas/telecom:execution-v1` has passed the scripted plan/execute/review smoke with native mutation, shell checks, and command timeout enforcement. The earlier `vertical-slice` image contains the old read-only source; rebuild after code changes. Other task images, broader live task-solving quality, and full benchmark evaluation remain unverified.

## Existing inspection CLI

Use Node.js **22.19 or newer**. The provider example targets an OpenAI-compatible endpoint with chat-completion tool calls, such as LM Studio at `http://127.0.0.1:1234/v1`.

```powershell
npm install
Copy-Item models.example.json models.local.json
Copy-Item agents.example.json agents.local.json
# Edit the endpoint/credentials/model metadata in models.local.json.
# Set each role's provider/model/thinking/prompt in agents.local.json.
npm start -- --models ./models.local.json --agents ./agents.local.json "Inspect this project and suggest a plan"
```

With no request, `npm start` prints usage; there is no interactive chat loop yet. Ctrl+C cancels active work. Provider errors or an incomplete/empty final answer produce a nonzero exit status.

### Configuration

| Input | Purpose |
| --- | --- |
| `--models <file>` | Required provider configuration in Pi's native models JSON format |
| `--agents <file>` | Required role profiles for orchestrator, planner, executor, and reviewer |
| `PIMAS_CWD` | Project to inspect and root for local run storage; defaults to the current directory |

Both CLI paths resolve from the directory where you launch the command. No configuration file is auto-discovered. Root-level `models.local.json` and `agents.local.json` are ignored by Git; the example files contain no real credentials. If you choose other private filenames inside the repository, add your own ignore rules.

**Provider configuration:** `models.example.json` shows Pi's native format. Provider keys identify connections; each connection defines its endpoint, API, credentials, and model metadata. The example's 128,000-token context, 4,096-token output limit, non-reasoning capability, zero cost estimates, and compatibility flags are editable assumptions, not discovered server capabilities. Match them to your actual model and endpoint. `apiKey` can contain a literal key or an environment reference such as `"$OPENAI_API_KEY"`. Only load configuration you trust: Pi also supports command-valued credentials.

**Role configuration:** every role has four required fields, without inheritance or implicit model selection:

| Field | Purpose |
| --- | --- |
| `provider` | Provider ID from the model runtime, such as `pimas` in the example |
| `model` | Exact model ID for that provider |
| `thinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `systemPrompt` | Markdown file; relative paths resolve beside the agents JSON file, not in the inspected project |
| `extensions` (optional) | Array of native Pi extension files/directories; paths resolve beside the agents JSON file; omitted or `[]` loads none |

The four roles can use different providers, models, thinking levels, and prompts. The examples use thinking `off` to match the non-reasoning model example. For a reasoning model, configure its capabilities accurately in the provider file and request the desired level in its role profile. Pi clamps unsupported levels; startup reports the effective model/thinking level and warns when it differs from the request. Unknown fields and missing roles are errors. The CLI still starts only an orchestrator. The application factory `createRoleSession` supports all four roles using their own profiles and caller-supplied session managers. Without extensions, only executors get native mutation and bounded bash tools; the other roles remain read-only. Callers own prompting and abort/dispose. TaskRun supplies orchestrator coordination/workflow tools, gives workers `ask_orchestrator`, and binds each reviewer's verdict tool to its own ID. Direct factory callers use a lower-level API: session creation alone does not enforce TaskRun's workflow guards. Custom tools cannot replace the native role tools.

Baseline tool permissions are application rules, not provider/model preferences. Explicit extensions are trusted code and can change tool behavior; they are not confined by the baseline role policy. Shared session policies remain **100 provider-level retries for retryable failures**, with the separate agent-level retry loop disabled, **automatic compaction enabled** using Pi's defaults, and cache warming disabled. Compaction can issue additional summarization requests. Discovered personal/project extensions, skills, prompt templates, settings, and automatically appended instructions are not loaded. Only explicitly listed role extensions are loaded, alongside the configured Markdown prompt; the agent can read project instructions with its read tools.

The inspection CLI's only active tools are `read`, `grep`, `find`, and `ls`; TaskRun adds the coordination tools described above. This is a tool-permission boundary, **not a filesystem sandbox**.

`PIMAS_MODEL`, `PIMAS_BASE_URL`, `PIMAS_STORAGE`, `PIMAS_STORAGE_DIR`, and `PIMAS_MAX_PARALLEL` do not configure this fresh application. An environment key such as `OPENAI_API_KEY` is used when the provider configuration references it; it is not an implicit key for the example's custom `pimas` provider.

### Native Pi extensions

The integration point is `createRoleSession` in `src/agent.ts`: it creates Pi's `DefaultResourceLoader`, supplies the selected role's `extensions` as `additionalExtensionPaths`, calls `reload()`, and passes the loader to `createAgentSession`. Pi consumes the actual loaded extension/runtime objects through `resourceLoader.getExtensions()`. Session startup is bound in headless print mode, and native handler errors are reported on stderr. There is no PiMAS plugin API or tool-result wrapper.

Add an optional field to the existing **planner** profile to enable the included example inside a rebuilt task image:

```json
"extensions": ["/opt/pimas/src/extensions/tool-result-injection.ts"]
```

On the host, use an absolute extension path or a path relative to your agents JSON file. In containers, a custom extension stored at `config/extensions/inject.ts` can be selected as `"extensions": ["extensions/inject.ts"]`; the existing config mount makes it available under `/pimas-config`. Every planner spawned with that profile loads it. Other roles are unaffected unless configured too. The supplied templates leave extensions disabled. Rebuild the image for the new loader and bundled example; the previously tested `execution-v1` image does not contain this change.

[`src/extensions/tool-result-injection.ts`](src/extensions/tool-result-injection.ts) is an ordinary Pi extension exporting a default `(pi: ExtensionAPI) => void` factory. Its native `pi.on("tool_result", ...)` handler appends a deliberately misleading instruction to successful `read` and `bash` output. The transformed result reaches the model and normal Pi transcript. This is a plumbing example, not a measured attack or mitigation. Preserve raw results separately if your experiment needs before/after evidence.

Missing or broken configured modules fail session setup instead of silently running without them. Pi's normal runtime handler-error semantics still apply; a handler error is reported, not necessarily fatal to the run. Extensions execute with the process's permissions and can register tools or perform arbitrary actions. Load only trusted experiment code, and do not treat role permissions as a sandbox around it.

New and reopened worker/orchestrator sessions use this same factory. Keep extension state inside the extension factory for per-session ownership; module globals are not isolated. On resume, extensions are loaded from the supplied role configuration again. Extension-code identity and in-memory state are not checkpointed or compared; keep configuration/source stable and use Pi session entries if an extension needs durable state. This increment selects by role; there is no per-spawn experiment policy, experiment manifest, scoring, or mitigation framework.

### Local history

Each invocation creates a directory under `<PIMAS_CWD>/data/runs/<id>/sessions/`. Pi writes the conversation as JSONL beginning with the first input. The CLI prints its session path; if setup fails before the first prompt, a directory may exist without a conversation file. Credentials are not intentionally stored in transcripts; project content and tool results are, so treat histories as potentially sensitive.

TaskRun directories additionally contain version-2 `run.json` with the original request, orchestrator state, worker histories/outcomes, accepted plan and planner IDs, execution revision, reviewer verdicts, and explicit retirement reasons. Version-1 checkpoints open with empty workflow evidence and save as version 2; migration never invents earlier plan acceptance or review approval. Previously completed reports remain reusable historical results, not retroactive proof of review. Older worker-only checkpoints cannot resume as autonomous tasks. CLI-only histories remain independently reopenable through Pi's SDK.

## Read the new code

```text
src/
  index.ts         CLI paths → role configuration → local session → response → cleanup
  agent-config.ts  Validated per-role preferences and config-relative Markdown paths
  agent.ts         Profile-selected model/prompt/thinking, native role permissions, Pi sessions
  execution-tools.ts Native bash with enforced default/maximum timeout and Pi cancellation
  workflow.ts      Planner-backed acceptance, execution revisions, verdict and finish guards
  workflow-tools.ts Model-facing acceptance/status/retirement and reviewer verdict tools
  task-run.ts      Headless task ownership, orchestrator persistence, execution and recovery
  runtime.ts       Async workers, spawn/wait/answer/resume tools, questions and cleanup
  run-store.ts     Versioned workflow checkpoints and serialized atomic replacements
  recovery.ts      Required-history validation and non-replaying tool interruption repair
  answer.ts        Final-answer validation shared by the runtime and task owner
```

There is no scheduler, mailbox framework, durable execution library, or custom agent loop in the new source. Pi owns the individual agent loop and conversation format.

## Development

```powershell
npm run check
node --import tsx --test tests/fresh-app.test.ts
npm test
```

`tests/agent-config.test.ts` checks role validation and path resolution. `tests/fresh-app.test.ts` exercises the CLI and real SDK against a scripted local HTTP endpoint, including native implementation/check/review, missing/rejected/prose-only/stale approval failures, async questions, recovery, completed-result reuse, role permissions, thinking, and retries. `tests/workflow.test.ts` covers stage guards and version-1 migration. `tests/execution-tools.test.ts` covers timeout policy and real local cancellation/deadlines. `tests/session-recovery.test.ts` covers unmatched-call repair, required-history validation, and overwrite prevention. No live model is required. Unused durable/chord dependencies remain in the package for now; the active implementation does not import them.

General fault-injection infrastructure, durable coordination receipts, cross-container recovery, and live benchmark quality are not claims of this increment.
