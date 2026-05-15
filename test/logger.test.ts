import { lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppLogger, silentLogger } from "../src/logger.js";

describe("createAppLogger", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "brain-mcp-logger-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes JSON lines to a pino-roll file with secrets redacted", async () => {
    const filePath = path.join(dir, "out.json");
    const logger = createAppLogger({ filePath, sizeMb: 5, retain: 5 });

    logger.info(
      {
        event: "test",
        token: "super-secret-token-value",
        access_token: "another-secret",
        nested: { ok: true },
      },
      "hello",
    );

    // pino-roll runs in a worker thread. Flush by closing the logger and
    // give the FS a moment to settle.
    await new Promise<void>((resolve) => {
      logger.flush(() => resolve());
    });
    await new Promise((r) => setTimeout(r, 300));

    // pino-roll names rotated files as `{base}.{n}.{ext}` — e.g. `out.1.json`.
    const files = readdirSync(dir).filter(
      (f) => f.startsWith("out.") && f.endsWith(".json"),
    );
    expect(files.length).toBeGreaterThan(0);
    const written = readFileSync(path.join(dir, files[0]!), "utf8");
    const firstLine = written.split("\n").find((l) => l.trim().length > 0);
    expect(firstLine).toBeTruthy();
    const parsed = JSON.parse(firstLine!);
    expect(parsed.event).toBe("test");
    expect(parsed.msg).toBe("hello");
    expect(parsed.token).toBeUndefined();
    expect(parsed.access_token).toBeUndefined();
    expect(parsed.nested).toEqual({ ok: true });
    expect(written).not.toContain("super-secret-token-value");
    expect(written).not.toContain("another-secret");
  });

  it("creates a user-facing symlink at filePath pointing at current.log", async () => {
    const filePath = path.join(dir, "out.json");
    const logger = createAppLogger({ filePath });

    logger.info({ event: "warmup" }, "warmup");
    await new Promise<void>((resolve) => logger.flush(() => resolve()));
    await new Promise((r) => setTimeout(r, 300));

    // The user-facing path is a symlink pointing at the relative `current.log`
    // sibling, which pino-roll itself keeps fresh.
    const stat = lstatSync(filePath);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(readlinkSync(filePath)).toBe("current.log");
  });
});

describe("silentLogger", () => {
  it("accepts log calls without throwing and writes nothing observable", () => {
    const logger = silentLogger();
    expect(() => logger.info({ event: "noop" }, "noop")).not.toThrow();
    expect(() => logger.warn({ event: "noop" }, "noop")).not.toThrow();
  });
});
