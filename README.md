# brain-mcp

An MCP server that exposes a small set of personal-Obsidian-vault operations
to Claude.ai (and other MCP clients), so that natural-language requests like
"capture this" or "add this recipe" can write directly into the vault on
disk without going through a GitHub round-trip.

Designed for a single-user, self-hosted setup: one Mac mini, a vault at
`~/brain/vault/`, and a Tailscale Funnel (or any HTTPS tunnel) putting the
service in reach of Claude.ai's custom-connector flow.

## Tools

- `capture(thought: string)` — append the thought as a new paragraph at the
  end of today's daily note (`vault/YYYY-MM-DD.md`, Europe/London). Creates
  the file if missing.
- `add_recipe(title: string, body: string)` — create
  `vault/Recipes/<title>.md` with the given markdown body. Refuses to
  overwrite an existing file. The caller is expected to compose a body that
  already matches the vault's recipe convention.

More tools (search, person/project lookups, weekly summaries) will be added
as they pay their way; see [the design notes](#design-notes) for the bar.

## Run locally

```sh
npm install
cp .env.example .env  # then fill in BRAIN_MCP_TOKEN
npm run dev           # tsx, hot-reloading
# or
npm run build && npm start
```

Smoke test the auth and health endpoints:

```sh
curl -s http://127.0.0.1:8765/healthz
curl -s -X POST http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer $BRAIN_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Configuration

| Env var                 | Default                          | Notes                                                                                              |
| ----------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `BRAIN_MCP_TOKEN`       | _(required)_                     | Static bearer token. `openssl rand -hex 32`.                                                       |
| `BRAIN_VAULT`           | `~/brain/vault`                  | Absolute path to the vault directory.                                                              |
| `PORT`                  | `8765`                           | Loopback bind, exposed via tunnel.                                                                 |
| `BRAIN_MCP_PUBLIC_URL`  | _(unset)_                        | Public HTTPS URL of the tunnel (no trailing slash). Set it to enable the OAuth + DCR endpoints used by Claude.ai's custom-connector flow. |
| `BRAIN_MCP_OAUTH_STORE` | `~/data/brain-mcp/oauth.json`    | Where DCR client records persist.                                                                  |

## Exposing to Claude.ai

The server binds to `127.0.0.1` only — Funnel (or another tunnel) is the
only public ingress. See [`docs/deploy.md`](./docs/deploy.md) for the
one-time Tailscale Funnel + Claude.ai connector setup, including token
rotation and the Cloudflare Tunnel alternative.

## Design notes

- **Vault is the source of truth.** Operations write directly to
  `BRAIN_VAULT`; the existing Mac-mini sync loop (`~/.local/bin/brain-sync`)
  is responsible for fanning out to iCloud and GitHub. This server has no
  knowledge of git.
- **Tools encode vault-shaped intent**, not generic file ops. Adding a
  `write_file(path, content)` would turn this into a filesystem MCP and
  defeat the point. New tools should map to a vault concept the user names
  in conversation.
- **Auth is a static bearer token** read from env, with an optional
  OAuth + DCR shim layered on top so Claude.ai's custom-connector UI
  can reach the same `/mcp` endpoint. The OAuth `/token` endpoint
  hands back the same `BRAIN_MCP_TOKEN`; `/authorize` is gated by a
  one-shot HTML form that asks for the token, since the public-facing
  endpoints would otherwise let anyone reaching the tunnel mint a token.
  Single-user service — no per-user state, no consent screen, no scopes.
- **Path safety:** all vault writes go through `vaultPath(...)` which
  resolves and rejects anything outside `BRAIN_VAULT`.

## License

MIT — see [LICENSE](./LICENSE).
