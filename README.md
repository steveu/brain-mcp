# brain-mcp

An MCP server that exposes a small set of personal-Obsidian-vault operations
to Claude.ai (and other MCP clients), so that natural-language requests like
"capture this" or "add this recipe" can write directly into the vault on
disk without going through a GitHub round-trip.

Designed for a single-user, self-hosted setup: one Mac mini, a vault at
`~/brain/vault/`, and a Tailscale Funnel (or any HTTPS tunnel) putting the
service in reach of Claude.ai's custom-connector flow.

## Tools

### Write

- `capture(thought: string)` — append the thought as a new paragraph at the
  end of today's daily note (`vault/YYYY-MM-DD.md`, Europe/London). Creates
  the file if missing.
- `add_recipe(title: string, body: string)` — create
  `vault/Recipes/<title>.md` with the given markdown body. Refuses to
  overwrite an existing file. The caller is expected to compose a body that
  already matches the vault's recipe convention.
- `create_match(opposition: string, team: string, date?: string)` — create
  a match note at `vault/Matches/<date> — <team> vs <opposition>.md` from
  the `vault/Templates/Match.md` template, with `date` / `opposition` /
  `team` substituted into frontmatter and the H1 placeholders. Date
  defaults to today (Europe/London). Refuses to overwrite an existing
  match. Other frontmatter fields are left at their template defaults:
  result / position / minutes etc. blank for the user to fill in after
  the match; the 11 event-tally keys (`passes_completed`, `goals`, …)
  default to `0` and are written by [pitchside](https://github.com/steveu/pitchside)
  during the match — `create_match` itself never touches them.

### Read (allowlist-scoped)

The read tools are scoped to a configurable allowlist of vault directories
(see `BRAIN_MCP_ALLOWLIST` below). Anything outside is private and
unreachable.

- `list(path?: string)` — recursive tree of allowlisted notes, with each
  note's frontmatter and first H1 inlined so the model can pick candidates
  without fetching every file. `path` (optional) scopes the listing to one
  allowlisted folder or file.
- `fetch(path: string)` — read a single allowlisted note by vault-relative
  path. Hard-rejects anything outside the allowlist (including via `..` or
  symlinks).
- `grep(query: string, path?: string)` — case-insensitive literal substring
  search across allowlisted notes. Returns matches grouped by file as
  `line-number: line-content`. `path` (optional) limits the search.

All three apply wikilink / markdown-link redaction: any link whose target
falls outside the allowlist is replaced with `[[redacted]]` / `[redacted]`,
aliases dropped. Defence in depth — the primary boundary is the allowlist
itself.

Every read call appends a JSONL line to `BRAIN_MCP_AUDIT_LOG` (default
`~/data/brain-mcp/audit.log`): timestamp, tool, args, paths returned,
redaction count by allowlist prefix. No content. Writes (`capture`,
`add_recipe`, `create_match`) are deliberately not audited — see
[`docs/adr/0003`](./docs/adr/0003-writes-are-not-audited.md).

More tools (person/project lookups, weekly summaries) will be added as they
pay their way; see [the design notes](#design-notes) for the bar.

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
| `BRAIN_MCP_ALLOWLIST`   | `<parent of BRAIN_VAULT>/allowlist` | Plain-text list of vault-relative dirs the read tools may expose. Re-read on every `list`/`fetch`/`grep` call. Server fails closed at startup if missing. |
| `BRAIN_MCP_AUDIT_LOG`   | `~/data/brain-mcp/audit.log`     | JSONL audit log appended on every read tool call. Local-only, append-only, no content.             |

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
- **Static long-lived token is a deliberate deviation from current MCP
  spec direction.** The 2026 authorisation spec points at short-lived
  access tokens with refresh, ideally backed by a real authorisation
  server (Auth0 / Stytch / WorkOS / Keycloak). For a single-user,
  Tailscale-only deployment the practical risk is low and the cost of
  adopting that model is high, so brain-mcp deliberately stays simple.
  If this server ever exposes more than one user, gets reachable
  outside the tailnet, or grows per-tool scopes, swap the static token
  for a real AS before doing anything else.
- **Path safety:** all vault writes go through `resolveUnderVault(...)`
  in `src/vault-fs.ts`, which resolves and rejects anything outside
  `BRAIN_VAULT`. Read tools resolve through `resolveInAllowlist(...)`
  (same module) which canonicalises via `realpath` and rejects anything
  outside an allowlisted root, so symlinks and `..` can't escape the
  boundary.
- **Read scope is config, not code.** The `BRAIN_MCP_ALLOWLIST` file is the
  source of truth for what the read tools may expose. It's re-read on every
  call, so editing it updates exposure without restart. Adding a path is
  the explicit consent gesture; privacy is the default. Reasoning in
  [`docs/adr/0003`](https://github.com/steveu/brain/blob/main/docs/adr/0003-brain-mcp-allowlist-scope-and-trust-boundary.md)
  in the brain repo.

## License

MIT — see [LICENSE](./LICENSE).
