# PiMAS

A fresh, readable TypeScript implementation of a coding multi-agent research baseline, using **Pi Agent 1.4.0** directly. The approved target is described in [DESIGN.md](DESIGN.md).

## Current working stage

The application currently runs **one read-only orchestrator conversation**. It can inspect files and explain a request, but cannot edit files, run shell commands, or delegate yet. Each request saves its conversation locally.

Planning sub-agents, executors, reviewers, background questions, workflow checkpoints, and crash-resume commands will be added in later increments. **Saved conversation history is not yet whole-run recovery.** A response at this stage is analysis, not reviewed implementation success.

The former implementation is preserved unchanged in `src_old/`. The new application does not import it.

## Run

Use Node.js **22.19 or newer** and an OpenAI-compatible endpoint that supports chat-completion tool calls. The default endpoint is LM Studio at `http://127.0.0.1:1234/v1`.

```powershell
npm install
$env:PIMAS_MODEL = "your-loaded-model-id"
npm start -- "Inspect this project and suggest a plan"
```

With no request, `npm start` prints usage; there is no interactive chat loop yet. Ctrl+C cancels active work. Provider errors or an incomplete/empty final answer produce a nonzero exit status.

### Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PIMAS_MODEL` | `local-model` | Model ID exposed by the endpoint |
| `PIMAS_BASE_URL` | `http://127.0.0.1:1234/v1` | OpenAI-compatible API base URL |
| `OPENAI_API_KEY` | `local` | Credential supplied at startup |
| `PIMAS_CWD` | Current directory | Project to inspect and root for local run storage |

The model configuration currently assumes a 128,000-token context window and a 4,096-token output limit, with thinking disabled. These are explicit baseline settings, not discovered server capabilities. Dollar-cost estimates are unset (zero), not measured costs. Automatic retries, compaction, and cache warming are disabled. Personal/project extensions, skills, prompt templates, settings, and automatically appended instructions are not loaded; the agent can read project instructions with its read tools.

The only active tools are `read`, `grep`, `find`, and `ls`. This is a tool-permission boundary, **not a filesystem sandbox**.

Legacy settings such as `PIMAS_STORAGE`, `PIMAS_STORAGE_DIR`, and `PIMAS_MAX_PARALLEL` do not configure this fresh application.

### Local history

Each invocation creates a directory under `<PIMAS_CWD>/data/runs/<id>/sessions/`. Pi writes the conversation as JSONL beginning with the first input. The CLI prints its session path; if setup fails before the first prompt, a directory may exist without a conversation file. Credentials are not intentionally stored in transcripts; project content and tool results are, so treat histories as potentially sensitive.

Completed histories can be reopened using Pi's SDK. There is **no application resume interface or `run.json` checkpoint yet**, and interrupted calls have not yet gained recovery handling. Existing data from the old prototype is left untouched.

## Read the new code

```text
src/
  index.ts    Request → local session directory → prompt → response → cleanup
  agent.ts    Explicit model, read-only prompt/tools, settings, and Pi session setup
```

There is no scheduler, mailbox framework, durable execution library, or custom agent loop in the new source. Pi owns the individual agent loop and conversation format.

## Development

```powershell
npm run check
node --import tsx --test tests/fresh-app.test.ts
npm test
```

`tests/fresh-app.test.ts` exercises the fresh CLI and real SDK sessions against a scripted local HTTP endpoint; no live model is required. The remaining tests target `src_old/` as reference regressions, including launching its archived entry point. The old durable/chord dependencies remain only to support that archive and its tests, not the new application.

Fault injection and benchmark infrastructure remain out of scope for now.
