import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Allowlist, AllowlistEntry } from "../src/allowlist.js";
import {
  resolveInAllowlist,
  resolveUnderVault,
  walk,
} from "../src/vault-fs.js";

// vault-fs is the trust boundary for path containment. The tests below build
// real temp vaults, real symlinks and real dotfiles, then assert each helper's
// containment guarantees directly — no fs mocking, no allowlist file parsing.

describe("resolveUnderVault", () => {
  let vault: string;

  beforeEach(() => {
    // macOS tmpdir is itself a symlink (/var -> /private/var); canonicalise so
    // the lexical containment check in resolveUnderVault sees a stable prefix.
    vault = realpathSync(mkdtempSync(path.join(tmpdir(), "brain-mcp-vfs-vault-")));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("resolves a simple relative path under the vault", () => {
    const resolved = resolveUnderVault(vault, "Daily", "2026-05-13.md");
    expect(resolved).toBe(path.join(vault, "Daily", "2026-05-13.md"));
  });

  it("returns the vault itself when no segments are given", () => {
    expect(resolveUnderVault(vault)).toBe(vault);
  });

  it("rejects a single .. that climbs above the vault", () => {
    expect(() => resolveUnderVault(vault, "..")).toThrow(/escapes vault/);
  });

  it("rejects nested .. traversal even when later segments look in-scope", () => {
    expect(() =>
      resolveUnderVault(vault, "Notes", "..", "..", "evil.md"),
    ).toThrow(/escapes vault/);
  });

  it("rejects an absolute path that re-anchors via path.resolve", () => {
    // path.resolve discards earlier args when a later arg is absolute, so the
    // helper must catch the re-anchored target rather than trust the join.
    expect(() => resolveUnderVault(vault, "/etc/passwd")).toThrow(/escapes vault/);
  });

  it("rejects an absolute later segment that escapes via re-anchoring", () => {
    expect(() =>
      resolveUnderVault(vault, "Notes", "/tmp/elsewhere"),
    ).toThrow(/escapes vault/);
  });

  it("rejects a sibling path that shares the vault's prefix string", () => {
    // Lexical containment must use the separator boundary — `${vault}-evil`
    // starts with `vault` as a substring but is not inside it.
    expect(() => resolveUnderVault(vault, "..", `${path.basename(vault)}-evil`)).toThrow(
      /escapes vault/,
    );
  });
});

// Helper for building an Allowlist value without going through the file
// loader; the loader has its own tests and we want this suite to exercise
// resolveInAllowlist / walk directly.
function buildAllowlist(vault: string, relativeDirs: string[]): Allowlist {
  const entries: AllowlistEntry[] = relativeDirs.map((rel) => ({
    vaultRelative: rel.replace(/\/+$/, "") + "/",
    absolutePath: realpathSync(path.resolve(vault, rel)),
  }));
  return { entries, vault, source: "<test>" };
}

describe("resolveInAllowlist", () => {
  let vault: string;
  let outside: string;

  beforeEach(() => {
    vault = realpathSync(mkdtempSync(path.join(tmpdir(), "brain-mcp-vfs-ral-")));
    outside = realpathSync(mkdtempSync(path.join(tmpdir(), "brain-mcp-vfs-out-")));
    mkdirSync(path.join(vault, "Notes"), { recursive: true });
    mkdirSync(path.join(vault, "Private"), { recursive: true });
    writeFileSync(path.join(vault, "Notes", "one.md"), "one\n", "utf8");
    writeFileSync(path.join(vault, "Private", "secret.md"), "secret\n", "utf8");
    writeFileSync(path.join(outside, "leak.md"), "leak\n", "utf8");
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("returns the matching entry for an in-scope relative path", () => {
    const allowlist = buildAllowlist(vault, ["Notes"]);
    const result = resolveInAllowlist(allowlist, "Notes/one.md");
    expect(result).not.toBeNull();
    expect(result?.absolutePath).toBe(path.join(vault, "Notes", "one.md"));
    expect(result?.entry.vaultRelative).toBe("Notes/");
  });

  it("returns null for an absolute input even if it points inside the vault", () => {
    const allowlist = buildAllowlist(vault, ["Notes"]);
    const absolute = path.join(vault, "Notes", "one.md");
    expect(resolveInAllowlist(allowlist, absolute)).toBeNull();
  });

  it("returns null for the empty string", () => {
    const allowlist = buildAllowlist(vault, ["Notes"]);
    expect(resolveInAllowlist(allowlist, "")).toBeNull();
  });

  it("returns null when the target does not exist", () => {
    const allowlist = buildAllowlist(vault, ["Notes"]);
    expect(resolveInAllowlist(allowlist, "Notes/missing.md")).toBeNull();
  });

  it("returns null for a symlink whose realpath escapes the vault entirely", () => {
    const allowlist = buildAllowlist(vault, ["Notes"]);
    const link = path.join(vault, "Notes", "escape.md");
    symlinkSync(path.join(outside, "leak.md"), link);
    expect(resolveInAllowlist(allowlist, "Notes/escape.md")).toBeNull();
  });

  it("returns null for a symlink inside the vault whose realpath sits outside any allowlist entry", () => {
    // The symlink lives in an allowlisted dir, but its target is in a
    // non-allowlisted vault dir — realpath stays inside the vault but escapes
    // the entry, so the result must still be null.
    const allowlist = buildAllowlist(vault, ["Notes"]);
    const link = path.join(vault, "Notes", "into-private.md");
    symlinkSync(path.join(vault, "Private", "secret.md"), link);
    expect(resolveInAllowlist(allowlist, "Notes/into-private.md")).toBeNull();
  });

  it("returns null for a real file inside the vault but outside any allowlist entry", () => {
    const allowlist = buildAllowlist(vault, ["Notes"]);
    expect(resolveInAllowlist(allowlist, "Private/secret.md")).toBeNull();
  });
});

describe("walk", () => {
  let vault: string;
  let outside: string;

  beforeEach(() => {
    vault = realpathSync(mkdtempSync(path.join(tmpdir(), "brain-mcp-vfs-walk-")));
    outside = realpathSync(mkdtempSync(path.join(tmpdir(), "brain-mcp-vfs-walkout-")));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("yields entries in dirs-first then alphabetical order, with depth", () => {
    // Layout — names chosen so alphabetical and dirs-first interact:
    //   Notes/
    //     a-file.md
    //     b-dir/
    //       inner.md
    //     m-dir/
    //     z-file.md
    const root = path.join(vault, "Notes");
    mkdirSync(path.join(root, "b-dir"), { recursive: true });
    mkdirSync(path.join(root, "m-dir"), { recursive: true });
    writeFileSync(path.join(root, "a-file.md"), "a\n", "utf8");
    writeFileSync(path.join(root, "z-file.md"), "z\n", "utf8");
    writeFileSync(path.join(root, "b-dir", "inner.md"), "inner\n", "utf8");

    const allowlist = buildAllowlist(vault, ["Notes"]);
    const entry = allowlist.entries[0];
    expect(entry).toBeDefined();
    const items = [...walk(root, entry!)].map((i) => ({
      rel: path.relative(root, i.abs),
      kind: i.kind,
      depth: i.depth,
    }));

    expect(items).toEqual([
      { rel: "b-dir", kind: "dir", depth: 1 },
      { rel: path.join("b-dir", "inner.md"), kind: "file", depth: 2 },
      { rel: "m-dir", kind: "dir", depth: 1 },
      { rel: "a-file.md", kind: "file", depth: 1 },
      { rel: "z-file.md", kind: "file", depth: 1 },
    ]);
  });

  it("skips dotfiles and dotdirs at every depth", () => {
    const root = path.join(vault, "Notes");
    mkdirSync(path.join(root, ".hidden-dir"), { recursive: true });
    mkdirSync(path.join(root, "visible"), { recursive: true });
    writeFileSync(path.join(root, ".dotfile"), "dot\n", "utf8");
    writeFileSync(path.join(root, ".hidden-dir", "buried.md"), "buried\n", "utf8");
    writeFileSync(path.join(root, "visible", ".nested-dot"), "nested\n", "utf8");
    writeFileSync(path.join(root, "visible", "shown.md"), "shown\n", "utf8");

    const allowlist = buildAllowlist(vault, ["Notes"]);
    const entry = allowlist.entries[0];
    expect(entry).toBeDefined();
    const rels = [...walk(root, entry!)].map((i) => path.relative(root, i.abs));

    expect(rels).toEqual([
      "visible",
      path.join("visible", "shown.md"),
    ]);
  });

  it("follows a symlink whose canonical target stays inside the allowlist entry", () => {
    const root = path.join(vault, "Notes");
    mkdirSync(path.join(root, "real-dir"), { recursive: true });
    writeFileSync(path.join(root, "real-dir", "inside.md"), "inside\n", "utf8");
    writeFileSync(path.join(root, "target.md"), "target\n", "utf8");
    symlinkSync(path.join(root, "target.md"), path.join(root, "linked-file.md"));
    symlinkSync(path.join(root, "real-dir"), path.join(root, "linked-dir"));

    const allowlist = buildAllowlist(vault, ["Notes"]);
    const entry = allowlist.entries[0];
    expect(entry).toBeDefined();
    const items = [...walk(root, entry!)].map((i) => ({
      rel: path.relative(root, i.abs),
      kind: i.kind,
    }));

    // The dirs-first sort uses Dirent.isDirectory(), which is false for a
    // symlink even when it points at a directory — so real dirs come first
    // alphabetically, then the symlink-and-file group alphabetically. The
    // linked-dir symlink is still followed (its child appears) and the
    // linked-file symlink is yielded as a file.
    expect(items).toEqual([
      { rel: "real-dir", kind: "dir" },
      { rel: path.join("real-dir", "inside.md"), kind: "file" },
      { rel: "linked-dir", kind: "dir" },
      { rel: path.join("linked-dir", "inside.md"), kind: "file" },
      { rel: "linked-file.md", kind: "file" },
      { rel: "target.md", kind: "file" },
    ]);
  });

  it("skips symlinks whose canonical target escapes the allowlist entry", () => {
    const root = path.join(vault, "Notes");
    mkdirSync(root, { recursive: true });
    mkdirSync(path.join(vault, "Private"), { recursive: true });
    writeFileSync(path.join(root, "real.md"), "real\n", "utf8");
    writeFileSync(path.join(vault, "Private", "secret.md"), "secret\n", "utf8");
    writeFileSync(path.join(outside, "leak.md"), "leak\n", "utf8");

    // Symlink to a target outside the vault entirely.
    symlinkSync(path.join(outside, "leak.md"), path.join(root, "out-of-vault.md"));
    // Symlink to a target inside the vault but outside the Notes entry.
    symlinkSync(
      path.join(vault, "Private", "secret.md"),
      path.join(root, "into-private.md"),
    );
    // Symlink whose target doesn't exist — realpath fails, must be skipped.
    symlinkSync(path.join(root, "no-such-file.md"), path.join(root, "dangling.md"));

    const allowlist = buildAllowlist(vault, ["Notes"]);
    const entry = allowlist.entries[0];
    expect(entry).toBeDefined();
    const rels = [...walk(root, entry!)].map((i) => path.relative(root, i.abs));

    expect(rels).toEqual(["real.md"]);
  });
});
