# brain-mcp ops

Persistent-run setup for brain-mcp on the Mac mini, via launchd.

## Layout

- `launchd/st.urm.brain-mcp.plist` — the launchd job. Installed into `~/Library/LaunchAgents/`.
- `../.env.example` — template for the repo-root `.env`, the file the launcher sources at startup.
- The launcher itself lives in the repo at `bin/brain-mcp-launcher`.

The token does **not** live in the plist. It lives in the repo-root `.env` (mode 600, gitignored), which the launcher sources before exec-ing Node. Rotating the token is one file edit + one kickstart, no plist surgery.

## Logs

Structured Node logs live under `~/data/brain-mcp/logs/` alongside the rest of the project's runtime state (`audit.log`, `oauth.json`). Launchd-managed stdout/stderr stays in `~/Library/Logs/` because launchd writes those itself.

- `~/data/brain-mcp/logs/brain-mcp.json` — symlink that always points at the active rotated JSON log. This is the stable `tail -F` target. Override with `BRAIN_MCP_LOG_FILE`.
- `~/data/brain-mcp/logs/brain-mcp.{N}.json` — rotated structured JSON log files (one line per HTTP request, plus tool-call and auth-failure entries). Rotated by `pino-roll` once a file exceeds ~5MB; up to 5 rotated files are kept (e.g. `brain-mcp.1.json`, `brain-mcp.2.json`).
- `~/data/brain-mcp/logs/current.log` — `pino-roll`'s own symlink to the active rotated file; the `brain-mcp.json` symlink above points at this one.
- `~/Library/Logs/brain-mcp.log` — script-level fallback (launcher banner, env-file errors, anything Node writes to stdout/stderr after `exec`).
- `~/Library/Logs/brain-mcp.launchd.log` — launchd-level (process supervision, throttle messages).

To tail the structured log:

```sh
tail -F ~/data/brain-mcp/logs/brain-mcp.json | jq .
```

## Prerequisites

Homebrew node at `/opt/homebrew/bin/node` (the launcher exec's it directly, not via `which`). This is intentional: nvm-versioned paths break on every node upgrade, and sourcing nvm in a launcher is slow and fragile. Install with `brew install node`. Brew will warn that node is "shadowed by nvm" — that's expected; nvm still owns your interactive shell.

## One-time install

```sh
# 1. Build the server bundle the launcher exec's into
cd ~/code/brain-mcp
npm install
npm run build

# 2. Create the env file (mode 600), populate BRAIN_MCP_TOKEN
cp .env.example .env
chmod 600 .env
$EDITOR .env

# 3. Install the launchd plist
cp ops/launchd/st.urm.brain-mcp.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/st.urm.brain-mcp.plist

# 4. Verify
curl -s http://127.0.0.1:8765/healthz
tail -n 50 ~/Library/Logs/brain-mcp.log
```

## Reload after a code change

```sh
cd ~/code/brain-mcp && npm run build
launchctl kickstart -k gui/$(id -u)/st.urm.brain-mcp
```

## Disable temporarily

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/st.urm.brain-mcp.plist
```

Re-enable with `bootstrap` again.

## Rotate the token

```sh
# 1. Generate a new token, edit it into the env file
openssl rand -hex 32  # copy the output
$EDITOR .env  # update BRAIN_MCP_TOKEN=...

# 2. Kickstart so the launcher re-sources the env file
launchctl kickstart -k gui/$(id -u)/st.urm.brain-mcp

# 3. Update the bearer token in Claude.ai → Settings → Connectors → brain-mcp
```

## Reboot test

After install, reboot the Mac mini and confirm:

```sh
curl -s http://127.0.0.1:8765/healthz
grep "brain-mcp listening" ~/Library/Logs/brain-mcp.log | tail
```

The first line should return `{"ok":true,...}`; the second should show a recent `listening on …` line.
