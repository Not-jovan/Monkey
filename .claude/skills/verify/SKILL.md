---
name: verify
description: Build, launch and drive the Launchpad control plane to observe a change at its real surface (HTTP API + served SPA).
---

# Verifying a change in this repo

The surface is the Fastify control plane on `PORT` and, in production mode,
the SPA it serves at `/`. Drive the API with curl; the UI is the same server.

## Launch

```bash
npm run build                     # both workspaces
V=$(mktemp -d); mkdir -p "$V"/{data,workspaces,claude-home,codex-home}

HOST=127.0.0.1 PORT=3199 NODE_ENV=production \
APP_DATA_DIR="$V/data" AGENT_WORKSPACE_ROOT="$V/workspaces" \
CLAUDE_CODE_HOME="$V/claude-home" CODEX_HOME="$V/codex-home" \
AGENT_RUNTIME=codex RUNTIME_PROVIDER=local-process \
ARK_API_KEY=ark-fake ARK_MODEL=ep-fake AUDIT_ENABLED=false \
node apps/server/dist/index.js > "$V/server.log" 2>&1 &
```

Always point `APP_DATA_DIR` / `AGENT_WORKSPACE_ROOT` at a scratch dir — the
defaults write into the repo and into `~/.volc-agent-launchpad`.

## Gotchas that cost time

- **`/` 404s unless `NODE_ENV=production`.** Static serving is gated on it
  (`app.ts`); in development the UI is Vite on :5173.
- **Fake Ark/Anthropic credentials are the fastest way to a failed run**, and
  a failed run is usually what you want: it exercises the runner's failure
  path, the `failures.ts` taxonomy, and the transcript in one go. A Codex run
  with a bad `ARK_API_KEY` takes ~20s (it retries); a Claude Code run with no
  credential fails in ~3s.
- **Don't grep a bundle through a shell variable** — it's ~700KB and the match
  silently fails. `curl -o file` then grep the file.
- `AUDIT_ENABLED=false` unless you're verifying audits; otherwise every run
  waits on Ark model calls that will not succeed with fake keys.

## Driving a run

```bash
AID=$(curl -s -X POST localhost:3199/api/agents -H 'content-type: application/json' \
  -d '{"name":"V"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["agent"]["id"])')
RID=$(curl -s -X POST "localhost:3199/api/agents/$AID/messages" -H 'content-type: application/json' \
  -d '{"content":"say hi"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["run"]["id"])')
curl -s "localhost:3199/api/runs/$RID"      # status, error, failure{layer,kind,remedy}
curl -s "localhost:3199/api/traces/$RID"    # spans, model, failure, evidenceComplete
cat "$V/data/run-logs/$RID.log"             # raw Runtime stdout/stderr, failures only
```

Useful surfaces: `/api/system` (runtime + model the UI shows), `/api/runs/:id`
(attribution), `/api/traces/:id` (spans), `run-logs/` (raw evidence).
