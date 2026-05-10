import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { Allowlist, AllowlistEntry } from "./allowlist.js";

// Filesystem primitives shared by the read and write tools. The two scopes —
// vault-scoped writes and allowlist-scoped reads — share canonicalisation and
// containment helpers here but stay distinct entry points (see ADR-0002).

// Resolve a path under the vault root by lexical containment. Used by the
// write tools when building filenames from controlled inputs; throws if the
// joined path escapes the vault.
export function resolveUnderVault(vault: string, ...rel: string[]): string {
  const target = path.resolve(vault, ...rel);
  if (target !== vault && !target.startsWith(vault + path.sep)) {
    throw new Error("path escapes vault");
  }
  return target;
}

// Resolve a vault-relative path and verify it sits inside an allowlisted root.
// Returns the canonical absolute path and the matching entry, or null if the
// target is missing, escapes the vault, or is outside the allowlist.
export function resolveInAllowlist(
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

// Match a canonicalised absolute path against the allowlist. Used while
// walking trees, where existence is already known.
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

export type WalkItem = {
  abs: string;
  kind: "file" | "dir";
  depth: number;
};

// Canonical walk used by every read-side traversal. Skips dotfiles, sorts
// children dirs-first then alphabetical, and follows symlinks only when the
// canonical target stays inside the given allowlist entry. Direct children of
// `root` are yielded at depth 1.
export function* walk(root: string, entry: AllowlistEntry): Generator<WalkItem> {
  yield* walkAt(root, entry, 1);
}

function* walkAt(
  dir: string,
  entry: AllowlistEntry,
  depth: number,
): Generator<WalkItem> {
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  dirents.sort((a, b) => {
    const ad = a.isDirectory() ? 0 : 1;
    const bd = b.isDirectory() ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name);
  });
  for (const d of dirents) {
    if (d.name.startsWith(".")) continue;
    const abs = path.join(dir, d.name);
    let kind: "file" | "dir";
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
      let stats;
      try {
        stats = statSync(canonical);
      } catch {
        continue;
      }
      if (stats.isDirectory()) kind = "dir";
      else if (stats.isFile()) kind = "file";
      else continue;
    } else if (d.isDirectory()) {
      kind = "dir";
    } else if (d.isFile()) {
      kind = "file";
    } else {
      continue;
    }
    yield { abs, kind, depth };
    if (kind === "dir") {
      yield* walkAt(abs, entry, depth + 1);
    }
  }
}

// Thin wrapper over readFileSync. Exists so that the trust-checked path is the
// one actually read — call sites resolve via resolveInAllowlist (reads) or
// resolveUnderVault (writes) and read here.
export function read(absolutePath: string): string {
  return readFileSync(absolutePath, "utf8");
}
