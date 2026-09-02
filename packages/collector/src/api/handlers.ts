import {
  buildNodeState,
  type HealthResponse,
  type ResolvedNode,
  type StateResponse,
  type Storage,
} from "@ephor/core";

/**
 * Everything the answers are built from. Passed in rather than reached for,
 * so a handler can be tested with a fake storage and a frozen clock and no
 * server at all.
 */
export interface ApiDeps {
  storage: Storage;
  /** The nodes actually being watched; disabled ones are already gone. */
  nodes: readonly ResolvedNode[];
  probeNames: readonly string[];
  /** Unix seconds. */
  now: () => number;
  /** Unix seconds, when the collector started. */
  startedAt: number;
  runningTasks: () => number;
}

/**
 * Handlers know nothing about HTTP — no request, no response, no framework.
 * That is what keeps Fastify to a single file: replacing it rewrites the
 * routing, not the answers.
 */

export async function getState(deps: ApiDeps): Promise<StateResponse> {
  const now = deps.now();

  return {
    now,
    nodes: buildNodeState({
      nodes: deps.nodes,
      points: await deps.storage.latest(),
      now,
    }),
  };
}

export function getHealth(deps: ApiDeps): HealthResponse {
  return {
    ok: true,
    // Clamped because a clock stepped backwards — ntp correcting a fresh VPS
    // is the usual cause — would otherwise report a negative uptime.
    uptimeSeconds: Math.max(0, deps.now() - deps.startedAt),
    runningTasks: deps.runningTasks(),
    nodes: deps.nodes.length,
    probes: [...deps.probeNames],
  };
}
