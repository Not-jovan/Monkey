#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

runtime_image="${CONTAINER_RUNTIME_IMAGE:-volc-agent-runtime:local}"
runtime_base_image="${CONTAINER_RUNTIME_BASE_IMAGE:-node:22-bookworm-slim}"
runtime_apt_mirror="${CONTAINER_APT_MIRROR:-}"
runtime_apt_security_mirror="${CONTAINER_APT_SECURITY_MIRROR:-}"
runtime_apt_packages="${CONTAINER_RUNTIME_APT_PACKAGES:-ca-certificates git ripgrep}"
codex_sandbox_mode="${CODEX_SANDBOX_MODE:-workspace-write}"
claude_code_version="${CLAUDE_CODE_VERSION:-2.1.250}"
# Must match the AGENT_RUNTIME default in apps/server/src/config.ts.
agent_runtime="${AGENT_RUNTIME:-codex}"

log() {
  printf '[local-poc] %s\n' "$*" >&2
}

engine_works() {
  "$1" info >/dev/null 2>&1
}

detect_engine() {
  if [[ -n "${CONTAINER_ENGINE:-}" ]]; then
    command -v "$CONTAINER_ENGINE" >/dev/null 2>&1 || {
      log "CONTAINER_ENGINE=$CONTAINER_ENGINE was not found."
      return 1
    }
    engine_works "$CONTAINER_ENGINE" || {
      log "$CONTAINER_ENGINE is installed but its service is not running."
      return 1
    }
    printf '%s' "$CONTAINER_ENGINE"
    return
  fi

  if command -v docker >/dev/null 2>&1 && engine_works docker; then
    printf 'docker'
    return
  fi

  if command -v colima >/dev/null 2>&1 && command -v docker >/dev/null 2>&1; then
    log "Docker is not reachable; starting Colima."
    colima start >&2
    if engine_works docker; then
      printf 'docker'
      return
    fi
  fi

  if command -v podman >/dev/null 2>&1; then
    if ! engine_works podman && [[ "$(uname -s)" == "Darwin" ]]; then
      log "Podman is not reachable; starting its macOS machine."
      podman machine start >&2 || true
    fi
    if engine_works podman; then
      printf 'podman'
      return
    fi
  fi

  log "No running Docker, Colima, or Podman engine was found."
  log "Install one of them, start it, and rerun this command."
  return 1
}

if [[ "$agent_runtime" != "codex" && "$agent_runtime" != "claude-code" ]]; then
  log "AGENT_RUNTIME must be 'codex' or 'claude-code'; got '$agent_runtime'."
  exit 2
fi

# Ark drives the Glass Box audit models for every runtime, not just Codex, so
# these stay required even when the Agent itself runs on another provider.
if [[ -z "${ARK_API_KEY:-}" || -z "${ARK_MODEL:-}" ]]; then
  log "ARK_API_KEY and ARK_MODEL are required."
  log "Example: ARK_API_KEY=key ARK_MODEL=ep-id ./scripts/start-local-poc.sh"
  exit 2
fi

if [[ "$agent_runtime" == "claude-code" ]]; then
  if [[ -z "${ANTHROPIC_API_KEY:-}" && -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
    log "claude-code needs a credential: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY."
    log "  Subscription (Pro/Max/Team/Enterprise) — run 'claude setup-token', then:"
    log "    AGENT_RUNTIME=claude-code CLAUDE_CODE_OAUTH_TOKEN=token \\"
    log "      ARK_API_KEY=key ARK_MODEL=ep-id ./scripts/start-local-poc.sh"
    log "  Console API key (billed against Console credit balance):"
    log "    AGENT_RUNTIME=claude-code ANTHROPIC_API_KEY=key \\"
    log "      ARK_API_KEY=key ARK_MODEL=ep-id ./scripts/start-local-poc.sh"
    exit 2
  fi
  # Claude Code ranks ANTHROPIC_API_KEY above the OAuth token, so having both
  # set silently bills the Console balance instead of the subscription.
  if [[ -n "${ANTHROPIC_API_KEY:-}" && -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
    log "Both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN are set; using the"
    log "subscription token and ignoring the API key."
  fi
fi

if [[ "$agent_runtime" == "claude-code" ]]; then
  if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
    log "Agent runtime: $agent_runtime (subscription token)"
  else
    log "Agent runtime: $agent_runtime (Console API key)"
  fi
  # Claude Code has no sandbox of its own, so this is what decides whether an
  # Agent can run a command at all. Stated at startup because the quiet
  # failure mode — an Agent that only ever reads and then reports success —
  # is hard to recognise from the outside.
  #
  # This script never names the fallback itself. It has no way to read the
  # control plane's default, and printing a second copy of it here would be a
  # claim that silently becomes false the day that default moves.
  if [[ -n "${CLAUDE_CODE_PERMISSION_MODE:-}" ]]; then
    log "Permission mode: $CLAUDE_CODE_PERMISSION_MODE"
  else
    log "Permission mode: unset — the control plane's own default applies."
    log "  Set CLAUDE_CODE_PERMISSION_MODE to choose one explicitly."
  fi
  log "  Only bypassPermissions lets an Agent run commands; under any other"
  log "  mode it can read but not act. The Runtime container is the boundary."
else
  log "Agent runtime: $agent_runtime"
fi

command -v node >/dev/null 2>&1 || {
  log "Node.js 22+ is required to run the local control plane."
  exit 2
}

# Parsed from `node --version` rather than `node -p`: the latter emits ANSI
# colour codes when the environment enables them, which made the arithmetic
# comparison below fail with a syntax error and skip the check entirely.
node_major="$(node --version | sed 's/^v//; s/\..*//')"
if [[ ! "$node_major" =~ ^[0-9]+$ ]] || (( node_major < 22 )); then
  log "Node.js 22+ is required; found $(node --version)."
  exit 2
fi

engine="$(detect_engine)"
log "Using $engine as the Agent Runtime engine."

if [[ ! -d node_modules ]]; then
  log "Installing application dependencies."
  npm ci
fi

if [[ -n "${LOCAL_POC_DATA_ROOT:-}" ]]; then
  local_state_root="$LOCAL_POC_DATA_ROOT"
  export APP_DATA_DIR="$local_state_root/data"
  export AGENT_WORKSPACE_ROOT="$local_state_root/workspaces"
  export CODEX_HOME="$local_state_root/codex-home"
  export CLAUDE_CODE_HOME="$local_state_root/claude-home"
elif [[ "$(uname -s)" == "Darwin" ]]; then
  local_state_root="${HOME}/.volc-agent-launchpad"
  export APP_DATA_DIR="${APP_DATA_DIR:-$local_state_root/data}"
  export AGENT_WORKSPACE_ROOT="${AGENT_WORKSPACE_ROOT:-$local_state_root/workspaces}"
  export CODEX_HOME="${CODEX_HOME:-$local_state_root/codex-home}"
  export CLAUDE_CODE_HOME="${CLAUDE_CODE_HOME:-$local_state_root/claude-home}"
else
  local_state_root="$repo_dir/.local"
  export APP_DATA_DIR="${APP_DATA_DIR:-$local_state_root/data}"
  export AGENT_WORKSPACE_ROOT="${AGENT_WORKSPACE_ROOT:-$local_state_root/workspaces}"
  export CODEX_HOME="${CODEX_HOME:-$local_state_root/codex-home}"
  export CLAUDE_CODE_HOME="${CLAUDE_CODE_HOME:-$local_state_root/claude-home}"
fi
export RUNTIME_INSTANCE_ID="${RUNTIME_INSTANCE_ID:-local-$(id -u)-$(printf '%s' "$repo_dir" | cksum | awk '{print $1}')}"

# Both homes are created regardless of the selected runtime so switching
# AGENT_RUNTIME between runs never leaves an unmounted directory behind.
mkdir -p "$APP_DATA_DIR" "$AGENT_WORKSPACE_ROOT" "$CODEX_HOME" "$CLAUDE_CODE_HOME"
# The Runtime container bind-mounts whichever home the selected runtime uses
# at /runtime-home (see ContainerRuntimeRunner.buildContainerRunArgs).
if [[ "$agent_runtime" == "claude-code" ]]; then
  runtime_home="$CLAUDE_CODE_HOME"
else
  runtime_home="$CODEX_HOME"
fi
log "Persistent state: $local_state_root"
export CONTAINER_USER="${CONTAINER_USER:-$(id -u):$(id -g)}"

log "Building $runtime_image from Dockerfile.runtime (base: $runtime_base_image)."
"$engine" build \
  --file Dockerfile.runtime \
  --build-arg "NODE_IMAGE=$runtime_base_image" \
  --build-arg "DEBIAN_MIRROR=$runtime_apt_mirror" \
  --build-arg "DEBIAN_SECURITY_MIRROR=$runtime_apt_security_mirror" \
  --build-arg "RUNTIME_APT_PACKAGES=$runtime_apt_packages" \
  --build-arg "CLAUDE_CODE_VERSION=$claude_code_version" \
  --tag "$runtime_image" \
  .

log "Checking that the Runtime can bind-mount the configured state directories."
preflight_user_args=(--user "$CONTAINER_USER")
if [[ "$(basename "$engine")" == "podman" ]]; then
  preflight_user_args+=(--userns keep-id)
fi
if ! "$engine" run --rm \
  "${preflight_user_args[@]}" \
  --mount "type=bind,src=$AGENT_WORKSPACE_ROOT,dst=/workspace" \
  --mount "type=bind,src=$runtime_home,dst=/runtime-home" \
  "$runtime_image" sh -lc \
    'touch /workspace/.launchpad-write-test /runtime-home/.launchpad-write-test && rm /workspace/.launchpad-write-test /runtime-home/.launchpad-write-test'; then
  log "The container engine cannot mount $local_state_root."
  log "Set LOCAL_POC_DATA_ROOT to a directory shared with Docker/Colima/Podman."
  exit 2
fi

# Codex-only: probes the Codex CLI's own inner sandbox, and CODEX_SANDBOX_MODE
# has no meaning for any other runtime.
if [[ "$agent_runtime" == "codex" ]] \
  && [[ "$codex_sandbox_mode" == "workspace-write" ]] \
  && ! "$engine" run --rm "$runtime_image" \
    codex sandbox linux --full-auto -- true >/dev/null 2>&1; then
  log "Codex Landlock is unavailable in this Linux Runtime."
  log "Falling back to danger-full-access inside the disposable container boundary."
  log "Do not mount unrelated secrets or host directories into the Agent Runtime."
  codex_sandbox_mode=danger-full-access
fi

export NODE_ENV=production
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-3000}"
export CODEX_SANDBOX_MODE="$codex_sandbox_mode"
export AGENT_RUNTIME="$agent_runtime"
export RUNTIME_PROVIDER=container
export CONTAINER_ENGINE="$engine"
export CONTAINER_RUNTIME_IMAGE="$runtime_image"

cleanup() {
  local container_ids
  container_ids="$($engine ps --all --quiet \
    --filter label=io.codejam.launchpad=agent-runtime \
    --filter "label=io.codejam.instance-id=$RUNTIME_INSTANCE_ID" 2>/dev/null || true)"
  if [[ -n "$container_ids" ]]; then
    log "Removing remaining Agent Runtime containers for $RUNTIME_INSTANCE_ID."
    while IFS= read -r container_id; do
      [[ -n "$container_id" ]] && "$engine" rm --force "$container_id" >/dev/null 2>&1 || true
    done <<<"$container_ids"
  fi
}
trap cleanup EXIT INT TERM

# Recover cleanly after a terminal or server crash from a previous local run.
cleanup

log "Building the local Web and API."
npm run build

log "Open http://localhost:$PORT"
npm start
