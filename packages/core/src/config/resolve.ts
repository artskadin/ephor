import type { ProbeDescriptor } from "../types/probe-contract.js";
import { BASE_PROBE_KEYS, type Config, type Node } from "./schema.js";

/** Why a probe will not run, when the user did not switch it off. */
export type ProbeDisabledReason =
  /** The probe needs to run commands on the node, and none is reachable. */
  | "no-executor"
  /** Switched off in the config, globally or on this node. */
  | "config";

export interface ResolvedProbe {
  name: string;
  enabled: boolean;
  disabledReason?: ProbeDisabledReason | undefined;
  /** Seconds between runs. */
  interval: number;
  /** Seconds a single run may take. */
  timeout: number;
  retries: number;
  /** Probe-specific settings, already validated by the probe's own shape. */
  settings: Readonly<Record<string, unknown>>;
}

export interface ResolvedNode {
  node: Node;
  probes: ReadonlyMap<string, ResolvedProbe>;
}

/**
 * Collapses the three layers — the probe's own defaults, the global
 * `probes:` section, the node's `probes:` section — into one value per
 * setting, so nothing downstream has to know that inheritance exists.
 */
export function resolveNode(
  config: Config,
  node: Node,
  descriptors: readonly ProbeDescriptor[],
): ResolvedNode {
  const probes = new Map<string, ResolvedProbe>();
  const hasExecutor = node.local || node.ssh !== undefined;

  // Narrowest layer wins: node, then this probe's section, then the settings
  // shared by all probes, then what the probe itself declares in code.
  const shared = config.probeDefaults;

  for (const descriptor of descriptors) {
    const global = config.probes[descriptor.name];
    const local = node.probes[descriptor.name];

    const wanted =
      local?.enabled ??
      global?.enabled ??
      shared.enabled ??
      descriptor.enabledByDefault;
    const runnable = !descriptor.requiresExecutor || hasExecutor;

    const resolved: ResolvedProbe = {
      name: descriptor.name,
      enabled: wanted && runnable,
      // `interval` has no shared layer: see ProbeDefaultsSchema.
      interval:
        local?.interval ?? global?.interval ?? descriptor.defaults.interval,
      timeout:
        local?.timeout ??
        global?.timeout ??
        shared.timeout ??
        descriptor.defaults.timeout,
      retries:
        local?.retries ??
        global?.retries ??
        shared.retries ??
        descriptor.defaults.retries,
      settings: extractSettings(global),
    };

    if (!resolved.enabled) {
      resolved.disabledReason = wanted ? "no-executor" : "config";
    }

    probes.set(descriptor.name, resolved);
  }

  return { node, probes };
}

export function resolveConfig(
  config: Config,
  descriptors: readonly ProbeDescriptor[],
): ResolvedNode[] {
  return config.nodes
    .filter((node) => node.enabled)
    .map((node) => resolveNode(config, node, descriptors));
}

/**
 * Concurrency is resolved per probe rather than per node: it caps a resource
 * shared by every node — ssh processes on the collector host, a third-party
 * API, the bandwidth bill.
 */
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

/** Everything in a probe's section that is not one of the shared keys. */
function extractSettings(
  global: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  if (!global) return {};

  const settings: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(global)) {
    if (BASE_PROBE_KEYS.includes(key)) continue;
    settings[key] = value;
  }

  return settings;
}
