import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  type Allowlist,
  type AllowlistEntry,
  findContainingEntry,
  resolveScopedPath,
  vaultRelativeOf,
} from "./allowlist.js";
import { appendAudit } from "./audit.js";
import { buildAllowlistIndex, redactLinks } from "./redact.js";

const FRONTMATTER_LINE_CAP = 12;
const GREP_MAX_MATCHES = 200;
const GREP_LINE_CAP = 240;

export type ToolDeps = {
  allowlist: Allowlist;
  auditLogPath: string;
};

export type ListArgs = {
  path?: string;
};

export type FetchArgs = {
  path: string;
};

export type GrepArgs = {
  query: string;
  path?: string;
};

type Bucket = Record<string, number>;

function bumpBucket(b: Bucket, prefix: string, by: number): void {
  if (by <= 0) return;
  b[prefix] = (b[prefix] ?? 0) + by;
}

function ts(): string {
  return new Date().toISOString();
}

function readMd(absolutePath: string): string {
  return readFileSync(absolutePath, "utf8");
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

// ----- list ---------------------------------------------------------------

export function runList(deps: ToolDeps, args: ListArgs): string {
  const { allowlist } = deps;
  const index = buildAllowlistIndex(allowlist);
  const lines: string[] = [];
  const pathsReturned: string[] = [];
  const redactions: Bucket = {};

  if (args.path) {
    const resolved = resolveScopedPath(allowlist, args.path);
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
      walkAndRender(allowlist, index, resolved.entry, resolved.absolutePath, 1, lines, pathsReturned, redactions);
    } else {
      renderFile(allowlist, index, resolved.entry, resolved.absolutePath, 0, lines, pathsReturned, redactions);
    }
  } else {
    for (const entry of allowlist.entries) {
      lines.push(`${entry.vaultRelative}`);
      walkAndRender(allowlist, index, entry, entry.absolutePath, 1, lines, pathsReturned, redactions);
    }
  }

  appendAudit(deps.auditLogPath, {
    ts: ts(),
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

function walkAndRender(
  allowlist: Allowlist,
  index: ReturnType<typeof buildAllowlistIndex>,
  entry: AllowlistEntry,
  dir: string,
  depth: number,
  lines: string[],
  pathsReturned: string[],
  redactions: Bucket,
): void {
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // Sort: directories first, then files, both alphabetical.
  dirents.sort((a, b) => {
    const ad = a.isDirectory() ? 0 : 1;
    const bd = b.isDirectory() ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name);
  });
  const indent = "  ".repeat(depth);
  for (const d of dirents) {
    if (d.name.startsWith(".")) continue;
    const abs = path.join(dir, d.name);
    if (d.isSymbolicLink()) {
      // Resolve, only follow if still inside the same allowlisted entry.
      let canonical: string;
      try {
        canonical = realpathSync(abs);
      } catch {
        continue;
      }
      if (
        canonical !== entry.absolutePath &&
        !canonical.startsWith(entry.absolutePath + path.sep)
      ) {
        continue;
      }
    }
    if (d.isDirectory()) {
      lines.push(`${indent}${d.name}/`);
      walkAndRender(allowlist, index, entry, abs, depth + 1, lines, pathsReturned, redactions);
    } else if (d.isFile()) {
      renderFile(allowlist, index, entry, abs, depth, lines, pathsReturned, redactions);
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
    text = readMd(abs);
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

// ----- fetch --------------------------------------------------------------

export function runFetch(deps: ToolDeps, args: FetchArgs): string {
  const { allowlist } = deps;
  const resolved = resolveScopedPath(allowlist, args.path);
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
  const text = readFileSync(resolved.absolutePath, "utf8");
  const index = buildAllowlistIndex(allowlist);
  const redacted = redactLinks(text, allowlist, index);

  appendAudit(deps.auditLogPath, {
    ts: ts(),
    tool: "fetch",
    args: { path: args.path },
    paths_returned: [vaultRelativeOf(allowlist, resolved.absolutePath)],
    redactions_by_prefix: redacted.redactionCount > 0
      ? { [resolved.entry.vaultRelative]: redacted.redactionCount }
      : {},
  });

  return redacted.text;
}

// ----- grep ---------------------------------------------------------------

export function runGrep(deps: ToolDeps, args: GrepArgs): string {
  const { allowlist } = deps;
  const query = args.query;
  if (!query) throw new Error("query is required");

  const index = buildAllowlistIndex(allowlist);
  const needle = query.toLowerCase();
  const lines: string[] = [];
  const pathsReturned: string[] = [];
  const redactions: Bucket = {};
  let matchCount = 0;

  const roots: AllowlistEntry[] = (() => {
    if (!args.path) return allowlist.entries;
    const resolved = resolveScopedPath(allowlist, args.path);
    if (!resolved) throw new Error(`path not in allowlist: ${args.path}`);
    return [resolved.entry];
  })();

  outer: for (const entry of roots) {
    const start = args.path
      ? resolveScopedPath(allowlist, args.path)?.absolutePath ?? entry.absolutePath
      : entry.absolutePath;
    const files: string[] = [];
    collectMd(start, entry, files);
    files.sort();

    for (const file of files) {
      let text;
      try {
        text = readFileSync(file, "utf8");
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

  appendAudit(deps.auditLogPath, {
    ts: ts(),
    tool: "grep",
    args: { query, path: args.path ?? null },
    paths_returned: pathsReturned,
    redactions_by_prefix: redactions,
  });

  if (lines.length === 0) return `no matches for ${JSON.stringify(query)}`;
  return lines.join("\n");
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
  let dirents;
  try {
    dirents = readdirSync(start, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of dirents) {
    if (d.name.startsWith(".")) continue;
    const abs = path.join(start, d.name);
    if (d.isSymbolicLink()) {
      let canonical: string;
      try {
        canonical = realpathSync(abs);
      } catch {
        continue;
      }
      if (
        canonical !== entry.absolutePath &&
        !canonical.startsWith(entry.absolutePath + path.sep)
      ) {
        continue;
      }
    }
    if (d.isDirectory()) collectMd(abs, entry, out);
    else if (d.isFile() && abs.toLowerCase().endsWith(".md")) out.push(abs);
  }
}

// Re-export for the server file.
export { findContainingEntry };
