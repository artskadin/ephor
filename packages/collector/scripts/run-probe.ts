/**
 * Runs one probe against one node from a config, once, and prints the raw
 * outcome. For checking by hand that a probe still works against the real
 * world — which unit tests, by design, cannot tell you.
 *
 *   pnpm --filter @ephor/collector exec tsx scripts/run-probe.ts \
 *     reachability achilles ../../examples/config.local.yaml
 */
import { createLogger, loadConfig, resolveConfig } from "@ephor/core";
import { createExecutor } from "../src/execution/create-executor.js";
import { SshGates } from "../src/execution/ssh-gates.js";
import { inspectSshOptions } from "../src/execution/ssh-route.js";
import { ReachabilityProbe } from "../src/probes/reachability/reachability-probe.js";
import { ProbeRegistry } from "../src/probes/registry.js";
import { SystemProbe } from "../src/probes/system/system-probe.js";
import { CheckHostProvider } from "../src/reachability/check-host-provider.js";
import { DirectHttpRequester } from "../src/reachability/direct-http-requester.js";

const probeName = process.argv[2] ?? "reachability";
const nodeName = process.argv[3];
const configPath = process.argv[4] ?? "../../examples/config.local.yaml";

const logger = createLogger({ level: "debug" });
const requester = new DirectHttpRequester();

const registry = new ProbeRegistry();

registry.register(new SystemProbe());
registry.register(
  new ReachabilityProbe({
    createProvider: (settings) =>
      new CheckHostProvider({
        regions: settings.regions,
        vantageTtlMs: settings.vantageRefresh * 1000,
      }),
    requesterFor: () => requester,
  }),
);

const config = await loadConfig(configPath, registry.descriptors());
const resolved = resolveConfig(config, registry.descriptors());

const target = nodeName
  ? resolved.find((node) => node.node.name === nodeName)
  : resolved[0];

if (!target) {
  throw new Error(
    `No such node: ${nodeName ?? "(first)"}. Available: ${resolved
      .map((node) => node.node.name)
      .join(", ")}`,
  );
}

const probe = registry.get(probeName);
const settings = target.probes.get(probeName);

if (!probe || !settings) {
  throw new Error(
    `No such probe: ${probeName}. Available: ${registry.names().join(", ")}`,
  );
}

const timeoutMs = settings.timeout * 1000;
const startedAt = Date.now();

logger.info("running probe", {
  probe: probeName,
  node: target.node.name,
  host: target.node.host,
});

const outcome = await probe.run({
  nodeName: target.node.name,
  host: target.node.host,
  domain: target.node.domain,
  ports: target.node.ports,
  executor: createExecutor(
    target.node,
    timeoutMs,
    new SshGates({ inspect: inspectSshOptions, logger }),
  ),
  startedAt: Math.floor(startedAt / 1000),
  timeoutMs,
  settings: settings.settings,
});

console.dir(outcome, { depth: null });
console.log(`\ntook ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
