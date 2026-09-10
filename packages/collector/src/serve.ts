import { type Logger, loadConfig } from "@ephorate/core";
import type { FastifyInstance } from "fastify";
import { createApiServer } from "./api/server";
import { Collector } from "./collector";
import { createRegistry } from "./probes/create-registry";
import { sleep } from "./scheduling/clock";
import { resolveDatabasePath } from "./storage/database-path";
import { SqliteStorage } from "./storage/sqlite-storage";

interface ServeOptions {
  configPath: string;
  /** Wins over `storage.path`; `EPHOR_DB` for the daemon. */
  databasePath?: string | undefined;
  /** Refused empty while the API is enabled. */
  token: string;
  logger: Logger;
}

export interface Daemon {
  /** Where the API listens; `undefined` under `api.enabled: false`. */
  apiUrl: string | undefined;
  stop(): Promise<void>;
}

/**
 * The daemon without a process around it: no environment, no signals, no
 * exit. Throws `ConfigError` and `MissingTokenError` with nothing left open.
 */
export async function serve(options: ServeOptions): Promise<Daemon> {
  const { logger } = options;

  // The config schema is generated from the registered probes.
  const registry = createRegistry();
  const config = await loadConfig(options.configPath, registry.descriptors());

  const databasePath = resolveDatabasePath({
    fromEnvironment: options.databasePath,
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
  let api: FastifyInstance | undefined;
  let stopped: Promise<void> | undefined;

  // Once: a second signal during shutdown would close the database twice,
  // and `DatabaseSync.close()` throws on a closed handle.
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      stopping.abort();
      collector.stop();

      // Before the storage, or a request in flight reads a closed database.
      if (api) await api.close();
      await storage.close();
    })();

    return stopped;
  };

  try {
    // Before the collector starts: a missing token must fail before the
    // first migration or probe run.
    if (config.api.enabled) {
      api = createApiServer({
        settings: config.api,
        token: options.token,
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
      });
    }

    await collector.start();

    logger.info("collector started", {
      nodes: config.nodes.length,
      probes: registry.names(),
      database: databasePath,
    });

    let apiUrl: string | undefined;

    if (api) {
      apiUrl = await api.listen({
        host: config.api.bind,
        port: config.api.port,
      });
      logger.info("API listening", {
        bind: config.api.bind,
        port: config.api.port,
      });
    }

    return { apiUrl, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
