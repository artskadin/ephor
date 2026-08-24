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
  probeNames: readonly string[],
): ResolvedNode {
  const checks = new Map<string, ResolvedCheck>();

  for (const probe of probeNames) {
    const override = node.checks[probe];

    checks.set(probe, {
      enabled: override?.enabled ?? true,
      interval: override?.interval ?? defaults.interval,
      timeout: override?.timeout ?? defaults.timeout,
      retries: override?.retries ?? defaults.retries,
    });
  }

  return { node, checks };
}

export function resolveConfig(
  config: Config,
  probeNames: readonly string[],
): ResolvedNode[] {
  return config.nodes
    .filter((n) => n.enabled)
    .map((n) => resolveNode(config.defaults, n, probeNames));
}
