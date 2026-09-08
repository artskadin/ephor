import {
  type Config,
  createLogger,
  type Logger,
  type MetricPoint,
  type Probe,
  type ProbeOutcome,
  parseConfig,
  resolveConfig,
} from "@ephorate/core";
import { describe, expect, it } from "vitest";
import {
  NOW,
  schedulerOf,
  storageOf,
  TEST_PROBES,
} from "../api/tests/fixtures.js";
import {
  type CheckDeps,
  type CheckOutcome,
  checkOnce,
  checkWithoutDaemon,
} from "../check.js";
import { ProbeRegistry } from "../probes/registry.js";

/** One node with ssh and one without, so `system` cannot run on the second. */
const FLEET = {
  nodes: [
    { name: "achilles", host: "203.0.113.10", ssh: "achilles" },
    { name: "german", host: "203.0.113.12" },
  ],
};

/**
 * The real scheduler over the fleet, and only what a check needs — no
 * sleep among them, so a wait can come from nowhere but the run itself.
 */
function worldOf() {
  const points: MetricPoint[] = [];
  const nodes = resolveConfig(parseConfig(FLEET, TEST_PROBES), TEST_PROBES);
  const { scheduler, dispatched } = schedulerOf(nodes);

  const deps: CheckDeps = {
    storage: storageOf(points),
    nodes,
    probeNames: TEST_PROBES.map((probe) => probe.name),
    now: () => NOW,
    forceRun: (node, probe) => ({
      ...scheduler.runNow(node, probe),
      budgetMs: 60_000,
    }),
  };

  return { deps, scheduler, dispatched };
}

/** Whether a promise has settled by the next turn of the loop. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  const stillPending = Symbol("pending");
  const nextTurn = new Promise((resolve) =>
    setImmediate(() => resolve(stillPending)),
  );

  return (await Promise.race([promise, nextTurn])) !== stillPending;
}

describe("checkOnce", () => {
  it("tells a node nobody configured from a request it cannot serve", async () => {
    const { deps, dispatched } = worldOf();

    await expect(checkOnce(deps, { node: "nobody" })).resolves.toEqual({
      kind: "unknown-node",
      node: "nobody",
    });
    await expect(checkOnce(deps, { probe: "speed" })).resolves.toEqual({
      kind: "invalid",
      reason: 'unknown probe "speed". Available: system, reachability',
    });
    await expect(
      checkOnce(deps, { node: "german", probe: "system" }),
    ).resolves.toEqual({
      kind: "invalid",
      reason:
        "system is disabled on german: it needs ssh access and german has none",
    });
    expect(dispatched).toEqual([]);
  });

  // No daemon means nobody to hand the rest of the run to: the answer waits
  // for the last forced pair, however long.
  it("without a cap, waits for every forced pair", async () => {
    const { deps, scheduler, dispatched } = worldOf();

    const answer = checkOnce(deps, { node: "achilles" });

    expect(dispatched.map((task) => task.probe)).toEqual([
      "system",
      "reachability",
    ]);
    expect(await settled(answer)).toBe(false);

    const [system, reachability] = dispatched;
    if (!system || !reachability) throw new Error("expected two pairs");

    scheduler.complete(system);
    expect(await settled(answer)).toBe(false);

    scheduler.complete(reachability);
    expect(await settled(answer)).toBe(true);

    await expect(answer).resolves.toMatchObject({
      kind: "ran",
      response: { startedAt: NOW, complete: true, pending: [] },
    });
  });
});

/**
 * Needs no access to the node and counts its runs: the pipeline is the
 * subject, and "once" and "nothing ran" are claims a counter can carry.
 */
function fastProbeOf(outcome: { ok: boolean } = { ok: true }): {
  registry: ProbeRegistry;
  runs: () => number;
} {
  let runs = 0;
  const probe: Probe<Record<string, never>> = {
    descriptor: {
      name: "fast",
      requiresExecutor: false,
      enabledByDefault: true,
      defaults: { interval: 60, timeout: 10, retries: 0, concurrency: 2 },
    },
    run: async (): Promise<ProbeOutcome<Record<string, never>>> => {
      runs += 1;

      return outcome.ok
        ? { ok: true, data: {}, durationMs: 1 }
        : {
            ok: false,
            error: { kind: "unreachable", detail: "no route" },
            durationMs: 1,
          };
    },
    toMetrics: () => [],
  };
  const registry = new ProbeRegistry();
  registry.register(probe);

  return { registry, runs: () => runs };
}

const silent = (): Logger => createLogger({ level: "silent" });

/** Nodes without ssh: `fast` needs none, and it is the only probe there is. */
function configOf(registry: ProbeRegistry, ...names: string[]): Config {
  return parseConfig(
    {
      nodes: names.map((name, index) => ({
        name,
        host: `203.0.113.${10 + index}`,
      })),
    },
    registry.descriptors(),
  );
}

/** The nodes an answer carries this run's `fast.up` for. */
function reportedIn(outcome: CheckOutcome): string[] {
  if (outcome.kind !== "ran") return [];

  return outcome.response.nodes
    .filter((node) => node.metrics.some((view) => view.metric === "fast.up"))
    .map((node) => node.node);
}

describe("checkWithoutDaemon", () => {
  // Three nodes through a limit of two: the third waits for a slot, and the
  // answer waits for the third.
  it("runs every pair once, in memory, and answers in full", async () => {
    const { registry, runs } = fastProbeOf();

    const outcome = await checkWithoutDaemon({
      config: configOf(registry, "pupa", "lupa", "mupa"),
      registry,
      logger: silent(),
      request: {},
    });

    expect(runs()).toBe(3);
    expect(outcome).toMatchObject({
      kind: "ran",
      response: { complete: true, pending: [] },
    });
    // Every node came back with this run's `fast.up`: the probes wrote, and
    // the answer was read after they did.
    expect(reportedIn(outcome)).toEqual(["pupa", "lupa", "mupa"]);
    if (outcome.kind === "ran") {
      expect(outcome.response.now).toBeGreaterThanOrEqual(
        outcome.response.startedAt,
      );
    }
  });

  it("runs only the pair asked for", async () => {
    const { registry, runs } = fastProbeOf();

    const outcome = await checkWithoutDaemon({
      config: configOf(registry, "pupa", "lupa"),
      registry,
      logger: silent(),
      request: { node: "lupa", probe: "fast" },
    });

    expect(runs()).toBe(1);
    expect(reportedIn(outcome)).toEqual(["lupa"]);
  });

  // A failed probe is finished — it wrote `fast.up: false` — so the answer
  // is complete, and it says the node is the worse for it.
  it("counts a failed probe as finished, and the answer says so", async () => {
    const { registry } = fastProbeOf({ ok: false });

    const outcome = await checkWithoutDaemon({
      config: configOf(registry, "pupa"),
      registry,
      logger: silent(),
      request: {},
    });

    expect(outcome).toMatchObject({
      kind: "ran",
      response: {
        complete: true,
        pending: [],
        nodes: [{ node: "pupa", status: "warn" }],
      },
    });
  });

  it("refuses as the API would, without running anything", async () => {
    const { registry, runs } = fastProbeOf();

    await expect(
      checkWithoutDaemon({
        config: configOf(registry, "pupa"),
        registry,
        logger: silent(),
        request: { node: "nobody" },
      }),
    ).resolves.toEqual({ kind: "unknown-node", node: "nobody" });
    expect(runs()).toBe(0);
  });
});
