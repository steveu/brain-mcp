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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AllowlistMissingError, loadAllowlist } from "../src/allowlist.js";

describe("loadAllowlist", () => {
  let vault: string;
  let canonicalVault: string;
  let allowlistPath: string;
  let outside: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vault = mkdtempSync(path.join(tmpdir(), "brain-mcp-allowlist-"));
    canonicalVault = realpathSync(vault);
    outside = mkdtempSync(path.join(tmpdir(), "brain-mcp-outside-"));
    allowlistPath = path.join(
      path.dirname(vault),
      `allowlist-${path.basename(vault)}`,
    );
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    rmSync(vault, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(allowlistPath, { force: true });
  });

  it("throws AllowlistMissingError when the file is absent", () => {
    const missing = path.join(path.dirname(vault), `missing-${path.basename(vault)}`);
    expect(() => loadAllowlist(vault, missing)).toThrowError(AllowlistMissingError);
  });

  it("round-trips a happy-path entry with vaultRelative and canonical absolutePath", () => {
    mkdirSync(path.join(vault, "Recipes"), { recursive: true });
    writeFileSync(allowlistPath, "Recipes/\n", "utf8");

    const result = loadAllowlist(vault, allowlistPath);

    expect(result.vault).toBe(canonicalVault);
    expect(result.source).toBe(allowlistPath);
    expect(result.entries).toEqual([
      {
        vaultRelative: "Recipes/",
        absolutePath: path.join(canonicalVault, "Recipes"),
      },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("skips entries containing `..`", () => {
    mkdirSync(path.join(vault, "Recipes"), { recursive: true });
    writeFileSync(allowlistPath, "../escape/\nRecipes/\n", "utf8");

    const result = loadAllowlist(vault, allowlistPath);

    expect(result.entries).toEqual([
      {
        vaultRelative: "Recipes/",
        absolutePath: path.join(canonicalVault, "Recipes"),
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("must be vault-relative"),
    );
  });

  it("skips absolute-path entries", () => {
    mkdirSync(path.join(vault, "Recipes"), { recursive: true });
    writeFileSync(allowlistPath, `${outside}/\nRecipes/\n`, "utf8");

    const result = loadAllowlist(vault, allowlistPath);

    expect(result.entries.map((e) => e.vaultRelative)).toEqual(["Recipes/"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("must be vault-relative"),
    );
  });

  it("skips entries whose target does not exist", () => {
    writeFileSync(allowlistPath, "Missing/\n", "utf8");

    const result = loadAllowlist(vault, allowlistPath);

    expect(result.entries).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("skipping nonexistent entry"),
    );
  });

  it("skips entries whose canonical target escapes the vault via a symlink", () => {
    mkdirSync(path.join(outside, "Stash"), { recursive: true });
    symlinkSync(path.join(outside, "Stash"), path.join(vault, "Stash"));
    writeFileSync(allowlistPath, "Stash/\n", "utf8");

    const result = loadAllowlist(vault, allowlistPath);

    expect(result.entries).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("escapes vault"),
    );
  });

  it("skips entries that resolve to a file rather than a directory", () => {
    writeFileSync(path.join(vault, "notes.md"), "hi\n", "utf8");
    writeFileSync(allowlistPath, "notes.md\n", "utf8");

    const result = loadAllowlist(vault, allowlistPath);

    expect(result.entries).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("non-directory entry"),
    );
  });

  it("drops duplicate entries after canonicalisation", () => {
    mkdirSync(path.join(vault, "Recipes"), { recursive: true });
    symlinkSync(path.join(vault, "Recipes"), path.join(vault, "RecipesLink"));
    writeFileSync(allowlistPath, "Recipes/\nRecipesLink/\nRecipes/\n", "utf8");

    const result = loadAllowlist(vault, allowlistPath);

    expect(result.entries).toEqual([
      {
        vaultRelative: "Recipes/",
        absolutePath: path.join(canonicalVault, "Recipes"),
      },
    ]);
  });
});
