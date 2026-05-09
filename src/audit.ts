import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export type AuditEntry = {
  ts: string;
  tool: string;
  args: Record<string, unknown>;
  paths_returned: string[];
  redactions_by_prefix: Record<string, number>;
};

export function appendAudit(logPath: string, entry: AuditEntry): void {
  try {
    const dir = path.dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    // Audit failures must not take a tool call down. Log to stderr and move on.
    console.error(`[audit] failed to append: ${(err as Error).message}`);
  }
}
