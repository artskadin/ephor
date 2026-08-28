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
}

export interface CommandRunner {
  run(
    script: string,
    options?: { timeoutMs?: number | undefined },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface Probe<TResult = unknown> {
  readonly name: string;
  readonly requiresExecutor: boolean;

  run(context: ProbeContext): Promise<ProbeOutcome<TResult>>;
  toMetrics(result: TResult, context: ProbeContext): MetricPoint[];
}

export interface ProbeDescriptor {
  name: string;
  requiresExecutor: boolean;
}
