# Container configuration templates

At the outer repository root:

- `config.example/` contains tracked, generic templates.
- `config/` contains real local configuration and is ignored by Git.

For a new checkout where `config/` does not exist (PowerShell, from the outer root):

```powershell
Copy-Item -Recurse config.example config
# Edit config/models.json and config/agents.json before using a real model.
```

`models.json` uses Pi's provider schema. Replace the endpoint/model ID and describe actual reasoning, input, context/output, pricing, and compatibility capabilities. The values here are examples, not verified server capabilities. `unused` is a placeholder for an unauthenticated server; authenticated providers can reference an explicitly supplied environment variable instead of storing a literal secret.

`agents.json` selects each role's provider, model, thinking level, and prompt. These templates use the prompts installed at `/opt/pimas/prompts/` inside the task image. Enable reasoning levels only when the model and endpoint support them. Role configuration does not grant tools or bypass workflow guards.

Pass the real directory explicitly as `--config ../config` when launching the in-container runner from `T4-lite runner/`. It is mounted read-only at `/pimas-config`; the bridge receives explicit models/agents paths. No configuration or credentials are auto-discovered. Keep public evaluation metadata in a separate non-secret profile, not in these provider files.

The `PiMAS/models.example.json` and `PiMAS/agents.example.json` files remain host inspection-CLI examples and scripted test/build fixtures. Their relative prompt paths are not interchangeable with these container-ready paths. The image build context is `PiMAS/`; the outer `config/` directory is never copied into the image.

Actual task evaluation runs inference and official grading. Model-free smokes do not use this configuration. See [the integration guide](../T4-lite%20runner/docs/PIMAS.md) before launching either.
