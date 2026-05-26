import { describe, expect, it } from "vitest";
import {
  flattenJson3,
  mapYtdlpError,
  pickTrack,
  runFetchTranscript,
  ytdlpArgs,
  type FetchTranscriptDeps,
} from "../src/tools/fetch-transcript.js";

const META = {
  id: "abc123def45",
  title: "Test Video",
  uploader: "Test Channel",
  uploader_url: "https://youtube.com/@test",
  duration: 125,
  upload_date: "20260102",
  webpage_url: "https://www.youtube.com/watch?v=abc123def45",
};

function deps(overrides: Partial<FetchTranscriptDeps> = {}): FetchTranscriptDeps {
  return {
    exec: async () => ({ stdout: JSON.stringify(META), stderr: "" }),
    fetchJson: async () => ({ events: [] }),
    ytdlpBin: "yt-dlp",
    nodeBin: "/usr/local/bin/node",
    ...overrides,
  };
}

describe("flattenJson3", () => {
  it("collapses rolling auto-caption prefixes while keeping the first timestamp", () => {
    const lines = flattenJson3([
      { tStartMs: 1000, segs: [{ utf8: "hello" }] },
      { tStartMs: 1300, segs: [{ utf8: "hello world" }] },
      { tStartMs: 1800, segs: [{ utf8: "hello world" }] },
      { tStartMs: 3000, segs: [{ utf8: "next phrase" }] },
    ]);

    expect(lines).toEqual([
      { t: 1000, text: "hello world" },
      { t: 3000, text: "next phrase" },
    ]);
  });

  it("normalises whitespace and skips empty events", () => {
    expect(
      flattenJson3([
        { tStartMs: 0, segs: [{ utf8: " \n " }] },
        { tStartMs: 42, segs: [{ utf8: "a\n" }, { utf8: "  b" }] },
      ]),
    ).toEqual([{ t: 42, text: "a b" }]);
  });
});

describe("pickTrack", () => {
  it("prefers manual English subtitles over auto-captions", () => {
    const track = pickTrack({
      subtitles: { en: [{ ext: "json3", url: "manual" }] },
      automatic_captions: { en: [{ ext: "json3", url: "auto" }] },
    });
    expect(track).toEqual({ kind: "manual", lang: "en", url: "manual" });
  });

  it("falls back through en, en-GB, en-US, en-orig", () => {
    expect(pickTrack({ subtitles: { "en-GB": [{ ext: "json3", url: "gb" }] } })).toEqual({
      kind: "manual",
      lang: "en-GB",
      url: "gb",
    });
    expect(pickTrack({ subtitles: { "en-US": [{ ext: "json3", url: "us" }] } })).toEqual({
      kind: "manual",
      lang: "en-US",
      url: "us",
    });
    expect(pickTrack({ subtitles: { "en-orig": [{ ext: "json3", url: "orig" }] } })).toEqual({
      kind: "manual",
      lang: "en-orig",
      url: "orig",
    });
  });

  it("uses auto-captions when no manual English json3 track exists", () => {
    expect(
      pickTrack({
        subtitles: { en: [{ ext: "vtt", url: "manual-vtt" }] },
        automatic_captions: { en: [{ ext: "json3", url: "auto" }] },
      }),
    ).toEqual({ kind: "auto", lang: "en", url: "auto" });
  });
});

describe("mapYtdlpError", () => {
  it("maps known terminal yt-dlp errors", () => {
    expect(mapYtdlpError("Private video")).toBe("The video is private.");
    expect(mapYtdlpError("Video unavailable")).toBe("The video isn't available any more.");
    expect(mapYtdlpError("not available in your country")).toBe("The video isn't available in this region.");
    expect(mapYtdlpError("age restricted")).toBe("The video is age-restricted and needs a signed-in session.");
    expect(mapYtdlpError("Sign in to confirm you're not a bot")).toBe("YouTube returned a bot-detection challenge for this fetch.");
    expect(mapYtdlpError("Unsupported URL")).toBe("That doesn't look like a supported video URL.");
  });
});

describe("runFetchTranscript", () => {
  it("passes the bgutil-aware mweb flags to yt-dlp", async () => {
    const calls: { file: string; args: string[] }[] = [];
    await runFetchTranscript(
      deps({
        exec: async (file, args) => {
          calls.push({ file, args });
          return {
            stdout: JSON.stringify({
              ...META,
              subtitles: { en: [{ ext: "json3", url: "caption-url" }] },
            }),
            stderr: "",
          };
        },
        fetchJson: async () => ({ events: [{ tStartMs: 0, segs: [{ utf8: "hello" }] }] }),
      }),
      { url: "https://youtu.be/abc123def45" },
    );

    expect(calls[0].file).toBe("yt-dlp");
    expect(calls[0].args).toEqual(ytdlpArgs("https://youtu.be/abc123def45", "/usr/local/bin/node"));
    expect(calls[0].args).toContain("--js-runtimes");
    expect(calls[0].args).toContain("node:/usr/local/bin/node");
    expect(calls[0].args).toContain("--remote-components");
    expect(calls[0].args).toContain("ejs:github");
    expect(calls[0].args).toContain("youtube:player_client=mweb");
  });

  it("returns ok with metadata and inline timestamped transcript", async () => {
    const result = await runFetchTranscript(
      deps({
        exec: async () => ({
          stdout: JSON.stringify({
            ...META,
            subtitles: { en: [{ ext: "json3", url: "caption-url" }] },
          }),
          stderr: "",
        }),
        fetchJson: async (url) => {
          expect(url).toBe("caption-url");
          return {
            events: [
              { tStartMs: 1000, segs: [{ utf8: "hello" }] },
              { tStartMs: 1500, segs: [{ utf8: "hello world" }] },
              { tStartMs: 61000, segs: [{ utf8: "second line" }] },
            ],
          };
        },
      }),
      { url: "https://youtu.be/abc123def45" },
    );

    expect(result).toMatchObject({
      status: "ok",
      id: "abc123def45",
      title: "Test Video",
      channel: "Test Channel",
      channelUrl: "https://youtube.com/@test",
      duration: 125,
      durationHuman: "2:05",
      uploadDate: "20260102",
      webpageUrl: "https://www.youtube.com/watch?v=abc123def45",
      captionKind: "manual",
      captionLang: "en",
      lineCount: 2,
      transcript: "[0:01] hello world\n[1:01] second line",
    });
    expect(result.status === "ok" ? result.charCount : 0).toBe(37);
  });

  it("returns no-transcript when no English captions exist", async () => {
    const result = await runFetchTranscript(deps(), { url: "https://youtu.be/abc123def45" });
    expect(result).toMatchObject({
      status: "no-transcript",
      reason: "No English captions (manual or auto) are available for this video.",
      id: "abc123def45",
      title: "Test Video",
    });
  });

  it("returns no-transcript when the caption fetch fails", async () => {
    const result = await runFetchTranscript(
      deps({
        exec: async () => ({
          stdout: JSON.stringify({ ...META, subtitles: { en: [{ ext: "json3", url: "caption-url" }] } }),
          stderr: "",
        }),
        fetchJson: async () => {
          throw new Error("HTTP 403");
        },
      }),
      { url: "https://youtu.be/abc123def45" },
    );
    expect(result).toMatchObject({
      status: "no-transcript",
      reason: "Found an English manual caption track but couldn't fetch it (HTTP 403).",
      id: "abc123def45",
    });
  });

  it("returns an error for malformed yt-dlp JSON", async () => {
    const result = await runFetchTranscript(
      deps({ exec: async () => ({ stdout: "{nope", stderr: "" }) }),
      { url: "https://youtu.be/abc123def45" },
    );
    expect(result).toEqual({ status: "error", reason: "yt-dlp returned output that was not valid JSON." });
  });

  it("returns mapped errors from failed yt-dlp runs", async () => {
    const result = await runFetchTranscript(
      deps({
        exec: async () => {
          const err = new Error("Command failed") as Error & { stderr: string };
          err.stderr = "ERROR: Private video";
          throw err;
        },
      }),
      { url: "https://youtu.be/abc123def45" },
    );
    expect(result).toEqual({ status: "error", reason: "The video is private.", raw: "ERROR: Private video" });
  });
});
