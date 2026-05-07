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

| Env var            | Default                | Notes                                    |
| ------------------ | ---------------------- | ---------------------------------------- |
| `BRAIN_MCP_TOKEN`  | _(required)_           | Static bearer token. `openssl rand -hex 32`. |
| `BRAIN_VAULT`      | `~/brain/vault`        | Absolute path to the vault directory.    |
| `PORT`             | `8765`                 | Loopback bind, exposed via tunnel.       |

## Exposing to Claude.ai

The server binds to `127.0.0.1` only. Put a tunnel in front of it
(Tailscale Funnel or Cloudflare Tunnel), then register the public HTTPS URL
in Claude.ai → Settings → Customize → Connectors → Add custom connector.
Set the bearer token in the connector's auth headers.

## Design notes

- **Vault is the source of truth.** Operations write directly to
  `BRAIN_VAULT`; the existing Mac-mini sync loop (`~/.local/bin/brain-sync`)
  is responsible for fanning out to iCloud and GitHub. This server has no
  knowledge of git.
- **Tools encode vault-shaped intent**, not generic file ops. Adding a
  `write_file(path, content)` would turn this into a filesystem MCP and
  defeat the point. New tools should map to a vault concept the user names
  in conversation.
- **Auth is a static bearer token** read from env. No OAuth, no per-user
  state. Single-user service.
- **Path safety:** all vault writes go through `vaultPath(...)` which
  resolves and rejects anything outside `BRAIN_VAULT`.

## License

MIT — see [LICENSE](./LICENSE).
