import { ConfigError, createLogger, loadConfig } from "@ephorate/core";
import { createApiServer, MissingTokenError } from "./api/server.js";
import { Collector } from "./collector.js";
import { createRegistry } from "./probes/create-registry.js";
import { sleep } from "./scheduling/clock.js";
import { resolveDatabasePath } from "./storage/database-path.js";
import { SqliteStorage } from "./storage/sqlite-storage.js";

const CONFIG_PATH = process.env.EPHOR_CONFIG ?? "/etc/ephor/config.yaml";

async function main(): Promise<void> {
  // Inside main(), so a bad EPHOR_LOG_LEVEL is reported by the handler below.
  const logger = createLogger();

  // The config schema is generated from the registered probes.
  const registry = createRegistry();

  const config = await loadConfig(CONFIG_PATH, registry.descriptors());

  const databasePath = resolveDatabasePath({
    fromEnvironment: process.env.EPHOR_DB,
    fromConfig: config.storage.path,
  });

  const storage = new SqliteStorage(
    databasePath,
    logger.child({ database: databasePath }),
  );
  const collector = new Collector({ config, registry, storage, logger });

  // Cuts short any `/api/check` still waiting on shutdown: `api.close()`
  // waits for requests in flight, and systemd does not wait four minutes.
  const stopping = new AbortController();

  // Before the collector starts: a missing token must fail before anything
  // is touched.
  const api = config.api.enabled
    ? createApiServer({
        settings: config.api,
        token: process.env.EPHOR_TOKEN ?? "",
        logger: logger.child({ component: "api" }),
        deps: {
          storage,
          nodes: collector.nodes,
          probeNames: registry.names(),
          now: () => Math.floor(Date.now() / 1000),
          sleep: (ms, signal) =>
            sleep(ms, AbortSignal.any([signal, stopping.signal])),
          startedAt: Math.floor(Date.now() / 1000),
          runningTasks: () => collector.runningTasks,
          queues: () => collector.queues(),
          sshQueues: () => collector.sshQueues(),
          forceRun: (node, probe) => collector.runNow(node, probe),
        },
      })
    : undefined;

  await collector.start();

  logger.info("collector started", {
    nodes: config.nodes.length,
    probes: registry.names(),
    database: databasePath,
  });

  if (api) {
    await api.listen({ host: config.api.bind, port: config.api.port });
    logger.info("API listening", {
      bind: config.api.bind,
      port: config.api.port,
    });
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("shutting down", { signal });
    stopping.abort();
    collector.stop();

    // Before the storage, or a request in flight reads a closed database.
    if (api) await api.close();
    await storage.close();

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
