# Deploying brain-mcp behind Claude.ai

One-time setup to take brain-mcp from "running on the Mac mini" to "callable
from a Claude.ai chat". Assumes the server is already running locally — see
[README — Run locally](../README.md#run-locally) for that — and that the
launchd job in [`ops/README.md`](../ops/README.md) is the supervisor.

> **Status (2026-05-15).** Public ingress is a Cloudflare Tunnel fronting
> `brain.example.org`. brain-mcp serves OAuth metadata, DCR, and a
> token-gated `/authorize` page alongside the bearer-protected `/mcp`
> endpoint, so the Claude.ai custom-connector UI can register against
> it. Bearer auth on `/mcp` is unchanged for clients that can send
> custom headers (Claude Code, the Claude API's `mcp_servers` field,
> raw `curl`). The previous edge was Tailscale Funnel; the move is
> recorded in the footnote at the bottom.

The shape:

```
Claude.ai  →  https://brain.example.org  →  cloudflared (outbound)  →  127.0.0.1:8765
```

The server binds to `127.0.0.1` only (see `src/main.ts`) — `cloudflared`
holds an outbound connection to Cloudflare, so there are no inbound
ports or port forwarding to manage. If the tunnel ever drops, the
service goes dark rather than fails open on `0.0.0.0`. Defence in
depth.

## How `cloudflared` is wired up on the mini

`cloudflared` runs as a single user launch agent
(`~/Library/LaunchAgents/com.YOU.edge.cloudflared.plist`) supervising
one tunnel — `mac-mini-edge` — whose config lives at
`~/code/edge/cloudflared/config.yml`. Adding a new public hostname
means adding an `ingress:` rule there, not creating a second tunnel.
Today the config fans out to both `pitchside.example.org` and
`brain.example.org`:

```yaml
tunnel: <mac-mini-edge-uuid>
credentials-file: /Users/YOU/code/edge/cloudflared/<uuid>.json

ingress:
  - hostname: pitchside.example.org
    service: http://localhost:8080
  - hostname: brain.example.org
    service: http://127.0.0.1:8765
  - service: http_status:404
```

The trailing catch-all is required by `cloudflared`. Anything that
doesn't match a hostname rule gets a 404 rather than reaching a local
service.

## 1. Add the hostname to the tunnel

From the mini, with `cloudflared` already authenticated against the
Cloudflare account that owns `example.org`:

```sh
cloudflared tunnel route dns mac-mini-edge brain.example.org
```

That writes the `CNAME` for `brain.example.org` pointing at the
`mac-mini-edge` tunnel. Proxied through Cloudflare, so TLS terminates
at the edge.

## 2. Add the ingress rule

Edit `~/code/edge/cloudflared/config.yml` to add the `brain.example.org`
entry above. Validate before reloading:

```sh
cloudflared tunnel --config ~/code/edge/cloudflared/config.yml ingress validate
```

Reload the launch agent so the new rule is live:

```sh
launchctl kickstart -k gui/$(id -u)/com.YOU.edge.cloudflared
```

`cloudflared tunnel info mac-mini-edge` should show four active edge
connections within a few seconds.

## 3. Point brain-mcp at the new public URL

Set `BRAIN_MCP_PUBLIC_URL` in the repo-root `.env` (no trailing slash,
scheme included):

```
BRAIN_MCP_PUBLIC_URL=https://brain.example.org
```

Restart the brain-mcp launchd job so the OAuth endpoints come up bound
to the new host:

```sh
launchctl kickstart -k gui/$(id -u)/st.urm.brain-mcp
```

Smoke-test the public surface:

```sh
curl -s https://brain.example.org/healthz
curl -s https://brain.example.org/.well-known/oauth-protected-resource/mcp
curl -s https://brain.example.org/.well-known/oauth-authorization-server
```

All three should return JSON. The `issuer` / `resource` fields should
reflect `brain.example.org`. `/healthz` is unauthenticated
(`src/server.ts:198`), so it doubles as the probe target for an
external uptime monitor (UptimeRobot or similar) — point one at it
the day of cutover for a clean baseline.

## 4. Register the connector in Claude.ai

If you're migrating from a previous host, delete
`~/data/brain-mcp/oauth.json` first so DCR re-registers cleanly — the
old `client_id` was issued against the previous host and Claude.ai
rejects it once the issuer changes.

Then in Claude.ai:

1. **Settings → Connectors.** Remove the old `brain` connector if one
   exists.
2. **Add custom connector.**
3. **Name:** `brain` (or whatever; it's only the chat-UI label).
4. **URL:** `https://brain.example.org/mcp`. Claude.ai discovers the
   authorization server via `WWW-Authenticate` on the first 401 and
   the protected-resource metadata document.
5. **OAuth:** leave the **client ID** and **client secret** fields blank.
   brain-mcp supports Dynamic Client Registration, so Claude.ai will
   register itself at `/register` and persist the issued credentials.
6. Save. Claude.ai opens a tab pointed at `/authorize`. Paste your
   `BRAIN_MCP_TOKEN` into the form on that page and submit — the page
   redirects back to Claude.ai with the auth code, which Claude.ai
   exchanges at `/token`. The connector then calls `tools/list` and
   `capture` and `add_recipe` show up as available tools.

The DCR record persists at `~/data/brain-mcp/oauth.json`; deleting it
forces Claude.ai to re-register on the next connector add.

Clients that accept custom headers don't need any of this — they can
keep using the bearer token directly:

- **Claude Code** — point an MCP server at the same URL with a
  `headersHelper` that emits `Authorization: Bearer $BRAIN_MCP_TOKEN`.
- **Claude API** — pass the URL and token in the request's `mcp_servers`
  field.
- **Raw HTTP** — see the `curl` smoke tests in the README.

## 5. Smoke test from Claude.ai

In a Claude.ai chat with the connector enabled:

> capture this: brain-mcp wired up end-to-end on $(date)

Then check today's daily note (`~/brain/vault/YYYY-MM-DD.md`) for the new
line. If it didn't land, in order of likelihood:

- Connector auth header wrong → `curl` the URL with `-H "Authorization:
  Bearer ..."` and see what the server returns.
- Tunnel not running → `cloudflared tunnel info mac-mini-edge` should
  show active connections; `launchctl list | grep cloudflared` should
  show the agent loaded.
- Server not running → `curl http://127.0.0.1:8765/healthz` on the Mac
  mini; if that fails, see [`ops/README.md`](../ops/README.md) for
  launchd debugging.

## The trails map service (second process)

The walk-route preview map and OS tile proxy run as a **separate** Node process
on its own loopback port — `127.0.0.1:8766` by default (`TRAILS_PORT`), distinct
from the MCP server's `8765`. Keeping it on its own port means its public
exposure is independent of the `/mcp` connector. It is supervised by its own
launchd job (`st.urm.trails`); see [`ops/README.md`](../ops/README.md) for the
one-time install. Like the MCP server it binds `127.0.0.1` only — nothing is
reachable from the LAN until a tunnel fronts it.

What it serves:

- `GET /<id>` → the interactive route-preview HTML for a walk_route draft.
- `GET /tiles/<layer>/<z>/<x>/<y>.png` → the corresponding `api.os.uk` raster
  tile, with the OS Data Hub key (`OS_API_KEY`) injected server-side. The key
  never appears in any client-visible response, header, or log line.
- `GET /healthz` → `{"ok":true}`, the tunnel readiness probe.

Public exposure at `trails.urmston.org` is a **separate, later step** — it
needs a DNS record and a Cloudflare Tunnel ingress rule (another `hostname:`
entry in `~/code/edge/cloudflared/config.yml` pointing at
`http://127.0.0.1:8766`, following the same shape as `brain.urmston.org`
above). That work is tracked in #35 and is out of scope here; until it lands
the service is loopback-only and `TRAILS_HOST` stays unset.

## Token rotation

The token sits in three places: the repo-root `.env`, the launched
process (in-memory), and the Claude.ai connector header. Rotate all three
in order:

```sh
openssl rand -hex 32                                       # 1. new token
$EDITOR ~/code/brain-mcp/.env                              # 2. paste it
launchctl kickstart -k gui/$(id -u)/st.urm.brain-mcp       # 3. restart server
# 4. update Authorization header in Claude.ai → Connectors → brain
```

Between steps 3 and 4 the connector will 401. That's the point — old
tokens stop working immediately.

## Footnote — previous edge: Tailscale Funnel

The original edge for brain-mcp was Tailscale Funnel at
`https://<machine>.<tailnet>.ts.net/mcp`. Funnel is one command and
zero new accounts, so it was the right choice to get the service
callable from Claude.ai for the first time. The service went down twice
on 2026-05-15 from the perspective of both Claude Code and Claude.ai
while the local node process on `127.0.0.1:8765` was demonstrably
healthy throughout (uptime > 4h, sub-2ms response to authed probes) —
which ruled out brain-mcp itself; the failure was somewhere in the
Funnel / Claude.ai-edge path. Diagnosis is correlational, not proven —
the move to Cloudflare addresses all plausible failure modes (Funnel
itself, the Funnel↔Claude.ai hop, Claude.ai's edge being squeamish
about `*.ts.net` hostnames) equally.

To bring Funnel back as a fallback:

```sh
tailscale funnel --bg 8765
```

And set `BRAIN_MCP_PUBLIC_URL` to the resulting `*.ts.net` hostname.
Tear down with `tailscale funnel reset`. `tailscaled` itself stays
running regardless — it's still the path for admin SSH.
