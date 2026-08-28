import type { ProbeDescriptor } from "../types/probe-contract.js";
import type { Config, Node, Defaults } from "./schema.js";

export interface ResolvedCheck {
  enabled: boolean;
  interval: number;
  timeout: number;
  retries: number;
}

export interface ResolvedNode {
  node: Node;
  checks: ReadonlyMap<string, ResolvedCheck>;
}

export function resolveNode(
  defaults: Defaults,
  node: Node,
  probes: readonly ProbeDescriptor[],
): ResolvedNode {
  const checks = new Map<string, ResolvedCheck>();
  const hasExecutor = node.local || node.ssh !== undefined;

  for (const probe of probes) {
    const override = node.checks[probe.name];

    const enabled =
      (override?.enabled ?? true) && (!probe.requiresExecutor || hasExecutor);

    checks.set(probe.name, {
      enabled,
      interval: override?.interval ?? defaults.interval,
      timeout: override?.timeout ?? defaults.timeout,
      retries: override?.retries ?? defaults.retries,
    });
  }

  return { node, checks };
}

export function resolveConfig(
  config: Config,
  probes: readonly ProbeDescriptor[],
): ResolvedNode[] {
  return config.nodes
    .filter((n) => n.enabled)
    .map((n) => resolveNode(config.defaults, n, probes));
}
