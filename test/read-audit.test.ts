import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAllowlist } from "../src/allowlist.js";
import { memoryAuditSink } from "../src/audit.js";
import { runFetch } from "../src/tools/fetch.js";
import { runGrep } from "../src/tools/grep.js";
import { runList } from "../src/tools/list.js";

describe("read tools audit sink", () => {
  let vault: string;
  let allowlistPath: string;

  beforeEach(() => {
    vault = mkdtempSync(path.join(tmpdir(), "brain-mcp-audit-"));
    mkdirSync(path.join(vault, "Notes"), { recursive: true });
    writeFileSync(
      path.join(vault, "Notes", "one.md"),
      "---\ntitle: One\n---\n# One\n\nhello world\n",
      "utf8",
    );
    writeFileSync(
      path.join(vault, "Notes", "two.md"),
      "# Two\n\nhello again\n",
      "utf8",
    );
    allowlistPath = path.join(path.dirname(vault), `allowlist-${path.basename(vault)}`);
    writeFileSync(allowlistPath, "Notes/\n", "utf8");
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
    rmSync(allowlistPath, { force: true });
  });

  it("records list/fetch/grep entries via the injected sink", () => {
    const allowlist = loadAllowlist(vault, allowlistPath);
    const audit = memoryAuditSink();
    const deps = { allowlist: () => allowlist, audit };

    runList(deps, {});
    runFetch(deps, { path: "Notes/one.md" });
    runGrep(deps, { query: "hello" });

    expect(audit.entries.map((e) => e.tool)).toEqual(["list", "fetch", "grep"]);

    const fetchEntry = audit.entries[1];
    expect(fetchEntry?.args).toEqual({ path: "Notes/one.md" });
    expect(fetchEntry?.paths_returned).toEqual(["Notes/one.md"]);

    const grepEntry = audit.entries[2];
    expect(grepEntry?.args).toEqual({ query: "hello", path: null });
    expect(grepEntry?.paths_returned.sort()).toEqual([
      "Notes/one.md",
      "Notes/two.md",
    ]);

    for (const entry of audit.entries) {
      expect(new Date(entry.ts).toString()).not.toBe("Invalid Date");
    }
  });
});
