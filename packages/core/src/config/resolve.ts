import type { ProbeDescriptor } from "../types/probe-contract";
import {
  BASE_PROBE_KEYS,
  type Config,
  type Node,
  type Threshold,
} from "./schema";

/** `no-executor`: needs commands on the node and has no way in. */
export type ProbeDisabledReason = "no-executor" | "config";

/** How the probe runs on the node: timing, and its own config keys. */
interface ProbeParameters {
  name: string;
  /** Seconds; `null` when the probe runs only when asked for. */
  interval: number | null;
  /** Seconds. */
  timeout: number;
  retries: number;
  /** Its own keys (reachability's `regions`), checked by its shape. */
  settings: Readonly<Record<string, unknown>>;
}

/** Off always says why. */
export type ResolvedProbe =
  | (ProbeParameters & { enabled: true })
  | (ProbeParameters & {
      enabled: false;
      disabledReason: ProbeDisabledReason;
    });

export interface ResolvedNode {
  /** The node's section of config.yaml, as parsed. */
  config: Node;
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

    const parameters: ProbeParameters = {
      name: descriptor.name,
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

    probes.set(
      descriptor.name,
      enabledByConfig && canRun
        ? { ...parameters, enabled: true }
        : {
            ...parameters,
            enabled: false,
            disabledReason: enabledByConfig ? "no-executor" : "config",
          },
    );
  }

  return {
    config: node,
    probes,
    thresholds: resolveThresholds(config, node),
  };
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
