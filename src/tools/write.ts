import { addRecipeTool } from "./add-recipe.js";
import { captureTool } from "./capture.js";
import { createMatchTool } from "./create-match.js";
import { saveVideoNoteTool } from "./save-video-note.js";
import type { WriteTool } from "./types.js";
import { saveRouteTool, walkRouteTool } from "./walk-route.js";

export const writeTools: WriteTool[] = [
  captureTool,
  createMatchTool,
  addRecipeTool,
  walkRouteTool,
  saveRouteTool,
  saveVideoNoteTool,
];
