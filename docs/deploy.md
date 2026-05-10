# Deploying brain-mcp behind Claude.ai

One-time setup to take brain-mcp from "running on the Mac mini" to "callable
from a Claude.ai chat". Assumes the server is already running locally — see
[README — Run locally](../README.md#run-locally) for that — and that the
launchd job in [`ops/README.md`](../ops/README.md) is the supervisor.

> **Status (2026-05-07).** All three steps work today. brain-mcp now
> serves OAuth metadata, DCR, and a token-gated `/authorize` page
> alongside the bearer-protected `/mcp` endpoint, so the Claude.ai
> custom-connector UI can register against it. Bearer auth on `/mcp`
> is unchanged for clients that can send custom headers (Claude Code,
> the Claude API's `mcp_servers` field, raw `curl`).

The shape:

```
Claude.ai  →  https://<host>.<tailnet>.ts.net  →  Tailscale Funnel  →  127.0.0.1:8765
```

The server binds to `127.0.0.1` only (see `src/main.ts`) — the tunnel is
the only public ingress. If Funnel ever drops, the service goes dark rather
than fails open on `0.0.0.0`. Defence in depth.

## 1. Enable Funnel on the tailnet

Funnel is gated by a node attribute in the tailnet policy. In the
[Tailscale admin console](https://login.tailscale.com/admin/acls/file),
add `funnel` to the `nodeAttrs` block (existing entries kept):

```json
{
  "nodeAttrs": [
    { "target": ["autogroup:member"], "attr": ["funnel"] }
  ]
}
```

Save. MagicDNS must also be enabled (admin console → DNS → MagicDNS).

## 2. Start Funnel on the Mac mini

```sh
tailscale funnel --bg 8765
```

The `--bg` flag persists the configuration across reboots and across
`tailscaled` restarts — no extra launchd job needed. Funnel always listens
publicly on 443; the `8765` arg is the local port it forwards to.

Verify:

```sh
tailscale funnel status
curl -s https://$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')/healthz
```

The `/healthz` response should be `{"ok":true,"vault":"..."}`. The hostname
is your Mac mini's MagicDNS name, e.g. `mini.tailnet-name.ts.net`.

To stop:

```sh
tailscale funnel --bg off
```

## 3. Register the connector in Claude.ai

Set `BRAIN_MCP_PUBLIC_URL` in the repo-root `.env` to the same
hostname Funnel exposes (no trailing slash, scheme included), e.g.
`https://mini.tail-xxxx.ts.net`. Restart the launchd job so the OAuth
endpoints come up:

```sh
launchctl kickstart -k gui/$(id -u)/st.urm.brain-mcp
```

Smoke-test the metadata endpoints:

```sh
curl -s https://mini.tail-xxxx.ts.net/.well-known/oauth-protected-resource
curl -s https://mini.tail-xxxx.ts.net/.well-known/oauth-authorization-server
```

Both should return JSON. Then in Claude.ai:

1. **Settings → Connectors → Add custom connector.**
2. **Name:** `brain` (or whatever; it's only the chat-UI label).
3. **URL:** `https://<host>.<tailnet>.ts.net/mcp`. Claude.ai discovers
   the authorization server via `WWW-Authenticate` on the first 401 and
   the protected-resource metadata document.
4. **OAuth:** leave the **client ID** and **client secret** fields blank.
   brain-mcp supports Dynamic Client Registration, so Claude.ai will
   register itself at `/register` and persist the issued credentials.
5. Save. Claude.ai opens a tab pointed at `/authorize`. Paste your
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

## 4. Smoke test from Claude.ai

In a Claude.ai chat with the connector enabled:

> capture this: brain-mcp wired up end-to-end on $(date)

Then check today's daily note (`~/brain/vault/YYYY-MM-DD.md`) for the new
line. If it didn't land, in order of likelihood:

- Connector auth header wrong → `curl` the URL with `-H "Authorization:
  Bearer ..."` and see what the server returns.
- Funnel not running → `tailscale funnel status` should show port 443
  forwarding to `127.0.0.1:8765`.
- Server not running → `curl http://127.0.0.1:8765/healthz` on the Mac
  mini; if that fails, see [`ops/README.md`](../ops/README.md) for
  launchd debugging.

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

## Cloudflare Tunnel (alternative)

If Tailscale Funnel doesn't fit (e.g. you want a custom domain rather than
`*.ts.net`), Cloudflare Tunnel covers the same shape: long-lived
authenticated tunnel from the Mac mini outbound to Cloudflare, public
HTTPS hostname on a domain you control.

Sketch, not a full recipe:

```sh
brew install cloudflared
cloudflared tunnel login                                   # browser auth
cloudflared tunnel create brain-mcp
cloudflared tunnel route dns brain-mcp brain.example.com
cloudflared tunnel run --url http://127.0.0.1:8765 brain-mcp
```

For persistence, `cloudflared service install` registers a launchd job.
The Claude.ai connector setup (step 3 above) is identical — the only
difference is the URL.

Pick Cloudflare Tunnel if the domain matters; otherwise Tailscale Funnel
is one command and zero new accounts.
