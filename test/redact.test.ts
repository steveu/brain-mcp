import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAllowlist } from "../src/allowlist.js";
import { buildAllowlistIndex, redactLinks } from "../src/redact.js";

describe("redactLinks", () => {
  let vault: string;
  let allowlistPath: string;

  beforeEach(() => {
    vault = mkdtempSync(path.join(tmpdir(), "brain-mcp-redact-"));
    // Allowlisted folder with two notes and a non-markdown asset.
    mkdirSync(path.join(vault, "Notes"), { recursive: true });
    writeFileSync(path.join(vault, "Notes", "Public.md"), "# Public\n", "utf8");
    writeFileSync(path.join(vault, "Notes", "Shared.md"), "# Shared\n", "utf8");
    writeFileSync(path.join(vault, "Notes", "image.png"), "binary", "utf8");
    // A nested allowlisted folder, to exercise recursive walks for the index.
    mkdirSync(path.join(vault, "Notes", "Sub"), { recursive: true });
    writeFileSync(path.join(vault, "Notes", "Sub", "Nested.md"), "# Nested\n", "utf8");
    // Folder *outside* the allowlist — basename collides with allowlisted note.
    mkdirSync(path.join(vault, "Private"), { recursive: true });
    writeFileSync(path.join(vault, "Private", "Secret.md"), "# Secret\n", "utf8");
    writeFileSync(path.join(vault, "Private", "Shared.md"), "# Private dupe\n", "utf8");

    allowlistPath = path.join(path.dirname(vault), `allowlist-${path.basename(vault)}`);
    writeFileSync(allowlistPath, "Notes/\n", "utf8");
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(allowlistPath, { force: true });
  });

  describe("buildAllowlistIndex", () => {
    it("indexes only .md files inside allowlisted entries by basename (no extension)", () => {
      const allowlist = loadAllowlist(vault, allowlistPath);
      const index = buildAllowlistIndex(allowlist);

      const keys = [...index.byBasename.keys()].sort();
      expect(keys).toEqual(["Nested", "Public", "Shared"]);

      // PNG asset must not be indexed.
      expect(index.byBasename.has("image")).toBe(false);
      // Note outside the allowlist must not be indexed.
      expect(index.byBasename.has("Secret")).toBe(false);

      // "Shared.md" exists in both Notes/ (allowlisted) and Private/ (not):
      // only the allowlisted path should appear in the index. The path
      // recorded by the index is canonicalised (symlinks resolved), so we
      // compare against the canonical vault path the allowlist stored.
      const shared = index.byBasename.get("Shared") ?? [];
      expect(shared).toHaveLength(1);
      expect(shared[0]).toBe(path.join(allowlist.vault, "Notes", "Shared.md"));
    });
  });

  describe("wikilinks", () => {
    it("keeps path-shaped targets that resolve into the allowlist", () => {
      const allowlist = loadAllowlist(vault, allowlistPath);
      const index = buildAllowlistIndex(allowlist);

      const result = redactLinks("see [[Notes/Public]]", allowlist, index);
      expect(result.text).toBe("see [[Notes/Public]]");
      expect(result.redactionCount).toBe(0);
    });

    it("redacts path-shaped targets that resolve outside the allowlist", () => {
      const allowlist = loadAllowlist(vault, allowlistPath);
      const index = buildAllowlistIndex(allowlist);

      const result = redactLinks("see [[Private/Secret]]", allowlist, index);
      expect(result.text).toBe("see [[redacted]]");
      expect(result.redactionCount).toBe(1);
    });

    it("redacts path-shaped targets that don't exist on disk", () => {
      const allowlist = loadAllowlist(vault, allowlistPath);
      const index = buildAllowlistIndex(allowlist);

      const result = redactLinks("see [[Notes/Missing]]", allowlist, index);
      expect(result.text).toBe("see [[redacted]]");
      expect(result.redactionCount).toBe(1);
    });

    it("keeps bare-name targets resolved via the byBasename index", () => {
      const allowlist = loadAllowlist(vault, allowlistPath);
      const index = buildAllowlistIndex(allowlist);

      const result = redactLinks("see [[Public]] and [[Nested]]", allowlist, index);
      expect(result.text).toBe("see [[Public]] and [[Nested]]");
      expect(result.redactionCount).toBe(0);
    });

    it("redacts bare-name targets with no entry in the index", () => {
      const allowlist = loadAllowlist(vault, allowlistPath);
      const index = buildAllowlistIndex(allowlist);

      const result = redactLinks("see [[Secret]]", allowlist, index);
      expect(result.text).toBe("see [[redacted]]");
      expect(result.redactionCount).toBe(1);
    });

    it("drops aliases on redacted wikilinks", () => {
      const allowlist = loadAllowlist(vault, allowlistPath);
      const index = buildAllowlistIndex(allowlist);

      const result = redactLinks("see [[Foo|bar]]", allowlist, index);
      expect(result.text).toBe("see [[redacted]]");
      expect(result.redactionCount).toBe(1);
    });

    it("preserves aliases on wikilinks that are kept", () => {
      const allowlist = loadAllowlist(vault, allowlistPath);
      const index = buildAllowlistIndex(allowlist);

      const result = redactLinks("see [[Public|the public one]]", allowlist, index);
      expect(result.text).toBe("see [[Public|the public one]]");
      expect(result.redactionCount).toBe(0);
    });
  });

  describe("markdown links", () => {
    it("leaves external URLs with a scheme alone", () => {
      const allowlist = loadAllowlist(vault, allowlistPath);
      const index = buildAllowlistIndex(allowlist);

      const input =
        "see [docs](https://example.com/x) and [mail](mailto:a@b.co) and [ftp](ftp://h/p)";
      const result = redactLinks(input, allowlist, index);
      expect(result.text).toBe(input);
      expect(result.redactionCount).toBe(0);
    });

    it("leaves fragment-only links alone", () => {
      const allowlist = loadAllowlist(vault, allowlistPath);
      const index = buildAllowlistIndex(allowlist);

      const input = "see [top](#heading)";
      const result = redactLinks(input, allowlist, index);
      expect(result.text).toBe(input);
      expect(result.redactionCount).toBe(0);
    });

    it("leaves protocol-relative links alone", () => {
      const allowlist = loadAllowlist(vault, allowlistPath);
      const index = buildAllowlistIndex(allowlist);

      const input = "see [cdn](//cdn.example.com/asset.js)";
      const result = redactLinks(input, allowlist, index);
      expect(result.text).toBe(input);
      expect(result.redactionCount).toBe(0);
    });

    it("redacts vault-internal paths that fall outside the allowlist", () => {
      const allowlist = loadAllowlist(vault, allowlistPath);
      const index = buildAllowlistIndex(allowlist);

      const result = redactLinks("see [s](Private/Secret.md)", allowlist, index);
      // The redaction collapses the whole [text](link) construct to "[redacted]".
      expect(result.text).toBe("see [redacted]");
      expect(result.redactionCount).toBe(1);
    });

    it("keeps vault-internal paths that resolve inside the allowlist", () => {
      const allowlist = loadAllowlist(vault, allowlistPath);
      const index = buildAllowlistIndex(allowlist);

      const input = "see [p](Notes/Public.md)";
      const result = redactLinks(input, allowlist, index);
      expect(result.text).toBe(input);
      expect(result.redactionCount).toBe(0);
    });
  });
});
