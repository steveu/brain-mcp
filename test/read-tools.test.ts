import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAllowlist } from "../src/allowlist.js";
import { memoryAuditSink } from "../src/audit.js";
import { runFetch } from "../src/tools/fetch.js";
import { runGrep } from "../src/tools/grep.js";
import { runList } from "../src/tools/list.js";

// Observable caps in src/tools/grep.ts — kept private there; tests assert behaviour.
const GREP_LINE_CAP = 240;
const GREP_MAX_MATCHES = 200;

function buildDeps(vault: string, allowlistPath: string) {
  const allowlist = loadAllowlist(vault, allowlistPath);
  const audit = memoryAuditSink();
  return { deps: { allowlist: () => allowlist, audit }, audit };
}

describe("runFetch error paths", () => {
  let vault: string;
  let allowlistPath: string;
  let unreadablePath: string | null = null;

  beforeEach(() => {
    vault = mkdtempSync(path.join(tmpdir(), "brain-mcp-fetch-"));
    mkdirSync(path.join(vault, "Notes"), { recursive: true });
    mkdirSync(path.join(vault, "Notes", "SubDir"), { recursive: true });
    mkdirSync(path.join(vault, "Secret"), { recursive: true });
    writeFileSync(
      path.join(vault, "Notes", "one.md"),
      "# One\n\nhello\n",
      "utf8",
    );
    writeFileSync(
      path.join(vault, "Secret", "private.md"),
      "# Private\n\ntop secret\n",
      "utf8",
    );
    allowlistPath = path.join(path.dirname(vault), `allowlist-${path.basename(vault)}`);
    writeFileSync(allowlistPath, "Notes/\n", "utf8");
  });

  afterEach(() => {
    if (unreadablePath) {
      try {
        chmodSync(unreadablePath, 0o644);
      } catch {
        // Best effort; cleanup proceeds either way.
      }
      unreadablePath = null;
    }
    rmSync(vault, { recursive: true, force: true });
    rmSync(allowlistPath, { force: true });
  });

  it("throws when the path is outside the allowlist", () => {
    const { deps, audit } = buildDeps(vault, allowlistPath);
    expect(() => runFetch(deps, { path: "Secret/private.md" })).toThrow(
      /not in allowlist/,
    );
    // Failed calls must not record an audit entry.
    expect(audit.entries).toEqual([]);
  });

  it("throws when the path resolves to a directory", () => {
    const { deps, audit } = buildDeps(vault, allowlistPath);
    expect(() => runFetch(deps, { path: "Notes/SubDir" })).toThrow(
      /not a file/,
    );
    expect(audit.entries).toEqual([]);
  });

  it("throws when the file does not exist", () => {
    const { deps, audit } = buildDeps(vault, allowlistPath);
    expect(() => runFetch(deps, { path: "Notes/nope.md" })).toThrow(
      /not in allowlist/,
    );
    expect(audit.entries).toEqual([]);
  });

  // chmod 000 only blocks reads for non-root users on POSIX. Skip on Windows
  // (no POSIX perms) and when running as root (perms ignored).
  const canTestUnreadable =
    process.platform !== "win32" &&
    typeof process.getuid === "function" &&
    process.getuid() !== 0;

  it.skipIf(!canTestUnreadable)(
    "throws when the file exists but is unreadable",
    () => {
      // resolveInAllowlist + statSync both succeed (no read needed), so the
      // failure surfaces from the read() inside runFetch.
      const target = path.join(vault, "Notes", "locked.md");
      writeFileSync(target, "# Locked\n", "utf8");
      chmodSync(target, 0o000);
      unreadablePath = target;

      const { deps } = buildDeps(vault, allowlistPath);
      // EACCES message is implementation-defined; just assert *some* error.
      expect(() => runFetch(deps, { path: "Notes/locked.md" })).toThrow();
    },
  );
});

describe("runGrep output caps and path scoping", () => {
  let vault: string;
  let allowlistPath: string;

  beforeEach(() => {
    vault = mkdtempSync(path.join(tmpdir(), "brain-mcp-grep-"));
    mkdirSync(path.join(vault, "Notes"), { recursive: true });
    mkdirSync(path.join(vault, "Other"), { recursive: true });
    allowlistPath = path.join(path.dirname(vault), `allowlist-${path.basename(vault)}`);
    writeFileSync(allowlistPath, "Notes/\nOther/\n", "utf8");
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(allowlistPath, { force: true });
  });

  it("truncates a line longer than GREP_LINE_CAP characters", () => {
    // Single long line that contains the needle inside the kept prefix.
    const longLine = "needle " + "x".repeat(400);
    expect(longLine.length).toBeGreaterThan(GREP_LINE_CAP);
    writeFileSync(path.join(vault, "Notes", "long.md"), longLine + "\n", "utf8");

    const { deps } = buildDeps(vault, allowlistPath);
    const out = runGrep(deps, { query: "needle" });

    const snippetLine = out
      .split("\n")
      .find((l) => l.startsWith("  1: "));
    expect(snippetLine).toBeDefined();
    const snippet = snippetLine!.slice("  1: ".length);
    // The cap is on the line text; the truncation marker is a single ellipsis
    // appended after the slice — so total length is cap + 1 codepoint.
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.slice(0, -1).length).toBe(GREP_LINE_CAP);
  });

  it("caps matches at GREP_MAX_MATCHES and emits a truncation notice", () => {
    // 250 lines, each contains the needle — exceeds the 200 cap.
    const total = 250;
    const body = Array.from({ length: total }, (_, i) => `line ${i} needle here`).join(
      "\n",
    );
    writeFileSync(path.join(vault, "Notes", "many.md"), body + "\n", "utf8");

    const { deps } = buildDeps(vault, allowlistPath);
    const out = runGrep(deps, { query: "needle" });

    // Match lines are the indented "  <n>: ..." lines. Header + truncation
    // notice are not indented with "  N:".
    const matchLines = out.split("\n").filter((l) => /^ {2}\d+: /.test(l));
    expect(matchLines).toHaveLength(GREP_MAX_MATCHES);
    expect(out).toMatch(
      new RegExp(`truncated at ${GREP_MAX_MATCHES} matches`),
    );
  });

  it("narrows the search when 'path' points at a single folder", () => {
    writeFileSync(path.join(vault, "Notes", "a.md"), "needle here\n", "utf8");
    writeFileSync(path.join(vault, "Other", "b.md"), "needle here\n", "utf8");

    const { deps, audit } = buildDeps(vault, allowlistPath);
    const out = runGrep(deps, { query: "needle", path: "Notes" });

    expect(out).toContain("Notes/a.md");
    expect(out).not.toContain("Other/b.md");

    const entry = audit.entries[0];
    expect(entry?.paths_returned).toEqual(["Notes/a.md"]);
    expect(entry?.args).toEqual({ query: "needle", path: "Notes" });
  });

  it("throws when 'path' is outside the allowlist", () => {
    mkdirSync(path.join(vault, "Hidden"), { recursive: true });
    writeFileSync(path.join(vault, "Hidden", "x.md"), "needle\n", "utf8");

    const { deps } = buildDeps(vault, allowlistPath);
    expect(() => runGrep(deps, { query: "needle", path: "Hidden" })).toThrow(
      /not in allowlist/,
    );
  });

  it("skips non-.md files even when they contain the query", () => {
    writeFileSync(path.join(vault, "Notes", "a.md"), "needle in markdown\n", "utf8");
    writeFileSync(path.join(vault, "Notes", "b.txt"), "needle in text\n", "utf8");
    writeFileSync(path.join(vault, "Notes", "c.json"), '{"q":"needle"}\n', "utf8");

    const { deps, audit } = buildDeps(vault, allowlistPath);
    const out = runGrep(deps, { query: "needle" });

    expect(out).toContain("Notes/a.md");
    expect(out).not.toContain("Notes/b.txt");
    expect(out).not.toContain("Notes/c.json");

    const entry = audit.entries[0];
    expect(entry?.paths_returned).toEqual(["Notes/a.md"]);
  });
});

describe("runList frontmatter and H1 handling", () => {
  let vault: string;
  let allowlistPath: string;

  beforeEach(() => {
    vault = mkdtempSync(path.join(tmpdir(), "brain-mcp-list-"));
    mkdirSync(path.join(vault, "Notes"), { recursive: true });
    allowlistPath = path.join(path.dirname(vault), `allowlist-${path.basename(vault)}`);
    writeFileSync(allowlistPath, "Notes/\n", "utf8");
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(allowlistPath, { force: true });
  });

  it("treats a note with no frontmatter as body-only and renders any H1", () => {
    writeFileSync(
      path.join(vault, "Notes", "plain.md"),
      "# Plain Title\n\nsome body\n",
      "utf8",
    );

    const { deps } = buildDeps(vault, allowlistPath);
    const out = runList(deps, { path: "Notes/plain.md" });

    expect(out).toContain("plain.md");
    expect(out).not.toContain("frontmatter:");
    expect(out).toContain("h1: Plain Title");
  });

  it("splits CRLF-terminated frontmatter and still reads the body H1", () => {
    // \r\n line endings end-to-end. The splitter must tolerate them.
    const text =
      "---\r\ntitle: CRLF Note\r\ntag: one\r\n---\r\n# CRLF Heading\r\n\r\nbody\r\n";
    writeFileSync(path.join(vault, "Notes", "crlf.md"), text, "utf8");

    const { deps } = buildDeps(vault, allowlistPath);
    const out = runList(deps, { path: "Notes/crlf.md" });

    expect(out).toContain("frontmatter:");
    expect(out).toContain("title: CRLF Note");
    expect(out).toContain("tag: one");
    expect(out).toContain("h1: CRLF Heading");
  });

  it("renders nothing for an empty frontmatter block", () => {
    // "---\n---\n" — the delimiters are present but the inner block is empty.
    writeFileSync(
      path.join(vault, "Notes", "empty-fm.md"),
      "---\n---\n# After Empty FM\n\nbody\n",
      "utf8",
    );

    const { deps } = buildDeps(vault, allowlistPath);
    const out = runList(deps, { path: "Notes/empty-fm.md" });

    expect(out).toContain("empty-fm.md");
    // An empty frontmatter block must NOT render a "frontmatter:" header —
    // there is nothing to show.
    expect(out).not.toContain("frontmatter:");
    // The H1 is still pulled from the body that follows the empty block.
    expect(out).toContain("h1: After Empty FM");
  });

  it("omits the h1 line when the body has no H1", () => {
    writeFileSync(
      path.join(vault, "Notes", "no-h1.md"),
      "---\ntitle: No H1\n---\nsome body\n## a sub-heading\n",
      "utf8",
    );

    const { deps } = buildDeps(vault, allowlistPath);
    const out = runList(deps, { path: "Notes/no-h1.md" });

    expect(out).toContain("no-h1.md");
    expect(out).toContain("frontmatter:");
    expect(out).toContain("title: No H1");
    // No "# Heading" anywhere in the body, so the h1 line must be absent.
    expect(out).not.toMatch(/^\s*h1:/m);
  });
});
