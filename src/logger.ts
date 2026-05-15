import { homedir } from "node:os";
import path from "node:path";
import pino, { type Logger } from "pino";

export type AppLogger = Logger;

export type LoggerOptions = {
  /**
   * Absolute path of the rotating JSON log file. The parent directory is
   * created on first write.
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
  // Caller passes the conceptual base path (e.g. `~/Library/Logs/brain-mcp.json`);
  // pino-roll strips the last extension from `file` and re-appends it after the
  // rotation number, so the actual files on disk are e.g.
  // `~/Library/Logs/brain-mcp.1.json`, `brain-mcp.2.json`, ...
  // `current.log` (a sibling symlink, kept up to date by pino-roll) always
  // points at the active file — that is the stable path for `tail -F`.
  const filePath =
    options.filePath ?? path.join(homedir(), "Library", "Logs", "brain-mcp.json");
  const sizeMb = options.sizeMb ?? 5;
  const retain = options.retain ?? 5;

  const transport = pino.transport({
    target: "pino-roll",
    options: {
      file: filePath,
      size: `${sizeMb}m`,
      mkdir: true,
      symlink: true,
      limit: { count: retain },
    },
  });

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
