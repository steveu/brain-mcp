# Writes are not audited; reads are

The `AuditSink` is threaded into `ReadDeps` but not `WriteDeps`, so `list` / `fetch` / `grep` append a JSONL line to `BRAIN_MCP_AUDIT_LOG` per call while `capture` / `add_recipe` / `create_match` leave no audit trail. This is deliberate, not an oversight.

The audit log exists to give the user visibility into what the model *saw* of their private notes — it records paths returned and redaction counts per allowlist prefix, the read-side privacy concern that ADR-0001 frames. Writes have no analogous concern: they target fixed roots (`Matches/`, `Recipes/`, the daily note), never consult the allowlist, and only fire on explicit user-initiated intent ("capture this", "save this recipe"). The vault file itself, plus the existing `brain-sync` git history, is already the after-the-fact record of what was written and when — duplicating that in a JSONL would add noise without adding visibility.

If writes ever become anything other than user-initiated explicit intent — e.g. an auto-summariser writing to the vault on a schedule, or a tool that mutates allowlisted notes rather than appending to fixed roots — revisit this and thread `AuditSink` into `WriteDeps`. The trigger is "writes the user didn't explicitly ask for in this turn," not "writes exist."
