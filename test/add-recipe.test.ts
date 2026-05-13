import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAddRecipe } from "../src/tools/add-recipe.js";

describe("runAddRecipe", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(path.join(tmpdir(), "brain-mcp-test-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("strips /, \\ and NUL from the title and throws when nothing remains", () => {
    const slash = "/";
    const backslash = "\\";
    const nul = String.fromCharCode(0);
    // "Risotto" sprinkled with each forbidden character plus leading/trailing
    // whitespace. After cleaning, only the letters of "Risotto" should remain.
    const dirty = `  R${slash}is${backslash}ot${nul}to  `;
    const result = runAddRecipe({ vault }, { title: dirty, body: "yum" });
    expect(result).toBe("created Recipes/Risotto.md");
    expect(existsSync(path.join(vault, "Recipes", "Risotto.md"))).toBe(true);

    // A title made entirely of strippable characters and whitespace must throw.
    const allStripped = `${slash}${backslash}${nul}   `;
    expect(() =>
      runAddRecipe({ vault }, { title: allStripped, body: "yum" }),
    ).toThrow(/title is empty after cleaning/);
  });

  it("refuses to overwrite an existing Recipes/<title>.md", () => {
    runAddRecipe({ vault }, { title: "Risotto", body: "first draft" });

    expect(() =>
      runAddRecipe({ vault }, { title: "Risotto", body: "second draft" }),
    ).toThrow(/recipe already exists: Recipes\/Risotto\.md/);

    // The original file must be untouched.
    const contents = readFileSync(path.join(vault, "Recipes", "Risotto.md"), "utf8");
    expect(contents).toBe("first draft\n");
  });

  it("ensures the written file ends with a trailing newline even when body does not", () => {
    runAddRecipe({ vault }, { title: "Pancakes", body: "no trailing newline" });

    const contents = readFileSync(path.join(vault, "Recipes", "Pancakes.md"), "utf8");
    expect(contents).toBe("no trailing newline\n");
  });
});
