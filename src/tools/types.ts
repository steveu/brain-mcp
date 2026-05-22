import type { ZodRawShape } from "zod";
import type { Allowlist } from "../allowlist.js";
import type { AuditSink } from "../audit.js";

// Read tools and write tools sit behind two different trust boundaries
// (see ADR-0001). The Deps types make that visible in the type system:
// a read tool cannot reference the vault root; a write tool cannot
// reference the allowlist.

export type ReadDeps = {
  // Thunk so the allowlist is re-read on every tool call — edits to the
  // allowlist file take effect without restarting the server.
  allowlist: () => Allowlist;
  audit: AuditSink;
};

export type WriteDeps = {
  vault: string;
};

type Tool<Args, Deps> = {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
  // Most tools are synchronous; walk_route shells out to the route engine, so a
  // tool may also return a promise. Awaiting a plain string is a no-op.
  run(deps: Deps, args: Args): string | Promise<string>;
};

export type ReadTool<Args = any> = Tool<Args, ReadDeps>;
export type WriteTool<Args = any> = Tool<Args, WriteDeps>;
