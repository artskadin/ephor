import type { z } from "zod";
import type { Bandwidth, Node, Port } from "../config/schema";
import type { MetricPoint } from "./metrics";
import type { ProbeOutcome } from "./probe";

export interface ProbeContext {
  nodeName: string;
  host: string;
  domain?: string | undefined;
  ports: readonly Port[];
  /** The hoster's promise, when the config gives one. */
  bandwidth?: Bandwidth | undefined;
  executor?: CommandRunner | undefined;
  /** Every point of a run carries it: older ones read as dropped metrics. */
  startedAt: number;
  timeoutMs: number;
  /** Its schedule on this node; `null` when it runs only when asked for. */
  intervalSeconds: number | null;
  /** Already validated against the probe's own `settings` shape. */
  settings: Readonly<Record<string, unknown>>;
}

interface CommandRunner {
  run(
    script: string,
    options?: { timeoutMs?: number | undefined },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** Used when neither the config nor the node overrides them; seconds. */
interface ProbeDefaults {
  /** `null`: runs only when asked for, until the config sets an interval. */
  interval: number | null;
  timeout: number;
  retries: number;
  /** A backstop for forced runs, not a throttle; ssh has its own limits. */
  concurrency: number;
}

/** What the config layer knows about a probe without importing it. */
export interface ProbeDescriptor {
  readonly name: string;
  readonly requiresExecutor: boolean;
  /** Probes that cost bandwidth or money ship disabled. */
  readonly enabledByDefault: boolean;
  readonly defaults: ProbeDefaults;
  /** Extra keys accepted under `probes.<name>`; the schema stays strict. */
  readonly settings?: z.ZodRawShape | undefined;
  /**
   * Every metric id a run may write for this node with these settings,
   * `<probe>.up` aside. A stored one not listed is a leftover of an older
   * config and is not shown.
   */
  readonly listMetrics: (
    node: Node,
    settings: Readonly<Record<string, unknown>>,
  ) => readonly string[];
  /**
   * Every metric id the probe can write on any node with these settings,
   * `<probe>.up` aside: what a threshold may name. A threshold on a metric
   * no node writes now (no `bandwidth` anywhere) is no typo.
   */
  readonly listAllMetrics: (
    settings: Readonly<Record<string, unknown>>,
  ) => readonly string[];
}

export interface Probe<TResult = unknown> {
  readonly descriptor: ProbeDescriptor;
  run(context: ProbeContext): Promise<ProbeOutcome<TResult>>;
  toMetrics(result: TResult, context: ProbeContext): MetricPoint[];
}
