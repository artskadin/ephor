import type { CheckRequest } from "@ephorate/core";
import { UsageError } from "./exit-code";

// The registry's names, for --help: asking the registry loads the
// collector, 60 ms on every command. A test holds the two equal; the
// collector checks the names given, so a stale copy misleads only --help.
export const PROBE_NAMES: readonly string[] = ["system", "reachability"];

/** `--probe system,speed` and `--probe system --probe speed` alike. */
export function collectProbeNames(
  value: string,
  previous: readonly string[] = [],
): string[] {
  return [...previous, ...value.split(",").map((name) => name.trim())];
}

/** One name goes as `probe`: an older serve knows only that field. */
export function checkRequestFrom(
  node: string | undefined,
  flags: { probe?: readonly string[]; skip?: readonly string[] },
): CheckRequest {
  const probes = namesOf("--probe", flags.probe);
  const skip = namesOf("--skip", flags.skip);
  const request: CheckRequest = {};
  if (node !== undefined) request.node = node;

  if (probes !== undefined && skip !== undefined) {
    throw new UsageError("--probe and --skip together: give one of them");
  }
  const [only, ...more] = probes ?? [];
  if (only !== undefined && more.length === 0) request.probe = only;
  else if (probes !== undefined) request.probes = probes;
  if (skip !== undefined) request.skip = skip;

  return request;
}

function namesOf(
  flag: string,
  given: readonly string[] | undefined,
): string[] | undefined {
  if (given === undefined) return undefined;

  if (given.some((name) => name === "")) {
    throw new UsageError(
      `${flag} takes probe names, separated by commas: ${flag} ${PROBE_NAMES.join(",")}`,
    );
  }

  return [...new Set(given)];
}
