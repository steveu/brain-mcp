# brain-mcp ops

Persistent-run setup for brain-mcp on the Mac mini, via launchd.

Two launchd jobs run side by side, each its own process on its own loopback
port, sharing the repo-root `.env`:

- **brain-mcp** — the MCP server on `127.0.0.1:8765` (`/mcp`, OAuth).
- **trails** — the standalone map service on `127.0.0.1:8766`: serves
  walk_route draft HTML (`GET /<id>`) and proxies OS raster tiles
  (`GET /tiles/<layer>/<z>/<x>/<y>.png`) with the OS Data Hub key injected
  server-side. Separate port so its public exposure is independent of `/mcp`.

## Layout

- `launchd/st.urm.brain-mcp.plist` — the MCP server launchd job. Installed into `~/Library/LaunchAgents/`.
- `launchd/st.urm.trails.plist` — the trails map service launchd job. Installed into `~/Library/LaunchAgents/`.
- `../.env.example` — template for the repo-root `.env`, the file both launchers source at startup.
- The launchers live in the repo at `bin/brain-mcp-launcher` and `bin/trails-launcher`.

The token does **not** live in the plist. It lives in the repo-root `.env` (mode 600, gitignored), which the launcher sources before exec-ing Node. Rotating the token is one file edit + one kickstart, no plist surgery.

## Logs

Structured Node logs live under `~/data/brain-mcp/logs/` alongside the rest of the project's runtime state (`audit.log`, `oauth.json`). Launchd-managed stdout/stderr stays in `~/Library/Logs/` because launchd writes those itself.

- `~/data/brain-mcp/logs/brain-mcp.json` — symlink that always points at the active rotated JSON log. This is the stable `tail -F` target. Override with `BRAIN_MCP_LOG_FILE`.
- `~/data/brain-mcp/logs/brain-mcp.{N}.json` — rotated structured JSON log files (one line per HTTP request, plus tool-call and auth-failure entries). Rotated by `pino-roll` once a file exceeds ~5MB; up to 5 rotated files are kept (e.g. `brain-mcp.1.json`, `brain-mcp.2.json`).
- `~/data/brain-mcp/logs/current.log` — `pino-roll`'s own symlink to the active rotated file; the `brain-mcp.json` symlink above points at this one.
- `~/Library/Logs/brain-mcp.log` — script-level fallback (launcher banner, env-file errors, anything Node writes to stdout/stderr after `exec`).
- `~/Library/Logs/brain-mcp.launchd.log` — launchd-level (process supervision, throttle messages).

The trails map service mirrors this: structured JSON at
`~/data/brain-mcp/logs/trails.json` (override with `TRAILS_LOG_FILE`),
script-level fallback at `~/Library/Logs/trails.log`, and launchd-level at
`~/Library/Logs/trails.launchd.log`. The OS Data Hub key never appears in any
of these — the proxy logs paths only, never the upstream URL.

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

## One-time install — trails map service

The same `npm run build` produces `dist/trails-main.js`; the same repo-root
`.env` supplies its config. Add `OS_API_KEY` (and optionally `TRAILS_PORT`,
`TRAILS_DRAFT_TTL_HOURS`) to the `.env` before loading the job — the launcher
exits if `OS_API_KEY` is unset. Then:

```sh
# Install and load the second launchd job
cp ops/launchd/st.urm.trails.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/st.urm.trails.plist

# Verify — binds 127.0.0.1 only, like the MCP server
curl -s http://127.0.0.1:8766/healthz
tail -n 50 ~/Library/Logs/trails.log
```

`/healthz` returns `{"ok":true}`. Drafts under `~/data/trails/` (or
`TRAILS_DATA_DIR`) are swept after `TRAILS_DRAFT_TTL_HOURS` (default 7 days);
the sweep runs at startup and hourly thereafter.

Public exposure (`trails.urmston.org`) is a separate later step — it needs DNS
and a Cloudflare Tunnel ingress rule, tracked in #35 and out of scope here. The
service binds `127.0.0.1` until then.

## Reload after a code change

```sh
cd ~/code/brain-mcp && npm run build
launchctl kickstart -k gui/$(id -u)/st.urm.brain-mcp
launchctl kickstart -k gui/$(id -u)/st.urm.trails
```

## Disable temporarily

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/st.urm.brain-mcp.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/st.urm.trails.plist
```

Re-enable with `bootstrap` again. The two jobs are independent — booting out one
leaves the other running.

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
