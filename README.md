# PiMAS

A fresh, readable TypeScript implementation of a coding multi-agent research baseline, using **Pi Agent 1.4.0** directly. The approved target is described in [DESIGN.md](DESIGN.md).

## Current working stage

The application currently runs **one read-only orchestrator conversation**. It can inspect files and explain a request, but cannot edit files, run shell commands, or delegate yet. Each request saves its conversation locally.

Planning sub-agents, executors, reviewers, background questions, workflow checkpoints, and crash-resume commands will be added in later increments. **Saved conversation history is not yet whole-run recovery.** A response at this stage is analysis, not reviewed implementation success.

The former implementation is preserved unchanged in `src_old/`. The new application does not import it.

## Run

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

The four roles can use different providers, models, thinking levels, and prompts. The examples use thinking `off` to match the non-reasoning model example. For a reasoning model, configure its capabilities accurately in the provider file and request the desired level in its role profile. Pi clamps unsupported levels; startup reports the effective model/thinking level and warns when it differs from the request. Unknown fields and missing roles are errors. The CLI still starts only an orchestrator. The application factory `createRoleSession` can create either an orchestrator or a planner using the corresponding profile, with a separate caller-supplied session manager for each conversation. Callers own prompting and abort/dispose; executor and reviewer session creation is explicitly disabled. No delegation tool or automatic worker launch exists yet.

Tool permissions are application rules, not role-file overrides. Shared session policies remain **100 provider-level retries for retryable failures**, with the separate agent-level retry loop disabled, **automatic compaction enabled** using Pi's defaults, and cache warming disabled. Compaction can issue additional summarization requests. Personal/project extensions, skills, prompt templates, settings, and automatically appended instructions are not loaded; the configured Markdown prompt is loaded explicitly, and the agent can read project instructions with its read tools.

The only active tools are `read`, `grep`, `find`, and `ls`. This is a tool-permission boundary, **not a filesystem sandbox**.

`PIMAS_MODEL`, `PIMAS_BASE_URL`, `PIMAS_STORAGE`, `PIMAS_STORAGE_DIR`, and `PIMAS_MAX_PARALLEL` do not configure this fresh application. An environment key such as `OPENAI_API_KEY` is used when the provider configuration references it; it is not an implicit key for the example's custom `pimas` provider.

### Local history

Each invocation creates a directory under `<PIMAS_CWD>/data/runs/<id>/sessions/`. Pi writes the conversation as JSONL beginning with the first input. The CLI prints its session path; if setup fails before the first prompt, a directory may exist without a conversation file. Credentials are not intentionally stored in transcripts; project content and tool results are, so treat histories as potentially sensitive.

Completed histories can be reopened using Pi's SDK. There is **no application resume interface or `run.json` checkpoint yet**, and interrupted calls have not yet gained recovery handling. Existing data from the old prototype is left untouched.

## Read the new code

```text
src/
  index.ts         CLI paths → role configuration → local session → response → cleanup
  agent-config.ts  Validated per-role preferences and config-relative Markdown paths
  agent.ts         Profile-selected model/prompt/thinking, fixed read-only tools, Pi session setup
```

There is no scheduler, mailbox framework, durable execution library, or custom agent loop in the new source. Pi owns the individual agent loop and conversation format.

## Development

```powershell
npm run check
node --import tsx --test tests/fresh-app.test.ts
npm test
```

`tests/agent-config.test.ts` checks role validation and path resolution. `tests/fresh-app.test.ts` exercises the fresh CLI and real SDK sessions against a scripted local HTTP endpoint, including independent orchestrator/planner profiles and saved histories, disabled-role guards, configured thinking, prompt selection, clamping warnings, and retries; no live model is required. The remaining tests target `src_old/` as reference regressions, including launching its archived entry point. The old durable/chord dependencies remain only to support that archive and its tests, not the new application.

Fault injection and benchmark infrastructure remain out of scope for now.
