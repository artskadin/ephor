import { ConfigError, createLogger } from "@ephorate/core";
import { MissingTokenError } from "./api/server.js";
import { serve } from "./serve.js";

// The daemon as `node dist/main.js`, until `ephor serve` takes its place.

async function main(): Promise<void> {
  // Inside main(), so a bad EPHOR_LOG_LEVEL is reported by the handler below.
  const logger = createLogger();

  const daemon = await serve({
    configPath: process.env.EPHOR_CONFIG ?? "/etc/ephor/config.yaml",
    databasePath: process.env.EPHOR_DB,
    token: process.env.EPHOR_TOKEN ?? "",
    logger,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("shutting down", { signal });
    await daemon.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  // Messages for a person, multi-line; not log records.
  if (error instanceof ConfigError || error instanceof MissingTokenError) {
    process.stderr.write(`\n${error.message}\n\n`);
    process.exit(1);
  }

  // An explicit level works even when the failure was the log level itself.
  createLogger({ level: "error" }).error("collector failed to start", {
    cause: error,
  });

  process.exit(1);
});
