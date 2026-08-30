import { createLogger, loadConfig, resolveConfig } from "@ephor/core";
import { ReachabilityProbe } from "../src/probes/reachability/reachability-probe.js";
import { ProbeRegistry } from "../src/probes/registry.js";
import { SystemProbe } from "../src/probes/system/system-probe.js";
import { CheckHostProvider } from "../src/reachability/check-host-provider.js";

const logger = createLogger({ level: "debug", isTerminal: true });

const registry = new ProbeRegistry();
registry.register(new SystemProbe());
registry.register(
  new ReachabilityProbe(
    (settings) =>
      new CheckHostProvider(settings.regions, settings.vantageRefresh * 1000),
  ),
);

const config = await loadConfig(
  process.argv[2] ?? "../../examples/config.local.yaml",
  registry.descriptors(),
);

const [node] = resolveConfig(config, registry.descriptors());
if (!node) throw new Error("no nodes");

const settings = node.probes.get("reachability");
if (!settings) throw new Error("no reachability settings");

const probe = registry.get("reachability");
if (!probe) throw new Error("no reachability probe");

logger.info("running reachability", {
  node: node.node.name,
  host: node.node.host,
  regions: Object.keys(settings.settings.regions as object),
});

const startedAt = Date.now();

const outcome = await probe.run({
  nodeName: node.node.name,
  host: node.node.host,
  domain: node.node.domain,
  ports: node.node.ports,
  startedAt: Math.floor(startedAt / 1000),
  timeoutMs: settings.timeout * 1000,
  settings: settings.settings,
});

console.dir(outcome, { depth: null });
console.log(`\nзаняло ${((Date.now() - startedAt) / 1000).toFixed(1)} с`);
