import closeWithGrace from "close-with-grace";
import { homedir } from "node:os";
import path from "node:path";
import { createAppLogger } from "./logger.js";
import { defaultDataDir } from "./tools/walk-route.js";
import {
  createTrailsService,
  purgeUnsafeDrafts,
  sweepDrafts,
  type TrailsServiceConfig,
} from "./trails-service.js";

// Entry point for the standalone trails map service. Mirrors src/main.ts: read
// config from env, bind a loopback listener, wire close-with-grace, and use the
// rotating-file logger. The TTL sweep lives here (not in createTrailsService) so
// the service stays side-effect-free and easy to test.

const HOUR_MS = 60 * 60 * 1000;

type TrailsRuntimeConfig = {
  config: TrailsServiceConfig;
  port: number;
  dataDir: string;
  ttlMs: number;
};

function readConfig(): TrailsRuntimeConfig {
  // MCP uses 8765; the map service gets its own loopback port so its public
  // exposure is independent of the /mcp connector.
  const port = Number(process.env.TRAILS_PORT ?? 8766);
  const dataDir = defaultDataDir();
  const osApiKey = process.env.OS_API_KEY || undefined;
  const ttlHours = Number(process.env.TRAILS_DRAFT_TTL_HOURS ?? 168); // 7 days
  const ttlMs = ttlHours * HOUR_MS;
  const logFilePath =
    process.env.TRAILS_LOG_FILE ??
    path.join(homedir(), "data", "brain-mcp", "logs", "trails.json");

  const logger = createAppLogger({ filePath: logFilePath });

  return {
    config: { dataDir, osApiKey, logger },
    port,
    dataDir,
    ttlMs,
  };
}

function main(): void {
  const { config, port, dataDir, ttlMs } = readConfig();
  const logger = config.logger;
  const app = createTrailsService(config);

  // One-time migration before serving: delete any stale pre-#33 draft whose HTML
  // embeds an OS key, so the service can never hand a key-bearing page to a
  // browser. Synchronous, so it completes before any request is accepted; a
  // no-op on a clean dir since current renders are key-less.
  try {
    const purged = purgeUnsafeDrafts(dataDir);
    if (purged.length > 0) {
      logger?.warn(
        { event: "draft_purge", count: purged.length },
        "purged stale drafts that embedded an OS key",
      );
    }
  } catch (err) {
    logger?.warn(
      { event: "draft_purge", err_message: (err as Error).message },
      "draft purge failed",
    );
  }

  const httpServer = app.listen(port, "127.0.0.1", () => {
    const tileMode = config.osApiKey
      ? "tile proxy enabled"
      : "tile proxy disabled (no OS_API_KEY)";
    const startupMessage = `trails listening on http://127.0.0.1:${port} (dataDir: ${dataDir}, ${tileMode})`;
    console.log(startupMessage);
    logger?.info(
      {
        event: "startup",
        port,
        data_dir: dataDir,
        os_tile_proxy: Boolean(config.osApiKey),
        ttl_ms: ttlMs,
      },
      startupMessage,
    );
  });

  // Sweep stale drafts on a schedule. Run one pass at startup, then hourly.
  // `unref()` so the timer never keeps the process alive on its own.
  function runSweep(): void {
    try {
      const removed = sweepDrafts(dataDir, ttlMs);
      if (removed > 0) {
        logger?.info({ event: "draft_sweep", removed }, "swept stale drafts");
      }
    } catch (err) {
      logger?.warn(
        { event: "draft_sweep", err_message: (err as Error).message },
        "draft sweep failed",
      );
    }
  }
  runSweep();
  const sweepTimer = setInterval(runSweep, HOUR_MS);
  sweepTimer.unref();

  // Drain in-flight requests on SIGTERM / SIGINT before exiting, matching
  // src/main.ts so `launchctl kickstart -k` doesn't kill a mid-flight tile
  // fetch or HTML serve.
  closeWithGrace({ delay: 10_000 }, async ({ signal, err }) => {
    if (err) {
      logger?.error({ event: "shutdown", err: err.message }, "shutting down on error");
    } else {
      logger?.info({ event: "shutdown", signal }, "shutting down");
    }
    clearInterval(sweepTimer);
    await new Promise<void>((resolve, reject) => {
      httpServer.close((closeErr) => (closeErr ? reject(closeErr) : resolve()));
    });
  });
}

main();
