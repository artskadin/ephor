import { ConfigError, createLogger, loadConfig } from "@ephor/core";
import { createApiServer, MissingTokenError } from "./api/server.js";
import { Collector } from "./collector.js";
import { ReachabilityProbe } from "./probes/reachability/reachability-probe.js";
import { ProbeRegistry } from "./probes/registry.js";
import { SystemProbe } from "./probes/system/system-probe.js";
import { CheckHostProvider } from "./reachability/check-host-provider.js";
import { DirectHttpRequester } from "./reachability/direct-http-requester.js";
import { resolveDatabasePath } from "./storage/database-path.js";
import { SqliteStorage } from "./storage/sqlite-storage.js";

const CONFIG_PATH = process.env.EPHOR_CONFIG ?? "/etc/ephor/config.yaml";

async function main(): Promise<void> {
  // Built inside main() so that a bad EPHOR_LOG_LEVEL is reported by the
  // handler below rather than as an unhandled module-evaluation error.
  const logger = createLogger();

  // The registry is built first: the config schema is generated from the
  // registered probes, so which probes exist decides what the config may say.
  const registry = new ProbeRegistry();

  registry.register(new SystemProbe());

  const requester = new DirectHttpRequester();

  registry.register(
    new ReachabilityProbe({
      createProvider: (settings) =>
        new CheckHostProvider({
          regions: settings.regions,
          vantageTtlMs: settings.vantageRefresh * 1000,
        }),
      // Always from the collector for now; `requestFrom: nodes` will make
      // this a choice without the provider noticing.
      requesterFor: () => requester,
    }),
  );

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

  // Built before the collector starts, and deliberately: it throws when the
  // token is missing, and a misconfigured deployment should fail before it
  // has migrated a database, opened ssh connections and called a third-party
  // API — not after. The nodes are resolved by the constructor, so nothing
  // here needs the scheduler to be running yet.
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
          startedAt: Math.floor(Date.now() / 1000),
          runningTasks: () => collector.runningTasks,
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
    collector.stop();

    // Before the storage: a request already in flight would otherwise read
    // from a database that has just been closed under it.
    if (api) await api.close();
    await storage.close();

    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  // Both are messages for the person at the keyboard rather than log records:
  // one says which line of the config is wrong, the other how to make a
  // token. Multi-line prose survives neither JSON nor a log level.
  if (error instanceof ConfigError || error instanceof MissingTokenError) {
    process.stderr.write(`\n${error.message}\n\n`);
    process.exit(1);
  }

  // Explicit level: this path must work even when the failure was the log
  // level itself, and an explicit one never consults the environment.
  createLogger({ level: "error" }).error("collector failed to start", {
    cause: error,
  });

  process.exit(1);
});
