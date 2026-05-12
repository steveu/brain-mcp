import { addRecipeTool } from "./add-recipe.js";
import { captureTool } from "./capture.js";
import { createMatchTool } from "./create-match.js";
import type { WriteTool } from "./types.js";

export const writeTools: WriteTool[] = [captureTool, createMatchTool, addRecipeTool];
