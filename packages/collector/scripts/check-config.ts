import { ConfigError, loadConfig } from "@ephorate/core";
import { createRegistry } from "../src/probes/create-registry.js";

const path = process.argv[2] ?? "../../examples/config.example.yaml";

// The daemon's own registry, so this validates exactly what `serve` accepts.
const registry = createRegistry();

try {
  const config = await loadConfig(path, registry.descriptors());

  console.dir(config, { depth: null });
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }

  throw error;
}
