import { ConfigError, loadConfig } from "@ephor/core";
import { ProbeRegistry } from "./probes/registry.js";
import { SystemProbe } from "./probes/system/system-probe.js";
import { Collector } from "./collector.js";
import { SqliteStorage } from "./storage/sqlite-storage.js";

const CONFIG_PATH = process.env["EPHOR_CONFIG"] ?? "/etc/ephor/config.yaml";
const DB_PATH = process.env["EPHOR_DB"] ?? "/data/metrics.db";

async function main(): Promise<void> {
  const config = await loadConfig(CONFIG_PATH);

  const registry = new ProbeRegistry();
  registry.register(new SystemProbe());

  const storage = new SqliteStorage(DB_PATH);
  const collector = new Collector({ config, registry, storage });

  await collector.start();

  console.log(
    `ephor collector started: ${config.nodes.length} node(s), ` +
      `probes: ${registry.names().join(", ")}`,
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
