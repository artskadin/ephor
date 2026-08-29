import { ConfigError, loadConfig } from "@ephor/core";
import { ReachabilityProbe } from "../src/probes/reachability/reachability-probe.js";
import { ProbeRegistry } from "../src/probes/registry.js";
import { SystemProbe } from "../src/probes/system/system-probe.js";
import { CheckHostProvider } from "../src/reachability/check-host-provider.js";

const path = process.argv[2] ?? "../../examples/config.example.yaml";

const registry = new ProbeRegistry();

registry.register(new SystemProbe());
registry.register(
  new ReachabilityProbe(
    (settings) =>
      new CheckHostProvider(settings.regions, settings.vantageRefresh * 1000),
  ),
);

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
