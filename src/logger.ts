import { lstatSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import pino, { type Logger } from "pino";

export type AppLogger = Logger;

export type LoggerOptions = {
  /**
   * User-facing path of the rotating JSON log file. The parent directory is
   * created on first write. pino-roll names rotated files with the rotation
   * number before the extension (e.g. `brain-mcp.1.json`), so we additionally
   * maintain a stable symlink at this exact `filePath` pointing at the
   * currently-active rotated file via pino-roll's `current.log` symlink.
   */
  filePath?: string;
  /**
   * Approximate maximum size of a single log file before rotation, in MB.
   * Defaults to 5MB to match the operational brief.
   */
  sizeMb?: number;
  /**
   * Number of rotated files to retain in addition to the active file.
   */
  retain?: number;
};

/**
 * Build a pino logger that writes structured JSON to a rotating log file.
 *
 * Tokens and Authorization headers are redacted by default so the JSON log
 * cannot leak bearer credentials, even if a future call path forwards the
 * request object verbatim.
 */
export function createAppLogger(options: LoggerOptions = {}): AppLogger {
  const filePath =
    options.filePath ?? path.join(homedir(), "Library", "Logs", "brain-mcp.json");
  const sizeMb = options.sizeMb ?? 5;
  const retain = options.retain ?? 5;

  // Ensure the parent directory exists synchronously so we can create the
  // user-facing symlink immediately (pino-roll itself also handles `mkdir`
  // for its own write target, but the symlink call below needs the directory
  // to exist now).
  const logDir = path.dirname(filePath);
  mkdirSync(logDir, { recursive: true });

  const transport = pino.transport({
    target: "pino-roll",
    options: {
      file: filePath,
      size: `${sizeMb}m`,
      mkdir: true,
      // `current.log` (sibling symlink kept fresh by pino-roll on every
      // rotation) is what we point our user-facing symlink at.
      symlink: true,
      limit: { count: retain },
    },
  });

  // Maintain a stable user-facing symlink at the configured `filePath` so
  // `tail -F` against the documented path always reads the active rotated
  // file. The symlink target is the sibling `current.log` (relative, so the
  // link survives directory moves); pino-roll re-points `current.log` on
  // each rotation, which transitively flows through to our symlink.
  if (path.basename(filePath) !== "current.log") {
    try {
      try {
        const existing = lstatSync(filePath);
        if (existing.isSymbolicLink() || existing.isFile()) {
          unlinkSync(filePath);
        }
      } catch (err) {
        // ENOENT is fine — no prior file at this path.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      symlinkSync("current.log", filePath);
    } catch {
      // A symlink failure (e.g. read-only mount, permissions) must not take
      // down the server; the rotated files and `current.log` are still
      // written.
    }
  }

  return pino(
    {
      // Defence in depth: even though we never log bodies/tokens directly, a
      // serializer mistake should not put a secret on disk.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["set-cookie"]',
          'req.headers.cookie',
          "headers.authorization",
          "token",
          "access_token",
          "client_secret",
          "brain_token",
        ],
        remove: true,
      },
    },
    transport,
  );
}

/**
 * A silent logger for tests — accepts all log calls and writes nowhere.
 * `pino` with level `silent` short-circuits formatting too.
 */
export function silentLogger(): AppLogger {
  return pino({ level: "silent" });
}
