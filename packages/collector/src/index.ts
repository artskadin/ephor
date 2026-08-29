import { ConfigError, loadConfig } from "@ephor/core";
import { Collector } from "./collector.js";
import { ReachabilityProbe } from "./probes/reachability/reachability-probe.js";
import { ProbeRegistry } from "./probes/registry.js";
import { SystemProbe } from "./probes/system/system-probe.js";
import { CheckHostProvider } from "./reachability/check-host-provider.js";
import { resolveDatabasePath } from "./storage/database-path.js";
import { SqliteStorage } from "./storage/sqlite-storage.js";

const CONFIG_PATH = process.env.EPHOR_CONFIG ?? "/etc/ephor/config.yaml";

async function main(): Promise<void> {
  // The registry is built first: the config schema is generated from the
  // registered probes, so which probes exist decides what the config may say.
  const registry = new ProbeRegistry();

  registry.register(new SystemProbe());
  registry.register(
    new ReachabilityProbe(
      (settings) =>
        new CheckHostProvider(settings.regions, settings.vantageRefresh * 1000),
    ),
  );

  const config = await loadConfig(CONFIG_PATH, registry.descriptors());

  const databasePath = resolveDatabasePath({
    fromEnvironment: process.env.EPHOR_DB,
    fromConfig: config.storage.path,
  });

  const storage = new SqliteStorage(databasePath);
  const collector = new Collector({ config, registry, storage });

  await collector.start();

  console.log(
    `ephor collector started: ${config.nodes.length} node(s), ` +
      `probes: ${registry.names().join(", ")}, database: ${databasePath}`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received, shutting down`);
    collector.stop();

    await storage.close();

    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});
