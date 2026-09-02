import {
  CHECK_MAX_WAIT_SECONDS,
  type MetricPoint,
  parseConfig,
  resolveConfig,
} from "@ephor/core";
import { describe, expect, it } from "vitest";
import type { Task } from "../../scheduling/scheduler.js";
import { postCheck } from "../handlers.js";
import { depsOf, NOW, schedulerOf, TEST_PROBES } from "./fixtures.js";

/** Two reachable nodes and one with no ssh, so `system` cannot run there. */
const FLEET = {
  nodes: [
    { name: "achilles", host: "203.0.113.10", ssh: "achilles" },
    { name: "antilochus", host: "203.0.113.11", ssh: "antilochus" },
    { name: "german", host: "203.0.113.12" },
  ],
};

const pairOf = (task: Task): string => `${task.node.node.name}/${task.probe}`;

/**
 * A check in progress. The real scheduler picks the pairs; the test says
 * when they finish and whether the cap runs out — by default it never does,
 * so an answer means the run finished. When it does run out, the clock
 * moves by the same amount: time and sleep are one thing.
 */
function checkWorld(configInput: unknown = FLEET) {
  const points: MetricPoint[] = [];
  const nodes = resolveConfig(
    parseConfig(configInput, TEST_PROBES),
    TEST_PROBES,
  );
  const { scheduler, dispatched } = schedulerOf(nodes);
  const sleeps: number[] = [];
  const clock = { now: NOW };
  const cap = {
    runsOut: false,
    budgetMs: 60_000,
    signal: undefined as AbortSignal | undefined,
  };

  const deps = depsOf(points, {
    nodes,
    now: () => clock.now,
    forceRun: (node, probe) => ({
      ...scheduler.runNow(node, probe),
      budgetMs: cap.budgetMs,
    }),
    sleep: (ms, signal): Promise<void> => {
      sleeps.push(ms);
      cap.signal = signal;

      if (!cap.runsOut) {
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        });
      }

      clock.now += ms / 1000;

      return Promise.resolve();
    },
  });

  return { points, nodes, scheduler, dispatched, sleeps, clock, cap, deps };
}

/**
 * What a finished run leaves behind: `<probe>.up` for every dispatched
 * pair, then the completion the executor would report.
 */
function finish(
  world: ReturnType<typeof checkWorld>,
  outcome: { ok?: boolean } = {},
): void {
  for (const task of world.dispatched) {
    world.points.push({
      ts: world.clock.now,
      node: task.node.node.name,
      metric: `${task.probe}.up`,
      ok: outcome.ok ?? true,
    });
    world.scheduler.complete(task);
  }
}

describe("postCheck", () => {
  it("is undefined for a node that is not configured, and forces nothing", async () => {
    const world = checkWorld();

    await expect(
      postCheck(world.deps, { node: "nobody" }),
    ).resolves.toBeUndefined();
    expect(world.dispatched).toEqual([]);
  });

  it("is undefined for a node that is switched off", async () => {
    const world = checkWorld({
      nodes: [{ name: "retired", host: "203.0.113.10", enabled: false }],
    });

    await expect(
      postCheck(world.deps, { node: "retired" }),
    ).resolves.toBeUndefined();
  });

  it("refuses a probe nobody registered, naming the ones that exist", async () => {
    const world = checkWorld();

    await expect(postCheck(world.deps, { probe: "speed" })).rejects.toThrow(
      /unknown probe "speed"\. Available: system, reachability/,
    );
    expect(world.dispatched).toEqual([]);
  });

  // `check german system` on a node without ssh must not come back green
  // and empty: nothing ran, and the answer has to say so and why.
  it("refuses a probe that cannot run on the named node, and says why", async () => {
    const world = checkWorld();

    await expect(
      postCheck(world.deps, { node: "german", probe: "system" }),
    ).rejects.toThrow(
      /system is disabled on german: it needs ssh access and german has none/,
    );
  });

  it("refuses a probe the config switched off on the named node", async () => {
    const world = checkWorld({
      nodes: [
        {
          name: "achilles",
          host: "203.0.113.10",
          ssh: "achilles",
          probes: { system: { enabled: false } },
        },
      ],
    });

    await expect(
      postCheck(world.deps, { node: "achilles", probe: "system" }),
    ).rejects.toThrow(
      /system is disabled on achilles: switched off in the config/,
    );
  });

  it("refuses a node with every probe switched off", async () => {
    const world = checkWorld({
      nodes: [
        {
          name: "achilles",
          host: "203.0.113.10",
          probes: { reachability: { enabled: false } },
        },
      ],
    });

    await expect(postCheck(world.deps, { node: "achilles" })).rejects.toThrow(
      /every probe is disabled on achilles/,
    );
  });

  it("refuses a probe switched off everywhere", async () => {
    const world = checkWorld({
      ...FLEET,
      probes: { reachability: { enabled: false } },
    });

    await expect(
      postCheck(world.deps, { probe: "reachability" }),
    ).rejects.toThrow(/reachability is disabled on every node/);
  });

  it("refuses a config with nothing enabled at all", async () => {
    const world = checkWorld({ ...FLEET, probeDefaults: { enabled: false } });

    await expect(postCheck(world.deps, {})).rejects.toThrow(
      /nothing to check: every probe is disabled on every node/,
    );
  });

  it("forces exactly what was asked", async () => {
    const world = checkWorld();

    const answer = postCheck(world.deps, { node: "achilles", probe: "system" });

    expect(world.dispatched.map(pairOf)).toEqual(["achilles/system"]);

    finish(world);
    await answer;
  });

  it("forces every enabled pair of the fleet when asked for nothing in particular", async () => {
    const world = checkWorld();

    const answer = postCheck(world.deps, {});

    expect(world.dispatched.map(pairOf)).toEqual([
      "achilles/system",
      "achilles/reachability",
      "antilochus/system",
      "antilochus/reachability",
      "german/reachability",
    ]);

    finish(world);
    await answer;
  });

  it("takes startedAt before the run and reads the clock again after it", async () => {
    const world = checkWorld();

    const answer = postCheck(world.deps, { node: "achilles" });
    world.clock.now += 10;
    finish(world);
    const response = await answer;

    expect(response?.startedAt).toBe(NOW);
    expect(response?.now).toBe(NOW + 10);
  });

  it("is complete once every forced pair has finished, with nobody pending", async () => {
    const world = checkWorld();

    const answer = postCheck(world.deps, { node: "achilles" });
    finish(world);
    const response = await answer;

    expect(response).toMatchObject({ complete: true, pending: [] });
  });

  it("is incomplete when the cap runs out first, and names who is still pending", async () => {
    const world = checkWorld();
    world.cap.runsOut = true;

    const response = await postCheck(world.deps, { node: "achilles" });

    expect(response).toMatchObject({ complete: false, pending: ["achilles"] });
    // The wait was time: the answer's clock is that much past its start.
    expect(response?.now).toBe(NOW + (world.sleeps[0] ?? 0) / 1000);
    // The state is still answered: the caller sees what there is so far.
    expect(response?.nodes.map((node) => node.node)).toEqual([
      "achilles",
      "antilochus",
      "german",
    ]);
  });

  // A probe that failed wrote `.up: false` and is done; the answer is bad,
  // not missing, and polling for it would wait forever.
  it("counts a failed probe as finished", async () => {
    const world = checkWorld();

    const answer = postCheck(world.deps, { node: "achilles" });
    finish(world, { ok: false });
    const response = await answer;

    expect(response).toMatchObject({ complete: true, pending: [] });
  });

  it("names as pending the forced pairs still running, and nothing else", async () => {
    const world = checkWorld();
    world.cap.runsOut = true;

    const answer = postCheck(world.deps, {});
    for (const task of world.dispatched) {
      if (task.node.node.name === "achilles") world.scheduler.complete(task);
    }
    const response = await answer;

    expect(response).toMatchObject({
      complete: false,
      pending: ["antilochus", "german"],
    });
  });

  it("keeps a node pending until each of its forced probes is done", async () => {
    const world = checkWorld();
    world.cap.runsOut = true;

    const answer = postCheck(world.deps, { node: "achilles" });
    for (const task of world.dispatched) {
      if (task.probe === "system") world.scheduler.complete(task);
    }
    const response = await answer;

    expect(response).toMatchObject({ complete: false, pending: ["achilles"] });
  });

  it("waits the collector's budget when it fits under the ceiling", async () => {
    const world = checkWorld();
    world.cap.budgetMs = 5_000;

    const answer = postCheck(world.deps, { node: "achilles" });
    finish(world);
    await answer;

    expect(world.sleeps).toEqual([5_000]);
  });

  it("never waits past the ceiling", async () => {
    const world = checkWorld();
    world.cap.budgetMs = 10 * CHECK_MAX_WAIT_SECONDS * 1000;

    const answer = postCheck(world.deps, { node: "achilles" });
    finish(world);
    await answer;

    expect(world.sleeps).toEqual([CHECK_MAX_WAIT_SECONDS * 1000]);
  });

  // The losing side of the race must not keep its timer: a three-second
  // check would otherwise leave a four-minute handle behind.
  it("cancels the cap timer once the run has finished", async () => {
    const world = checkWorld();

    const answer = postCheck(world.deps, { node: "achilles" });
    expect(world.cap.signal?.aborted).toBe(false);

    finish(world);
    await answer;

    expect(world.cap.signal?.aborted).toBe(true);
  });

  // On shutdown the collector aborts every waiting sleep; the check answers
  // with what it has rather than holding `api.close()` for minutes.
  it("gives up at once when its sleep is cut short from outside", async () => {
    const world = checkWorld();
    world.deps.sleep = () => Promise.reject(new Error("shutting down"));

    const response = await postCheck(world.deps, { node: "achilles" });

    expect(response).toMatchObject({ complete: false, pending: ["achilles"] });
  });
});
