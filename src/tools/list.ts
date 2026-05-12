import { statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Allowlist, AllowlistEntry } from "../allowlist.js";
import { buildAllowlistIndex, redactLinks } from "../redact.js";
import { read, resolveInAllowlist, vaultRelativeOf, walk } from "../vault-fs.js";
import type { ReadDeps, ReadTool } from "./types.js";

const FRONTMATTER_LINE_CAP = 12;

export type ListArgs = {
  path?: string;
};

type Bucket = Record<string, number>;

function bumpBucket(b: Bucket, prefix: string, by: number): void {
  if (by <= 0) return;
  b[prefix] = (b[prefix] ?? 0) + by;
}

type Frontmatter = {
  raw: string | null;
  body: string;
};

function splitFrontmatter(text: string): Frontmatter {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { raw: null, body: text };
  return { raw: m[1] ?? "", body: text.slice(m[0].length) };
}

function firstH1(body: string): string | null {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? (m[1] ?? null) : null;
}

function indentLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

function walkAndRender(
  allowlist: Allowlist,
  index: ReturnType<typeof buildAllowlistIndex>,
  entry: AllowlistEntry,
  root: string,
  lines: string[],
  pathsReturned: string[],
  redactions: Bucket,
): void {
  for (const item of walk(root, entry)) {
    const indent = "  ".repeat(item.depth);
    if (item.kind === "dir") {
      lines.push(`${indent}${path.basename(item.abs)}/`);
    } else {
      renderFile(allowlist, index, entry, item.abs, item.depth, lines, pathsReturned, redactions);
    }
  }
}

function renderFile(
  allowlist: Allowlist,
  index: ReturnType<typeof buildAllowlistIndex>,
  entry: AllowlistEntry,
  abs: string,
  depth: number,
  lines: string[],
  pathsReturned: string[],
  redactions: Bucket,
): void {
  const indent = "  ".repeat(depth);
  const inner = "  ".repeat(depth + 1);
  const name = path.basename(abs);
  pathsReturned.push(vaultRelativeOf(allowlist, abs));

  if (!name.toLowerCase().endsWith(".md")) {
    lines.push(`${indent}${name}`);
    return;
  }

  let text;
  try {
    text = read(abs);
  } catch {
    lines.push(`${indent}${name} (unreadable)`);
    return;
  }
  lines.push(`${indent}${name}`);
  const { raw, body } = splitFrontmatter(text);
  if (raw && raw.trim().length > 0) {
    const rawLines = raw.split("\n");
    const truncated = rawLines.length > FRONTMATTER_LINE_CAP;
    const head = rawLines.slice(0, FRONTMATTER_LINE_CAP).join("\n");
    const redacted = redactLinks(head, allowlist, index);
    bumpBucket(redactions, entry.vaultRelative, redacted.redactionCount);
    lines.push(`${inner}frontmatter:`);
    lines.push(indentLines(redacted.text, inner + "  "));
    if (truncated) lines.push(`${inner}  ... (frontmatter truncated)`);
  }
  const h1 = firstH1(body);
  if (h1) {
    const redacted = redactLinks(h1, allowlist, index);
    bumpBucket(redactions, entry.vaultRelative, redacted.redactionCount);
    lines.push(`${inner}h1: ${redacted.text}`);
  }
}

export function runList(deps: ReadDeps, args: ListArgs): string {
  const allowlist = deps.allowlist();
  const index = buildAllowlistIndex(allowlist);
  const lines: string[] = [];
  const pathsReturned: string[] = [];
  const redactions: Bucket = {};

  if (args.path) {
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
    if (stats.isDirectory()) {
      lines.push(`${vaultRelativeOf(allowlist, resolved.absolutePath)}/`);
      walkAndRender(allowlist, index, resolved.entry, resolved.absolutePath, lines, pathsReturned, redactions);
    } else {
      renderFile(allowlist, index, resolved.entry, resolved.absolutePath, 0, lines, pathsReturned, redactions);
    }
  } else {
    for (const entry of allowlist.entries) {
      lines.push(`${entry.vaultRelative}`);
      walkAndRender(allowlist, index, entry, entry.absolutePath, lines, pathsReturned, redactions);
    }
  }

  deps.audit.record({
    ts: new Date().toISOString(),
    tool: "list",
    args: { path: args.path ?? null },
    paths_returned: pathsReturned,
    redactions_by_prefix: redactions,
  });

  if (lines.length === 0) {
    return "(allowlist is empty — see ./allowlist)";
  }
  return lines.join("\n");
}

export const listTool: ReadTool<ListArgs> = {
  name: "list",
  title: "List allowlisted vault notes",
  description:
    "Recursively list the vault notes the user has chosen to expose, with each note's frontmatter and first H1 inlined so you can pick candidates without fetching every file. " +
    "Scope is the brain-mcp allowlist (see ./allowlist in the vault repo) — anything outside is private and unavailable. " +
    "Use this first for any question that might be answered from the vault: meal planning / cooking ideas (Recipes/), upcoming travel, jetlag, or 'where am I' questions (Travel/), the user's side projects (Projects/), or note-template references (Templates/). " +
    "Pass an optional 'path' (vault-relative, must be inside the allowlist) to scope the listing to one folder or file. " +
    "Wikilinks and markdown links pointing outside the allowlist are replaced with [[redacted]] / [redacted].",
  inputSchema: {
    path: z
      .string()
      .optional()
      .describe(
        "Optional vault-relative path to list, e.g. 'Recipes' or 'Projects/AI.md'. Must resolve inside the allowlist.",
      ),
  },
  run: runList,
};
