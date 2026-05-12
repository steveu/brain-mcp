import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { resolveUnderVault } from "../vault-fs.js";
import type { WriteDeps, WriteTool } from "./types.js";

export type AddRecipeArgs = {
  title: string;
  body: string;
};

export function runAddRecipe(deps: WriteDeps, args: AddRecipeArgs): string {
  const cleanedTitle = args.title.replace(/[\\/\0]/g, "").trim();
  if (!cleanedTitle) throw new Error("title is empty after cleaning");
  const recipesDir = resolveUnderVault(deps.vault, "Recipes");
  if (!existsSync(recipesDir)) mkdirSync(recipesDir, { recursive: true });
  const target = resolveUnderVault(deps.vault, "Recipes", `${cleanedTitle}.md`);
  if (existsSync(target)) {
    throw new Error(`recipe already exists: Recipes/${cleanedTitle}.md`);
  }
  const content = args.body.endsWith("\n") ? args.body : args.body + "\n";
  writeFileSync(target, content, "utf8");
  return `created Recipes/${cleanedTitle}.md`;
}

export const addRecipeTool: WriteTool<AddRecipeArgs> = {
  name: "add_recipe",
  title: "Add a recipe",
  description:
    "Create a new recipe note at vault/Recipes/<title>.md with the given markdown body. " +
    "The body should already match the vault's recipe convention (frontmatter + sections); " +
    "the tool only writes the file. Refuses to overwrite an existing recipe with the same title.",
  inputSchema: {
    title: z
      .string()
      .min(1)
      .describe("Recipe title, used verbatim as the filename (preserve case and spaces)."),
    body: z.string().min(1).describe("Full markdown body of the recipe note."),
  },
  run: runAddRecipe,
};
