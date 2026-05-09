import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export type AllowlistEntry = {
  // Vault-relative path with trailing slash, e.g. "Recipes/".
  vaultRelative: string;
  // Canonicalised absolute path (symlinks resolved).
  absolutePath: string;
};

export type Allowlist = {
  entries: AllowlistEntry[];
  // Canonicalised absolute path of the vault.
  vault: string;
  // Where the allowlist was read from, for error messages and audit.
  source: string;
};

export class AllowlistMissingError extends Error {}

// Read and validate the allowlist file. Bad entries are logged and skipped;
// a missing file throws AllowlistMissingError so callers can fail closed at
// startup, and tools can surface "no allowlist" rather than silently widening.
export function loadAllowlist(vault: string, allowlistPath: string): Allowlist {
  if (!existsSync(allowlistPath)) {
    throw new AllowlistMissingError(`allowlist file not found at ${allowlistPath}`);
  }
  const canonicalVault = realpathSync(vault);
  const raw = readFileSync(allowlistPath, "utf8");
  const seen = new Set<string>();
  const entries: AllowlistEntry[] = [];

  for (const rawLine of raw.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const vaultRel = trimmed.replace(/\/+$/, "");
    if (!vaultRel || vaultRel.includes("..") || path.isAbsolute(vaultRel)) {
      console.warn(`[allowlist] skipping bad entry (must be vault-relative): ${trimmed}`);
      continue;
    }

    const target = path.resolve(canonicalVault, vaultRel);
    if (!existsSync(target)) {
      console.warn(`[allowlist] skipping nonexistent entry: ${trimmed}`);
      continue;
    }

    let canonical: string;
    try {
      canonical = realpathSync(target);
    } catch (err) {
      console.warn(
        `[allowlist] skipping unresolvable entry: ${trimmed} (${(err as Error).message})`,
      );
      continue;
    }

    if (canonical !== canonicalVault && !canonical.startsWith(canonicalVault + path.sep)) {
      console.warn(`[allowlist] skipping entry that escapes vault: ${trimmed}`);
      continue;
    }

    let stats;
    try {
      stats = statSync(canonical);
    } catch {
      console.warn(`[allowlist] skipping unstattable entry: ${trimmed}`);
      continue;
    }
    if (!stats.isDirectory()) {
      console.warn(`[allowlist] skipping non-directory entry: ${trimmed}`);
      continue;
    }

    if (seen.has(canonical)) continue;
    seen.add(canonical);
    entries.push({
      vaultRelative: vaultRel + "/",
      absolutePath: canonical,
    });
  }

  return { entries, vault: canonicalVault, source: allowlistPath };
}

// Resolve a vault-relative path and verify it sits inside an allowlisted root.
// Returns the canonical absolute path and the matching entry, or null if the
// target is missing, escapes the vault, or is outside the allowlist.
export function resolveScopedPath(
  allowlist: Allowlist,
  vaultRelative: string,
): { absolutePath: string; entry: AllowlistEntry } | null {
  if (!vaultRelative || path.isAbsolute(vaultRelative)) return null;
  const target = path.resolve(allowlist.vault, vaultRelative);
  if (!existsSync(target)) return null;

  let canonical: string;
  try {
    canonical = realpathSync(target);
  } catch {
    return null;
  }
  if (
    canonical !== allowlist.vault &&
    !canonical.startsWith(allowlist.vault + path.sep)
  ) {
    return null;
  }
  return findContainingEntry(allowlist, canonical);
}

// Match a canonicalised absolute path against the allowlist. Used when walking
// trees and checking each found path, where existence is already known.
export function findContainingEntry(
  allowlist: Allowlist,
  canonicalAbs: string,
): { absolutePath: string; entry: AllowlistEntry } | null {
  for (const entry of allowlist.entries) {
    if (
      canonicalAbs === entry.absolutePath ||
      canonicalAbs.startsWith(entry.absolutePath + path.sep)
    ) {
      return { absolutePath: canonicalAbs, entry };
    }
  }
  return null;
}

// Vault-relative form of an absolute path, e.g. "Recipes/Foo.md".
export function vaultRelativeOf(allowlist: Allowlist, absolutePath: string): string {
  const rel = path.relative(allowlist.vault, absolutePath);
  return rel.split(path.sep).join("/");
}
