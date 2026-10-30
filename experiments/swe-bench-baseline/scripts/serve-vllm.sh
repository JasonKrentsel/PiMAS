#!/usr/bin/env bash
# Usage: GPU=<index> serve-vllm.sh   (run under nohup; logs to $VLLM_LOG)
# Qwen3.8-27B with qwen3_coder tool calls, 131072 context, MTP speculative decoding (2 tokens),
# and cached-token reporting. VLLM_ROOT holds the vLLM venv and the HF cache with the weights.
source "$(dirname "$0")/env.sh"
: "${GPU:?set GPU to the GPU index to use}"
VLLM_ROOT=${VLLM_ROOT:-/mnt/bravo/c2kong/system1_rag/jev-mem-vision}
WEIGHTS=${WEIGHTS:-$VLLM_ROOT/hf_cache/hub/models--Qwen--Qwen3.8-27B/snapshots/1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0}
VLLM_API_KEY=$(cat "$VLLM_API_KEY_FILE"); export VLLM_API_KEY
export CUDA_VISIBLE_DEVICES=$GPU VLLM_USE_FLASHINFER_SAMPLER=0
export HF_HOME=$VLLM_ROOT/hf_cache VLLM_CACHE_ROOT=$CACHE_ROOT/vllm
exec "$VLLM_ROOT/.venv-vllm/bin/vllm" serve "$WEIGHTS" \
  --served-model-name qwen3.8-27b \
  --tensor-parallel-size 1 \
  --max-model-len 131072 \
  --gpu-memory-utilization 0.90 \
  --max-num-seqs 32 \
  --reasoning-parser qwen3 \
  --enable-prefix-caching \
  --limit-mm-per-prompt '{"image": 16, "video": 0}' \
  --enable-auto-tool-choice --tool-call-parser qwen3_coder \
  --speculative-config '{"method": "qwen3_5_mtp", "num_speculative_tokens": 2}' \
  --enable-prompt-tokens-details \
  --host 127.0.0.1 --port "$VLLM_PORT"
