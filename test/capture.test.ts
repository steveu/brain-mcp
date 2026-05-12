import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCapture } from "../src/tools/capture.js";

describe("runCapture", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(path.join(tmpdir(), "brain-mcp-test-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("appends a thought to today's daily note, creating it on first write", () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

    const first = runCapture({ vault }, { thought: "first thought" });
    expect(first).toBe(`appended to ${today}.md`);

    const second = runCapture({ vault }, { thought: "second thought" });
    expect(second).toBe(`appended to ${today}.md`);

    const contents = readFileSync(path.join(vault, `${today}.md`), "utf8");
    expect(contents).toBe("first thought\n\nsecond thought\n");
  });
});
