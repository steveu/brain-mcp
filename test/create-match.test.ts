import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCreateMatch } from "../src/tools/create-match.js";

// A template that exercises every branch fillMatchTemplate can take:
// - empty fields filled via setEmptyField: date, opposition, team, pitch_condition, focus_area
// - defaulted fields overridden via overrideField: pitch_type, importance
// - placeholders replaced in the body: {{opposition}}, {{date}}, {{notes}}, {{focus_area}}
const FULL_TEMPLATE = `---
date:
opposition:
team:
pitch_type: grass
pitch_condition:
focus_area:
importance: league
---
# {{date}} — vs {{opposition}}

## Context
{{notes}}

## Focus
{{focus_area}}
`;

function writeTemplate(vault: string, contents: string): void {
  mkdirSync(path.join(vault, "Templates"), { recursive: true });
  writeFileSync(path.join(vault, "Templates", "Match.md"), contents, "utf8");
}

function todayLondon(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}

describe("runCreateMatch", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(path.join(tmpdir(), "brain-mcp-create-match-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  describe("fillMatchTemplate behaviour (via runCreateMatch)", () => {
    it("fills empty date, opposition, and team frontmatter fields", () => {
      writeTemplate(vault, FULL_TEMPLATE);

      const result = runCreateMatch(
        { vault },
        {
          date: "2026-03-14",
          team: "Fulford FC",
          opposition: "Heslington",
        },
      );

      expect(result).toBe("created Matches/2026-03-14 — Fulford FC vs Heslington.md");
      const contents = readFileSync(
        path.join(vault, "Matches", "2026-03-14 — Fulford FC vs Heslington.md"),
        "utf8",
      );
      expect(contents).toContain("date: 2026-03-14");
      expect(contents).toContain("opposition: Heslington");
      expect(contents).toContain("team: Fulford FC");
      // Placeholders in the body are substituted too.
      expect(contents).toContain("# 2026-03-14 — vs Heslington");
    });

    it("overrides defaulted pitch_type and importance fields when supplied", () => {
      writeTemplate(vault, FULL_TEMPLATE);

      runCreateMatch(
        { vault },
        {
          date: "2026-03-14",
          team: "Fulford FC",
          opposition: "Heslington",
          pitch_type: "3G",
          importance: "cup-final",
        },
      );

      const contents = readFileSync(
        path.join(vault, "Matches", "2026-03-14 — Fulford FC vs Heslington.md"),
        "utf8",
      );
      expect(contents).toContain("pitch_type: 3G");
      expect(contents).toContain("importance: cup-final");
      // Defaults should be gone from the frontmatter.
      expect(contents).not.toMatch(/^pitch_type: grass$/m);
      expect(contents).not.toMatch(/^importance: league$/m);
    });

    it("keeps template defaults for pitch_type and importance when args omit them", () => {
      writeTemplate(vault, FULL_TEMPLATE);

      runCreateMatch(
        { vault },
        {
          date: "2026-03-14",
          team: "Fulford FC",
          opposition: "Heslington",
        },
      );

      const contents = readFileSync(
        path.join(vault, "Matches", "2026-03-14 — Fulford FC vs Heslington.md"),
        "utf8",
      );
      expect(contents).toMatch(/^pitch_type: grass$/m);
      expect(contents).toMatch(/^importance: league$/m);
    });

    it("substitutes {{notes}} and {{focus_area}} placeholders and the focus_area frontmatter field", () => {
      writeTemplate(vault, FULL_TEMPLATE);

      runCreateMatch(
        { vault },
        {
          date: "2026-03-14",
          team: "Fulford FC",
          opposition: "Heslington",
          focus_area: "using your eyes",
          notes: "U13s, away fixture",
        },
      );

      const contents = readFileSync(
        path.join(vault, "Matches", "2026-03-14 — Fulford FC vs Heslington.md"),
        "utf8",
      );
      expect(contents).toContain("focus_area: using your eyes");
      expect(contents).toContain("U13s, away fixture");
      expect(contents).toMatch(/## Focus\nusing your eyes/);
      // Unused placeholders should be empty, not literal {{...}}.
      expect(contents).not.toContain("{{notes}}");
      expect(contents).not.toContain("{{focus_area}}");
    });

    it("leaves {{notes}} and {{focus_area}} empty when omitted", () => {
      writeTemplate(vault, FULL_TEMPLATE);

      runCreateMatch(
        { vault },
        {
          date: "2026-03-14",
          team: "Fulford FC",
          opposition: "Heslington",
        },
      );

      const contents = readFileSync(
        path.join(vault, "Matches", "2026-03-14 — Fulford FC vs Heslington.md"),
        "utf8",
      );
      expect(contents).not.toContain("{{notes}}");
      expect(contents).not.toContain("{{focus_area}}");
      // The Context section should be present but empty between the heading and Focus.
      expect(contents).toMatch(/## Context\n\n\n## Focus/);
    });

    it("throws when the template is missing a required empty field (date)", () => {
      writeTemplate(
        vault,
        `---
opposition:
team:
pitch_type: grass
importance: league
---
body
`,
      );

      expect(() =>
        runCreateMatch(
          { vault },
          { date: "2026-03-14", team: "Fulford FC", opposition: "Heslington" },
        ),
      ).toThrow(/template missing empty 'date:' field/);
    });

    it("throws when the template is missing a required empty field (opposition)", () => {
      writeTemplate(
        vault,
        `---
date:
team:
pitch_type: grass
importance: league
---
body
`,
      );

      expect(() =>
        runCreateMatch(
          { vault },
          { date: "2026-03-14", team: "Fulford FC", opposition: "Heslington" },
        ),
      ).toThrow(/template missing empty 'opposition:' field/);
    });

    it("throws when an overridden field is missing from the template (pitch_type)", () => {
      writeTemplate(
        vault,
        `---
date:
opposition:
team:
importance: league
---
body
`,
      );

      expect(() =>
        runCreateMatch(
          { vault },
          {
            date: "2026-03-14",
            team: "Fulford FC",
            opposition: "Heslington",
            pitch_type: "3G",
          },
        ),
      ).toThrow(/template missing 'pitch_type:' field/);
    });
  });

  describe("filename sanitisation", () => {
    it("strips forward slashes from team and opposition before composing the filename", () => {
      writeTemplate(vault, FULL_TEMPLATE);

      const result = runCreateMatch(
        { vault },
        {
          date: "2026-03-14",
          team: "Ful/ford FC",
          opposition: "Hes/lington",
        },
      );

      expect(result).toBe("created Matches/2026-03-14 — Fulford FC vs Heslington.md");
      expect(
        existsSync(
          path.join(vault, "Matches", "2026-03-14 — Fulford FC vs Heslington.md"),
        ),
      ).toBe(true);
    });

    it("strips backslashes and NUL bytes from team and opposition", () => {
      writeTemplate(vault, FULL_TEMPLATE);

      const result = runCreateMatch(
        { vault },
        {
          date: "2026-03-14",
          team: "Fulford\\FC",
          opposition: "Hes\0lington",
        },
      );

      expect(result).toBe("created Matches/2026-03-14 — FulfordFC vs Heslington.md");
    });

    it("throws when team is empty after stripping unsafe characters", () => {
      writeTemplate(vault, FULL_TEMPLATE);

      expect(() =>
        runCreateMatch(
          { vault },
          { date: "2026-03-14", team: "///", opposition: "Heslington" },
        ),
      ).toThrow(/team is empty after cleaning/);
    });

    it("throws when opposition is empty after stripping unsafe characters", () => {
      writeTemplate(vault, FULL_TEMPLATE);

      expect(() =>
        runCreateMatch(
          { vault },
          { date: "2026-03-14", team: "Fulford FC", opposition: "\0\0\0" },
        ),
      ).toThrow(/opposition is empty after cleaning/);
    });
  });

  describe("overwrite protection", () => {
    it("refuses to overwrite an existing match note at the target path", () => {
      writeTemplate(vault, FULL_TEMPLATE);

      runCreateMatch(
        { vault },
        {
          date: "2026-03-14",
          team: "Fulford FC",
          opposition: "Heslington",
        },
      );

      expect(() =>
        runCreateMatch(
          { vault },
          {
            date: "2026-03-14",
            team: "Fulford FC",
            opposition: "Heslington",
          },
        ),
      ).toThrow(/match already exists: Matches\/2026-03-14 — Fulford FC vs Heslington\.md/);
    });
  });

  describe("date defaulting", () => {
    it("defaults date to today in Europe/London when omitted", () => {
      writeTemplate(vault, FULL_TEMPLATE);
      const today = todayLondon();

      const result = runCreateMatch(
        { vault },
        { team: "Fulford FC", opposition: "Heslington" },
      );

      expect(result).toBe(`created Matches/${today} — Fulford FC vs Heslington.md`);
      const contents = readFileSync(
        path.join(vault, "Matches", `${today} — Fulford FC vs Heslington.md`),
        "utf8",
      );
      expect(contents).toContain(`date: ${today}`);
    });
  });

  describe("missing template", () => {
    it("throws cleanly when Templates/Match.md is missing", () => {
      // Vault exists but has no Templates directory.
      expect(() =>
        runCreateMatch(
          { vault },
          { date: "2026-03-14", team: "Fulford FC", opposition: "Heslington" },
        ),
      ).toThrow(/template not found at Templates\/Match\.md/);
    });
  });
});
