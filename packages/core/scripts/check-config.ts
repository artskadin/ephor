import { ConfigError, loadConfig } from "../src/config/load.js";

const path = process.argv[2] ?? "../../examples/config.yaml";

try {
  const config = await loadConfig(path);

  console.dir(config, { depth: null });
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }

  throw error;
}
