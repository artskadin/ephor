import type { ProbeDescriptor } from "../types/probe-contract.js";
import {
  BASE_PROBE_KEYS,
  type Config,
  type Node,
  type Threshold,
} from "./schema.js";

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
  /** By metric id, the global section already overlaid by the node's own. */
  thresholds: ReadonlyMap<string, Threshold>;
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

  return { node, probes, thresholds: resolveThresholds(config, node) };
}

/**
 * Per metric, the node's entry replaces the global one outright rather than
 * merging field by field. `{ warn: 60, critical: 80 }` overridden by
 * `{ warn: 90 }` would otherwise leave `critical: 80` behind and produce a
 * warn above the critical — a shape the schema refuses when written by hand,
 * and one nobody would expect inheritance to invent.
 */
function resolveThresholds(
  config: Config,
  node: Node,
): ReadonlyMap<string, Threshold> {
  const merged = { ...config.thresholds, ...node.thresholds };
  const resolved = new Map<string, Threshold>();

  for (const [metric, threshold] of Object.entries(merged)) {
    // `null` is the node saying "watch this one everywhere but here".
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

/**
 * Concurrency is resolved per probe rather than per node: it caps a resource
 * shared by every node — a third-party API, the bandwidth bill. What ssh
 * itself can bear is bounded below the probes, in the collector's
 * `SshGates`, for every ssh probe at once.
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
