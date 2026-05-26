import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildDeepLink,
  buildNote,
  extractYouTubeId,
  findExistingNote,
  runSaveVideoNote,
  sanitiseTitle,
  secondsToTimestamp,
  toTitleCase,
} from "../src/tools/save-video-note.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINIMAL_ARGS = {
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  title: "Never Gonna Give You Up",
  channel: "Rick Astley",
  durationHuman: "3:33",
  gist: "Classic 80s pop that redefined internet culture.",
  key_points: [
    { text: "Opening synth hook sets the tone immediately", seconds: 5 },
    { text: "Chorus is deceptively simple yet relentlessly catchy", seconds: 62 },
  ],
};

// ---------------------------------------------------------------------------
// secondsToTimestamp
// ---------------------------------------------------------------------------

describe("secondsToTimestamp", () => {
  it("formats zero as 00:00", () => expect(secondsToTimestamp(0)).toBe("00:00"));
  it("formats 62 seconds as 01:02", () => expect(secondsToTimestamp(62)).toBe("01:02"));
  it("formats 3600 seconds as 60:00", () => expect(secondsToTimestamp(3600)).toBe("60:00"));
  it("pads single-digit seconds", () => expect(secondsToTimestamp(65)).toBe("01:05"));
});

// ---------------------------------------------------------------------------
// extractYouTubeId
// ---------------------------------------------------------------------------

describe("extractYouTubeId", () => {
  it("extracts from long watch URL", () => {
    expect(extractYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from short youtu.be URL", () => {
    expect(extractYouTubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from embed URL", () => {
    expect(extractYouTubeId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from URL with extra query params", () => {
    expect(extractYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("returns null for non-YouTube URL", () => {
    expect(extractYouTubeId("https://example.com/video")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildDeepLink
// ---------------------------------------------------------------------------

describe("buildDeepLink", () => {
  it("formats a deep-link correctly", () => {
    expect(buildDeepLink("dQw4w9WgXcQ", 62)).toBe(
      "[[01:02]](https://youtu.be/dQw4w9WgXcQ?t=62)",
    );
  });

  it("handles zero seconds", () => {
    expect(buildDeepLink("abc123defgh", 0)).toBe(
      "[[00:00]](https://youtu.be/abc123defgh?t=0)",
    );
  });
});

// ---------------------------------------------------------------------------
// Title sanitisation
// ---------------------------------------------------------------------------

describe("toTitleCase", () => {
  it("capitalises first letter of each major word", () => {
    expect(toTitleCase("the quick brown fox")).toBe("The Quick Brown Fox");
  });

  it("lowercases minor words mid-title", () => {
    expect(toTitleCase("war and peace")).toBe("War and Peace");
  });

  it("capitalises the first word even if it is a minor word", () => {
    expect(toTitleCase("a tale of two cities")).toBe("A Tale of Two Cities");
  });
});

describe("sanitiseTitle", () => {
  it("strips '| TED' suffix", () => {
    expect(sanitiseTitle("How Great Leaders Inspire Action | TED")).toBe(
      "How Great Leaders Inspire Action",
    );
  });

  it("strips '| TEDx...' suffix", () => {
    expect(sanitiseTitle("Some Talk | TEDxLondon 2023")).toBe("Some Talk");
  });

  it("strips '(Official Video)'", () => {
    expect(sanitiseTitle("never gonna give you up (Official Video)")).toBe(
      "Never Gonna Give You Up",
    );
  });

  it("strips '(Official Music Video)'", () => {
    expect(sanitiseTitle("Bohemian Rhapsody (Official Music Video)")).toBe(
      "Bohemian Rhapsody",
    );
  });

  it("strips '[4K]' tag", () => {
    expect(sanitiseTitle("Amazing Landscapes [4K]")).toBe("Amazing Landscapes");
  });

  it("strips '[HD]' tag", () => {
    expect(sanitiseTitle("Drone footage [HD]")).toBe("Drone Footage");
  });

  it("applies Title Case", () => {
    expect(sanitiseTitle("how great leaders inspire action")).toBe(
      "How Great Leaders Inspire Action",
    );
  });

  it("strips filesystem-unsafe characters", () => {
    expect(sanitiseTitle("Talk: Ideas / Futures")).toBe("Talk Ideas Futures");
  });

  it("throws when nothing remains after sanitisation", () => {
    expect(() => sanitiseTitle("| TED")).toThrow(/empty after sanitisation/);
  });

  it("trims whitespace", () => {
    expect(sanitiseTitle("  My Video  ")).toBe("My Video");
  });
});

// ---------------------------------------------------------------------------
// buildNote
// ---------------------------------------------------------------------------

describe("buildNote", () => {
  it("produces correct frontmatter", () => {
    const note = buildNote(MINIMAL_ARGS, "dQw4w9WgXcQ");
    expect(note).toContain("source: https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(note).toContain("channel: Rick Astley");
    expect(note).toMatch(/captured: \d{4}-\d{2}-\d{2}/);
  });

  it("uses only the three allowed frontmatter keys", () => {
    const note = buildNote(MINIMAL_ARGS, "dQw4w9WgXcQ");
    const fmMatch = note.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    const fmLines = fmMatch![1]
      .split("\n")
      .map((l) => l.split(":")[0].trim())
      .filter(Boolean);
    expect(fmLines).toEqual(["source", "channel", "captured"]);
  });

  it("includes the gist immediately after frontmatter", () => {
    const note = buildNote(MINIMAL_ARGS, "dQw4w9WgXcQ");
    // After the closing --- there should be a blank line then the gist.
    expect(note).toContain("---\n\nClassic 80s pop that redefined internet culture.");
  });

  it("renders key points with deep-links", () => {
    const note = buildNote(MINIMAL_ARGS, "dQw4w9WgXcQ");
    expect(note).toContain(
      "- Opening synth hook sets the tone immediately — [[00:05]](https://youtu.be/dQw4w9WgXcQ?t=5)",
    );
    expect(note).toContain(
      "- Chorus is deceptively simple yet relentlessly catchy — [[01:02]](https://youtu.be/dQw4w9WgXcQ?t=62)",
    );
  });

  it("writes scaffold placeholder when takeaways is omitted", () => {
    const note = buildNote(MINIMAL_ARGS, "dQw4w9WgXcQ");
    expect(note).toContain(
      "*(What did this change for you? — fill in on a later pass.)*",
    );
  });

  it("writes supplied takeaways instead of scaffold", () => {
    const note = buildNote(
      { ...MINIMAL_ARGS, takeaways: "This changed how I think about pop hooks." },
      "dQw4w9WgXcQ",
    );
    expect(note).toContain("This changed how I think about pop hooks.");
    expect(note).not.toContain("fill in on a later pass");
  });

  it("includes the ## Source footer with title link, channel and duration", () => {
    const note = buildNote(MINIMAL_ARGS, "dQw4w9WgXcQ");
    expect(note).toContain(
      "[Never Gonna Give You Up](https://www.youtube.com/watch?v=dQw4w9WgXcQ) — Rick Astley, 3:33",
    );
  });

  it("normalises the URL to the long watch form in frontmatter", () => {
    // Even if the input URL is a youtu.be short link, the canonical URL goes in frontmatter.
    const argsWithShortUrl = { ...MINIMAL_ARGS, url: "https://youtu.be/dQw4w9WgXcQ" };
    const note = buildNote(argsWithShortUrl, "dQw4w9WgXcQ");
    expect(note).toContain("source: https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});

// ---------------------------------------------------------------------------
// findExistingNote (frontmatter dedupe)
// ---------------------------------------------------------------------------

describe("findExistingNote", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "brain-mcp-sources-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when Sources/ does not exist", () => {
    expect(findExistingNote(path.join(dir, "Sources"), "https://youtu.be/abc")).toBeNull();
  });

  it("returns null when no note matches the URL", () => {
    const sourcesDir = path.join(dir, "Sources");
    mkdirSync(sourcesDir);
    writeFileSync(
      path.join(sourcesDir, "Some Video.md"),
      "---\nsource: https://www.youtube.com/watch?v=AAAABBBBCCC\nchannel: Test\ncaptured: 2025-01-01\n---\n\nGist.\n",
    );
    expect(
      findExistingNote(sourcesDir, "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).toBeNull();
  });

  it("finds a match by exact long-form URL", () => {
    const sourcesDir = path.join(dir, "Sources");
    mkdirSync(sourcesDir);
    writeFileSync(
      path.join(sourcesDir, "Existing Video.md"),
      "---\nsource: https://www.youtube.com/watch?v=dQw4w9WgXcQ\nchannel: Rick Astley\ncaptured: 2025-01-01\n---\n\nGist.\n",
    );
    const result = findExistingNote(
      sourcesDir,
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(result).toBe(path.join("Sources", "Existing Video.md"));
  });

  it("matches a short youtu.be URL against a stored long-form source", () => {
    const sourcesDir = path.join(dir, "Sources");
    mkdirSync(sourcesDir);
    writeFileSync(
      path.join(sourcesDir, "Existing Video.md"),
      "---\nsource: https://www.youtube.com/watch?v=dQw4w9WgXcQ\nchannel: Rick Astley\ncaptured: 2025-01-01\n---\n\nGist.\n",
    );
    const result = findExistingNote(sourcesDir, "https://youtu.be/dQw4w9WgXcQ");
    expect(result).toBe(path.join("Sources", "Existing Video.md"));
  });

  it("ignores files without a frontmatter source: key", () => {
    const sourcesDir = path.join(dir, "Sources");
    mkdirSync(sourcesDir);
    writeFileSync(
      path.join(sourcesDir, "No Frontmatter.md"),
      "Just a bare note with no frontmatter.\n",
    );
    expect(
      findExistingNote(sourcesDir, "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runSaveVideoNote (integration)
// ---------------------------------------------------------------------------

describe("runSaveVideoNote", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(path.join(tmpdir(), "brain-mcp-vault-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("creates Sources/ if it does not exist", () => {
    const sourcesDir = path.join(vault, "Sources");
    expect(existsSync(sourcesDir)).toBe(false);
    runSaveVideoNote({ vault }, MINIMAL_ARGS);
    expect(existsSync(sourcesDir)).toBe(true);
  });

  it("returns {status:'ok', path, relativePath} on success", () => {
    const result = JSON.parse(runSaveVideoNote({ vault }, MINIMAL_ARGS));
    expect(result.status).toBe("ok");
    expect(result.relativePath).toBe("Sources/Never Gonna Give You Up.md");
    expect(result.path).toContain("Sources");
  });

  it("writes the file with correct content", () => {
    runSaveVideoNote({ vault }, MINIMAL_ARGS);
    const content = readFileSync(
      path.join(vault, "Sources", "Never Gonna Give You Up.md"),
      "utf8",
    );
    expect(content).toContain("source: https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(content).toContain("## Key points");
    expect(content).toContain("## My takeaways");
    expect(content).toContain("## Source");
  });

  it("returns {status:'exists', path} when a note for the URL already exists, without overwriting", () => {
    runSaveVideoNote({ vault }, MINIMAL_ARGS);

    // Call again with the same URL but a different title.
    const result = JSON.parse(
      runSaveVideoNote({ vault }, { ...MINIMAL_ARGS, title: "Rick Roll Redux" }),
    );
    expect(result.status).toBe("exists");
    expect(result.path).toContain("Never Gonna Give You Up.md");

    // Original file is untouched.
    const files = readdirSyncSafe(path.join(vault, "Sources"));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe("Never Gonna Give You Up.md");
  });

  it("detects an existing note via a short URL when stored as long-form", () => {
    runSaveVideoNote({ vault }, MINIMAL_ARGS);
    const result = JSON.parse(
      runSaveVideoNote({ vault }, { ...MINIMAL_ARGS, url: "https://youtu.be/dQw4w9WgXcQ" }),
    );
    expect(result.status).toBe("exists");
  });

  it("sanitises the title for the filename", () => {
    const argsWithClutter = {
      ...MINIMAL_ARGS,
      title: "Never Gonna Give You Up (Official Video)",
    };
    const result = JSON.parse(runSaveVideoNote({ vault }, argsWithClutter));
    expect(result.relativePath).toBe("Sources/Never Gonna Give You Up.md");
  });

  it("throws when the URL contains no extractable YouTube ID", () => {
    expect(() =>
      runSaveVideoNote({ vault }, { ...MINIMAL_ARGS, url: "https://example.com/video" }),
    ).toThrow(/could not extract YouTube video ID/);
  });

  it("throws on filename collision when URLs differ", () => {
    runSaveVideoNote({ vault }, MINIMAL_ARGS);
    // Same title, different URL (different video ID).
    expect(() =>
      runSaveVideoNote({ vault }, {
        ...MINIMAL_ARGS,
        url: "https://www.youtube.com/watch?v=AAAABBBBCCC",
      }),
    ).toThrow(/already exists at Sources\//);
  });

  it("writes scaffold when takeaways is omitted", () => {
    runSaveVideoNote({ vault }, MINIMAL_ARGS);
    const content = readFileSync(
      path.join(vault, "Sources", "Never Gonna Give You Up.md"),
      "utf8",
    );
    expect(content).toContain("fill in on a later pass");
  });

  it("writes supplied takeaways instead of scaffold", () => {
    runSaveVideoNote({ vault }, { ...MINIMAL_ARGS, takeaways: "Memorable hook analysis." });
    const content = readFileSync(
      path.join(vault, "Sources", "Never Gonna Give You Up.md"),
      "utf8",
    );
    expect(content).toContain("Memorable hook analysis.");
    expect(content).not.toContain("fill in on a later pass");
  });
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
