/**
 * Runs one probe against one node from a config, once, and prints the raw
 * outcome. For checking by hand that a probe still works against the real
 * world — which unit tests, by design, cannot tell you.
 *
 *   pnpm --filter @ephorate/collector exec tsx scripts/run-probe.ts \
 *     reachability achilles ../../examples/config.local.yaml
 */
import { createLogger, loadConfig, resolveConfig } from "@ephorate/core";
import { createExecutor } from "../src/execution/create-executor";
import { SshGates } from "../src/execution/ssh-gates";
import { inspectSshOptions } from "../src/execution/ssh-route";
import { createRegistry } from "../src/probes/create-registry";

const probeName = process.argv[2] ?? "reachability";
const nodeName = process.argv[3];
const configPath = process.argv[4] ?? "../../examples/config.local.yaml";

const logger = createLogger({ level: "debug" });
const registry = createRegistry();

const config = await loadConfig(configPath, registry.descriptors());
const resolved = resolveConfig(config, registry.descriptors());

const target = nodeName
  ? resolved.find((node) => node.config.name === nodeName)
  : resolved[0];

if (!target) {
  throw new Error(
    `No such node: ${nodeName ?? "(first)"}. Available: ${resolved
      .map((node) => node.config.name)
      .join(", ")}`,
  );
}

const probe = registry.get(probeName);
const resolvedProbe = target.probes.get(probeName);

if (!probe || !resolvedProbe) {
  throw new Error(
    `No such probe: ${probeName}. Available: ${registry.names().join(", ")}`,
  );
}

const timeoutMs = resolvedProbe.timeout * 1000;
const startedAt = Date.now();

logger.info("running probe", {
  probe: probeName,
  node: target.config.name,
  host: target.config.host,
});

const outcome = await probe.run({
  nodeName: target.config.name,
  host: target.config.host,
  domain: target.config.domain,
  ports: target.config.ports,
  bandwidth: target.config.bandwidth,
  executor: createExecutor(
    target.config,
    timeoutMs,
    new SshGates({ inspect: inspectSshOptions, logger }),
  ),
  startedAt: Math.floor(startedAt / 1000),
  timeoutMs,
  intervalSeconds: resolvedProbe.interval,
  settings: resolvedProbe.settings,
});

console.dir(outcome, { depth: null });
console.log(`\ntook ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
