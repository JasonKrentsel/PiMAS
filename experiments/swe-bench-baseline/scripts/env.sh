# Source before running anything here. Defaults are the course machine's; override any of them.
# Keeps every cache off /home (it is near its quota).
export PIMAS_ROOT=${PIMAS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}
export CACHE_ROOT=${CACHE_ROOT:-/mnt/bravo/c2kong/.cache-pimas}
export TOOLS_ROOT=${TOOLS_ROOT:-/mnt/bravo/c2kong/tools}
export PATH=$TOOLS_ROOT/node-v22/bin:$TOOLS_ROOT/uv-bin:$PATH
export UV_CACHE_DIR=$CACHE_ROOT/uv UV_TOOL_DIR=$CACHE_ROOT/uv-tools UV_TOOL_BIN_DIR=$TOOLS_ROOT/uv-bin UV_PYTHON_INSTALL_DIR=$CACHE_ROOT/uv-python
export npm_config_cache=$CACHE_ROOT/npm
# Docker's data-root mount, watched by the disk guard.
export DOCKER_MOUNT=${DOCKER_MOUNT:-/mnt/charlie}
# The key is read from this file at launch and only exported to the harbor process.
export VLLM_API_KEY_FILE=${VLLM_API_KEY_FILE:-$HOME/.config/jev-mem/vllm_api_key}
export VLLM_PORT=${VLLM_PORT:-18100}
export VLLM_LOG=${VLLM_LOG:-/mnt/bravo/c2kong/vllm-logs/gpu1-pimas-mtp.out}
export JOBS_DIR=${JOBS_DIR:-$PIMAS_ROOT/jobs/swe}
