import type { ProbeDescriptor } from "../types/probe-contract.js";
import {
  BASE_PROBE_KEYS,
  type Config,
  type Node,
  type Threshold,
} from "./schema.js";

/** `no-executor`: needs commands on the node and has no way in. */
type ProbeDisabledReason = "no-executor" | "config";

export interface ResolvedProbe {
  name: string;
  enabled: boolean;
  disabledReason?: ProbeDisabledReason | undefined;
  /** Seconds. */
  interval: number;
  /** Seconds. */
  timeout: number;
  retries: number;
  /** Validated by the probe's own shape. */
  settings: Readonly<Record<string, unknown>>;
}

export interface ResolvedNode {
  node: Node;
  probes: ReadonlyMap<string, ResolvedProbe>;
  /** By metric id, the node's own entries over the global ones. */
  thresholds: ReadonlyMap<string, Threshold>;
}

/** Narrowest wins: node, probe section, shared defaults, the probe's own. */
export function resolveNode(
  config: Config,
  node: Node,
  descriptors: readonly ProbeDescriptor[],
): ResolvedNode {
  const probes = new Map<string, ResolvedProbe>();
  const hasExecutor = node.local || node.ssh !== undefined;
  const sharedDefaults = config.probeDefaults;

  for (const descriptor of descriptors) {
    const globalSection = config.probes[descriptor.name];
    const nodeSection = node.probes[descriptor.name];

    const enabledByConfig =
      nodeSection?.enabled ??
      globalSection?.enabled ??
      sharedDefaults.enabled ??
      descriptor.enabledByDefault;
    const canRun = !descriptor.requiresExecutor || hasExecutor;

    const resolved: ResolvedProbe = {
      name: descriptor.name,
      enabled: enabledByConfig && canRun,
      // No shared layer for `interval`: `probeDefaults` refuses it.
      interval:
        nodeSection?.interval ??
        globalSection?.interval ??
        descriptor.defaults.interval,
      timeout:
        nodeSection?.timeout ??
        globalSection?.timeout ??
        sharedDefaults.timeout ??
        descriptor.defaults.timeout,
      retries:
        nodeSection?.retries ??
        globalSection?.retries ??
        sharedDefaults.retries ??
        descriptor.defaults.retries,
      settings: probeSpecificSettings(globalSection),
    };

    if (!resolved.enabled) {
      resolved.disabledReason = enabledByConfig ? "no-executor" : "config";
    }

    probes.set(descriptor.name, resolved);
  }

  return { node, probes, thresholds: resolveThresholds(config, node) };
}

// A node's entry replaces the global one whole: merging `{ warn: 90 }` into
// `{ warn: 60, critical: 80 }` would put warn above critical.
function resolveThresholds(
  config: Config,
  node: Node,
): ReadonlyMap<string, Threshold> {
  const merged = { ...config.thresholds, ...node.thresholds };
  const resolved = new Map<string, Threshold>();

  for (const [metric, threshold] of Object.entries(merged)) {
    if (threshold === null) continue;
    resolved.set(metric, threshold);
  }

  return resolved;
}

export function resolveConfig(
  config: Config,
  descriptors: readonly ProbeDescriptor[],
): ResolvedNode[] {
  return config.nodes
    .filter((node) => node.enabled)
    .map((node) => resolveNode(config, node, descriptors));
}

/** Per probe, not per node: it caps a resource every node shares. */
export function resolveConcurrency(
  config: Config,
  descriptors: readonly ProbeDescriptor[],
): ReadonlyMap<string, number> {
  return new Map(
    descriptors.map((descriptor) => [
      descriptor.name,
      config.probes[descriptor.name]?.concurrency ??
        descriptor.defaults.concurrency,
    ]),
  );
}

function probeSpecificSettings(
  section: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  if (!section) return {};

  const settings: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(section)) {
    if (BASE_PROBE_KEYS.includes(key)) continue;
    settings[key] = value;
  }

  return settings;
}
