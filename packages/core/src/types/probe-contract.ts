import type { z } from "zod";
import type { Port } from "../config/schema.js";
import type { MetricPoint } from "./metrics.js";
import type { ProbeOutcome } from "./probe.js";

export interface ProbeContext {
  nodeName: string;
  host: string;
  domain?: string | undefined;
  ports: readonly Port[];
  executor?: CommandRunner | undefined;
  startedAt: number;
  timeoutMs: number;
  /**
   * Probe-specific configuration, already validated against the
   * probe's own `settings` shape.
   */
  settings: Readonly<Record<string, unknown>>;
}

export interface CommandRunner {
  run(
    script: string,
    options?: { timeoutMs?: number | undefined },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** Values used when neither the config nor the node overrides them. */
export interface ProbeDefaults {
  /** Seconds between runs. */
  interval: number;
  /** Seconds a single run may take. */
  timeout: number;
  /** Extra attempts after a transient failure. */
  retries: number;
  /**
   * How many runs of this probe may be in flight at once.
   *
   * A safety valve, not a throughput knob: with the scheduler's
   * jitter, tasks arrive spread over the interval and the limit is
   * rarely reached. It exists to cap the damage when everything is
   * forced at once — and each probe is capped by a different
   * resource, which is why there is no single global number.
   */
  concurrency: number;
}

/**
 * Everything the configuration layer needs to know about a probe
 * without importing it. This is what keeps `core` free of concrete
 * probe implementations while still validating their settings.
 */
export interface ProbeDescriptor {
  readonly name: string;
  /** True when the probe needs to run commands on the node itself. */
  readonly requiresExecutor: boolean;
  /**
   * Probes that cost the user real bandwidth or money ship disabled,
   * so an unread config never runs up a bill.
   */
  readonly enabledByDefault: boolean;
  readonly defaults: ProbeDefaults;
  /**
   * Extra configuration keys this probe accepts under
   * `probes.<name>`, as a Zod shape so the generated schema can stay
   * `.strict()` and still reject typos in probe-specific options.
   */
  readonly settings?: z.ZodRawShape | undefined;
}

export interface Probe<TResult = unknown> {
  readonly descriptor: ProbeDescriptor;

  run(context: ProbeContext): Promise<ProbeOutcome<TResult>>;
  toMetrics(result: TResult, context: ProbeContext): MetricPoint[];
}
