# Source before running anything here. Override any variable to use other locations.
# Tools, caches and logs live in the repository's gitignored .local/ so nothing spills into the
# surrounding folders or /home (which is near its quota). Harbor's cache is fixed at ~/.cache/harbor,
# so make that a link: ln -sfn "$REPO_ROOT/.local/cache/harbor" ~/.cache/harbor
# REPO_ROOT, not PIMAS_ROOT: the Harbor agent reads PIMAS_ROOT as the PiMAS/ package directory.
export REPO_ROOT=${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}
export LOCAL_ROOT=${LOCAL_ROOT:-$REPO_ROOT/.local}
export CACHE_ROOT=${CACHE_ROOT:-$LOCAL_ROOT/cache}
export TOOLS_ROOT=${TOOLS_ROOT:-$LOCAL_ROOT/tools}
export PATH=$TOOLS_ROOT/node-v22/bin:$TOOLS_ROOT/uv-bin:$PATH
export UV_CACHE_DIR=$CACHE_ROOT/uv UV_TOOL_DIR=$CACHE_ROOT/uv-tools UV_TOOL_BIN_DIR=$TOOLS_ROOT/uv-bin UV_PYTHON_INSTALL_DIR=$CACHE_ROOT/uv-python
export npm_config_cache=$CACHE_ROOT/npm
# Docker's data-root mount, watched by the disk guard.
export DOCKER_MOUNT=${DOCKER_MOUNT:-/mnt/charlie}
# The key is read from this file at launch and only exported to the harbor process.
export VLLM_API_KEY_FILE=${VLLM_API_KEY_FILE:-$HOME/.config/jev-mem/vllm_api_key}
export VLLM_PORT=${VLLM_PORT:-18100}
export VLLM_LOG=${VLLM_LOG:-$LOCAL_ROOT/logs/vllm/gpu1-pimas-mtp.out}
export JOBS_DIR=${JOBS_DIR:-$REPO_ROOT/jobs/swe}
