#!/usr/bin/env bash
# Serve Qwen3.8-27B for the pipeline: one model copy per GPU (data parallel), prefix caching on.
# Check the model card for the recommended --tool-call-parser and --reasoning-parser before a real run;
# the defaults below are the Qwen3-family parsers and are overridable.
set -euo pipefail

MODEL="${MODEL:-Qwen/Qwen3.8-27B}"
PORT="${PORT:-8000}"
DATA_PARALLEL="${DATA_PARALLEL:-$(nvidia-smi --list-gpus | wc -l)}"
MAX_MODEL_LEN="${MAX_MODEL_LEN:-262144}"
TOOL_PARSER="${TOOL_PARSER:-hermes}"
REASONING_PARSER="${REASONING_PARSER:-qwen3}"

exec vllm serve "$MODEL" \
  --port "$PORT" \
  --data-parallel-size "$DATA_PARALLEL" \
  --max-model-len "$MAX_MODEL_LEN" \
  --enable-prefix-caching \
  --enable-auto-tool-choice \
  --tool-call-parser "$TOOL_PARSER" \
  --reasoning-parser "$REASONING_PARSER" \
  --served-model-name "$MODEL" \
  "$@"
