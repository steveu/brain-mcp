import { statSync } from "node:fs";
import { z } from "zod";
import type { AllowlistEntry } from "../allowlist.js";
import { buildAllowlistIndex, redactLinks } from "../redact.js";
import { read, resolveInAllowlist, vaultRelativeOf, walk } from "../vault-fs.js";
import type { ReadDeps, ReadTool } from "./types.js";

const GREP_MAX_MATCHES = 200;
const GREP_LINE_CAP = 240;

export type GrepArgs = {
  query: string;
  path?: string;
};

type Bucket = Record<string, number>;

function bumpBucket(b: Bucket, prefix: string, by: number): void {
  if (by <= 0) return;
  b[prefix] = (b[prefix] ?? 0) + by;
}

function collectMd(start: string, entry: AllowlistEntry, out: string[]): void {
  let stats;
  try {
    stats = statSync(start);
  } catch {
    return;
  }
  if (stats.isFile()) {
    if (start.toLowerCase().endsWith(".md")) out.push(start);
    return;
  }
  if (!stats.isDirectory()) return;
  for (const item of walk(start, entry)) {
    if (item.kind === "file" && item.abs.toLowerCase().endsWith(".md")) {
      out.push(item.abs);
    }
  }
}

export function runGrep(deps: ReadDeps, args: GrepArgs): string {
  const allowlist = deps.allowlist();
  const query = args.query;
  if (!query) throw new Error("query is required");

  const index = buildAllowlistIndex(allowlist);
  const needle = query.toLowerCase();
  const lines: string[] = [];
  const pathsReturned: string[] = [];
  const redactions: Bucket = {};
  let matchCount = 0;

  type Root = { entry: AllowlistEntry; start: string };
  const roots: Root[] = (() => {
    if (!args.path) {
      return allowlist.entries.map((entry) => ({ entry, start: entry.absolutePath }));
    }
    const resolved = resolveInAllowlist(allowlist, args.path);
    if (!resolved) throw new Error(`path not in allowlist: ${args.path}`);
    return [{ entry: resolved.entry, start: resolved.absolutePath }];
  })();

  outer: for (const { entry, start } of roots) {
    const files: string[] = [];
    collectMd(start, entry, files);
    files.sort();

    for (const file of files) {
      let text;
      try {
        text = read(file);
      } catch {
        continue;
      }
      const fileLines = text.split("\n");
      const fileMatches: { line: number; text: string }[] = [];
      for (let i = 0; i < fileLines.length; i++) {
        const raw = fileLines[i] ?? "";
        if (raw.toLowerCase().includes(needle)) {
          const redacted = redactLinks(raw, allowlist, index);
          bumpBucket(redactions, entry.vaultRelative, redacted.redactionCount);
          let snippet = redacted.text;
          if (snippet.length > GREP_LINE_CAP) {
            snippet = snippet.slice(0, GREP_LINE_CAP) + "…";
          }
          fileMatches.push({ line: i + 1, text: snippet });
          matchCount++;
          if (matchCount >= GREP_MAX_MATCHES) break;
        }
      }
      if (fileMatches.length > 0) {
        const rel = vaultRelativeOf(allowlist, file);
        pathsReturned.push(rel);
        lines.push(rel);
        for (const m of fileMatches) {
          lines.push(`  ${m.line}: ${m.text}`);
        }
      }
      if (matchCount >= GREP_MAX_MATCHES) {
        lines.push(`(truncated at ${GREP_MAX_MATCHES} matches — narrow the query or use 'path')`);
        break outer;
      }
    }
  }

  deps.audit.record({
    ts: new Date().toISOString(),
    tool: "grep",
    args: { query, path: args.path ?? null },
    paths_returned: pathsReturned,
    redactions_by_prefix: redactions,
  });

  if (lines.length === 0) return `no matches for ${JSON.stringify(query)}`;
  return lines.join("\n");
}

export const grepTool: ReadTool<GrepArgs> = {
  name: "grep",
  title: "Search allowlisted vault notes",
  description:
    "Case-insensitive literal substring search across allowlisted vault notes. " +
    "Use when the listing is too long to skim or when the user asks for a keyword (ingredient, project name, place). " +
    "Returns matches grouped by file, each as 'line-number: line-content'. " +
    "Wikilinks and markdown links pointing outside the allowlist are replaced with [[redacted]] / [redacted] in the output. " +
    "Pass an optional 'path' to limit the search to one allowlisted folder.",
  inputSchema: {
    query: z
      .string()
      .min(1)
      .describe("Literal substring to search for. Case-insensitive. No regex."),
    path: z
      .string()
      .optional()
      .describe(
        "Optional vault-relative folder to limit the search to, e.g. 'Recipes'. Must be inside the allowlist.",
      ),
  },
  run: runGrep,
};
