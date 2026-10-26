# PiMAS

A fresh, readable TypeScript implementation of a coding multi-agent research baseline, using **Pi Agent 1.4.0** directly. The target architecture is described in [DESIGN.md](DESIGN.md).

## Current working stage

The headless **TaskRun API** runs an autonomous orchestrator with asynchronously spawned, read-only planners. It owns their conversations, worker questions, run checkpoints, and recovery without interactive human input. Executor/reviewer sessions and plan/review completion guards are not enabled yet; a completed task is not reviewed implementation success.

The older CLI remains a separate single-agent inspection entry point. It is not wired to TaskRun and does not provide multi-agent creation or recovery.

The former implementation is preserved unchanged in `src_old/`. The new application does not import it.

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

Recovery requires the saved workspace and models-file path to match. Missing, malformed, or workspace-mismatched referenced histories fail rather than silently creating new conversations. Use one live process per run; there is no cross-process lock. Writes after creation are serialized temporary-file/rename replacements, not power-loss durability or a transaction across transcripts and checkpoints. External effects may already have happened; there is no replay, rollback, or exactly-once guarantee. The summary carries saved reports/questions/answers, but a durable event acknowledgement log, operation-ID deduplication, model-profile identity checks, budgets, and stage/review guards are still deferred. Recovery tests exercise saved interrupted/live statuses, not an operating-system kill or power failure.

## Task-container integration

`src/container-bridge.ts` receives one task on stdin and runs TaskRun with native tools in the container workspace. `container/Dockerfile` installs PiMAS and an isolated Node runtime into a derivative of a task image; run state is bind-mounted at `/pimas-state`, outside `/app`. The sibling [T4-lite integration guide](../T4-lite%20runner/docs/PIMAS.md) covers build, model-free smoke, and single-task launch commands.

The bridge binds checkpoints to a task/attempt/container identity and rejects old state in a fresh workspace. It reserves stdout for the done protocol message. The first verified task image is the Ubuntu telecom environment; executor/reviewer roles, native shell timeout policy, other images, and full benchmark evaluation remain future work.

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

The four roles can use different providers, models, thinking levels, and prompts. The examples use thinking `off` to match the non-reasoning model example. For a reasoning model, configure its capabilities accurately in the provider file and request the desired level in its role profile. Pi clamps unsupported levels; startup reports the effective model/thinking level and warns when it differs from the request. Unknown fields and missing roles are errors. The CLI still starts only an orchestrator. The application factory `createRoleSession` can create either an orchestrator or a planner using the corresponding profile, with a separate caller-supplied session manager for each conversation. Callers own prompting and abort/dispose; executor and reviewer session creation is explicitly disabled. TaskRun supplies the orchestrator's spawn/wait/answer/resume tools and gives workers ask_orchestrator; direct factory callers choose their own custom tools.

Tool permissions are application rules, not role-file overrides. Shared session policies remain **100 provider-level retries for retryable failures**, with the separate agent-level retry loop disabled, **automatic compaction enabled** using Pi's defaults, and cache warming disabled. Compaction can issue additional summarization requests. Personal/project extensions, skills, prompt templates, settings, and automatically appended instructions are not loaded; the configured Markdown prompt is loaded explicitly, and the agent can read project instructions with its read tools.

The inspection CLI's only active tools are `read`, `grep`, `find`, and `ls`; TaskRun adds the coordination tools described above. This is a tool-permission boundary, **not a filesystem sandbox**.

`PIMAS_MODEL`, `PIMAS_BASE_URL`, `PIMAS_STORAGE`, `PIMAS_STORAGE_DIR`, and `PIMAS_MAX_PARALLEL` do not configure this fresh application. An environment key such as `OPENAI_API_KEY` is used when the provider configuration references it; it is not an implicit key for the example's custom `pimas` provider.

### Local history

Each invocation creates a directory under `<PIMAS_CWD>/data/runs/<id>/sessions/`. Pi writes the conversation as JSONL beginning with the first input. The CLI prints its session path; if setup fails before the first prompt, a directory may exist without a conversation file. Credentials are not intentionally stored in transcripts; project content and tool results are, so treat histories as potentially sensitive.

TaskRun directories additionally contain `run.json` with the original request, orchestrator session/status/report/error, and worker assignments/statuses/questions/answers/reports/session references. TaskRun.resume uses these checkpoints; older worker-only checkpoints cannot resume as autonomous tasks. CLI-only histories remain independently reopenable through Pi's SDK. Existing prototype data is left untouched.

## Read the new code

```text
src/
  index.ts         CLI paths → role configuration → local session → response → cleanup
  agent-config.ts  Validated per-role preferences and config-relative Markdown paths
  agent.ts         Profile-selected model/prompt/thinking, read-only tools, Pi session setup
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

`tests/agent-config.test.ts` checks role validation and path resolution. `tests/fresh-app.test.ts` exercises the fresh CLI and real SDK sessions against a scripted local HTTP endpoint, including independent profiles, async workers/questions, headless task creation and recovery, preserved orchestrator/worker histories, cancellation, completed-result reuse, disabled-role guards, configured thinking, clamping, and retries. `tests/session-recovery.test.ts` covers unmatched-call repair, required-history validation, and overwrite prevention; no live model is required. The remaining tests target `src_old/` as reference regressions, including launching its archived entry point. The old durable/chord dependencies remain only to support that archive and its tests, not the new application.

Fault injection and benchmark infrastructure remain out of scope for now.
