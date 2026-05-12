import { statSync } from "node:fs";
import { z } from "zod";
import { buildAllowlistIndex, redactLinks } from "../redact.js";
import { read, resolveInAllowlist, vaultRelativeOf } from "../vault-fs.js";
import type { ReadDeps, ReadTool } from "./types.js";

export type FetchArgs = {
  path: string;
};

export function runFetch(deps: ReadDeps, args: FetchArgs): string {
  const allowlist = deps.allowlist();
  const resolved = resolveInAllowlist(allowlist, args.path);
  if (!resolved) {
    throw new Error(`path not in allowlist: ${args.path}`);
  }
  let stats;
  try {
    stats = statSync(resolved.absolutePath);
  } catch {
    throw new Error(`path not readable: ${args.path}`);
  }
  if (!stats.isFile()) {
    throw new Error(`path is not a file: ${args.path}`);
  }
  const text = read(resolved.absolutePath);
  const index = buildAllowlistIndex(allowlist);
  const redacted = redactLinks(text, allowlist, index);

  deps.audit.record({
    ts: new Date().toISOString(),
    tool: "fetch",
    args: { path: args.path },
    paths_returned: [vaultRelativeOf(allowlist, resolved.absolutePath)],
    redactions_by_prefix: redacted.redactionCount > 0
      ? { [resolved.entry.vaultRelative]: redacted.redactionCount }
      : {},
  });

  return redacted.text;
}

export const fetchTool: ReadTool<FetchArgs> = {
  name: "fetch",
  title: "Fetch an allowlisted vault note",
  description:
    "Read a single note from the vault by path. Hard-rejected if the path is not inside the brain-mcp allowlist (see ./allowlist). " +
    "Use after 'list' has surfaced a candidate, or when the user names a note directly. " +
    "Wikilinks and markdown links pointing outside the allowlist are replaced with [[redacted]] / [redacted]; " +
    "the server will not follow those links across the boundary, so don't try to fetch redacted targets.",
  inputSchema: {
    path: z
      .string()
      .min(1)
      .describe(
        "Vault-relative path to a note, e.g. 'Recipes/Lemon, Greens & Sausage Pasta.md'. Must resolve inside the allowlist.",
      ),
  },
  run: runFetch,
};
