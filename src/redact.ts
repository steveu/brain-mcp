import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Allowlist } from "./allowlist.js";
import { findContainingEntry, walk } from "./vault-fs.js";

// Index of basenames (without extension) that exist *within* the allowlist.
// Built once per call so wikilink lookups are O(1) and don't re-stat the FS
// for every link in a fetched note.
export type AllowlistIndex = {
  byBasename: Map<string, string[]>;
};

export function buildAllowlistIndex(allowlist: Allowlist): AllowlistIndex {
  const byBasename = new Map<string, string[]>();
  for (const entry of allowlist.entries) {
    for (const item of walk(entry.absolutePath, entry)) {
      if (item.kind !== "file") continue;
      if (!item.abs.toLowerCase().endsWith(".md")) continue;
      const base = path.basename(item.abs, path.extname(item.abs));
      const arr = byBasename.get(base) ?? [];
      arr.push(item.abs);
      byBasename.set(base, arr);
    }
  }
  return { byBasename };
}

export type RedactResult = {
  text: string;
  redactionCount: number;
};

// Redact wikilinks and relative markdown links whose target falls outside the
// allowlist. Aliases are dropped on redacted wikilinks. External URLs (with a
// scheme) and pure fragment links are left alone — they can't leak vault paths.
export function redactLinks(
  body: string,
  allowlist: Allowlist,
  index: AllowlistIndex,
): RedactResult {
  let count = 0;

  const wikilinkRe = /\[\[([^\[\]\n|#]+)(?:#[^\[\]\n|]*)?(?:\|[^\[\]\n]*)?\]\]/g;
  let out = body.replace(wikilinkRe, (full, target: string) => {
    const stripped = target.trim();
    if (resolveWikilinkInAllowlist(stripped, allowlist, index)) return full;
    count++;
    return "[[redacted]]";
  });

  // [text](link) — only redact if the link looks like a vault-internal path
  // (no URL scheme, not a fragment, not protocol-relative).
  const mdLinkRe = /\[([^\]\n]*)\]\(([^)\n]+)\)/g;
  out = out.replace(mdLinkRe, (full, _text: string, link: string) => {
    const trimmed = link.trim();
    if (!trimmed) return full;
    if (/^[a-z][a-z0-9+\-.]*:/i.test(trimmed)) return full;
    if (trimmed.startsWith("#")) return full;
    if (trimmed.startsWith("//")) return full;
    if (resolveMarkdownLinkInAllowlist(trimmed, allowlist)) return full;
    count++;
    return "[redacted]";
  });

  return { text: out, redactionCount: count };
}

function resolveWikilinkInAllowlist(
  target: string,
  allowlist: Allowlist,
  index: AllowlistIndex,
): boolean {
  if (!target) return false;

  // Path-shaped wikilinks (contain a slash) resolve relative to vault root.
  if (target.includes("/")) {
    const withExt = target.toLowerCase().endsWith(".md") ? target : `${target}.md`;
    const abs = path.resolve(allowlist.vault, withExt);
    if (!existsSync(abs)) return false;
    let canonical: string;
    try {
      canonical = realpathSync(abs);
    } catch {
      return false;
    }
    return findContainingEntry(allowlist, canonical) !== null;
  }

  // Bare names: Obsidian resolves by closest match across the whole vault.
  // We only know about files inside the allowlist; if any match exists
  // there, treat the link as in-scope. If none, redact — even if a private
  // note with the same name exists, we don't want to surface a link to it.
  return (index.byBasename.get(target) ?? []).length > 0;
}

function resolveMarkdownLinkInAllowlist(link: string, allowlist: Allowlist): boolean {
  const cleaned = link.split("#")[0]?.split("?")[0] ?? "";
  if (!cleaned) return true;
  const abs = path.resolve(allowlist.vault, cleaned);
  if (!existsSync(abs)) return false;
  let canonical: string;
  try {
    canonical = realpathSync(abs);
  } catch {
    return false;
  }
  return findContainingEntry(allowlist, canonical) !== null;
}
