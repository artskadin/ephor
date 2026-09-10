import type { z } from "zod";
import type { Port } from "../config/schema";
import type { MetricPoint } from "./metrics";
import type { ProbeOutcome } from "./probe";

export interface ProbeContext {
  nodeName: string;
  host: string;
  domain?: string | undefined;
  ports: readonly Port[];
  executor?: CommandRunner | undefined;
  startedAt: number;
  timeoutMs: number;
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
  interval: number;
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
}

export interface Probe<TResult = unknown> {
  readonly descriptor: ProbeDescriptor;
  run(context: ProbeContext): Promise<ProbeOutcome<TResult>>;
  toMetrics(result: TResult, context: ProbeContext): MetricPoint[];
}
