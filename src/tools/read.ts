import { fetchTool } from "./fetch.js";
import { grepTool } from "./grep.js";
import { listTool } from "./list.js";
import type { ReadTool } from "./types.js";

export const readTools: ReadTool[] = [listTool, fetchTool, grepTool];
