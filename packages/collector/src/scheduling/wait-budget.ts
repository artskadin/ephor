import { longestRunMs } from "../probes/with-retry.js";
import type { ForcedRun, Task } from "./scheduler.js";
import type { QueueState } from "./task-executor.js";

/**
 * How long a forced run can take under the queues as they stand — what a
 * caller waiting on `finished` must be prepared for, from the config rather
 * than a guess.
 *
 * Per probe: the slowest run its settings allow — every attempt using its
 * whole timeout, with the pauses between — times the waves its queue needs
 * to get through. The probes run side by side under separate limits, so the
 * slowest probe sets the budget, not the sum.
 *
 * The queue is read after forcing, so the forced pairs are already among the
 * active and queued; the forced count is a floor in case reading and
 * dispatch ever come apart. A pair that was mid-run when forced is not in
 * the queue yet: it joins when its current run ends, and that is one wave
 * more.
 *
 * An estimate from one reading, not a bound: pairs that finish early come
 * due again and join the same queue while the rest are still waiting, and
 * the ssh layer below the probes has limits of its own (`SshGates`: 8 per
 * sshd, 50 in all) that this does not see — behind one jump host a run is
 * held far longer than the probe queue suggests. That is what the caller's
 * cap and `pending` are for.
 */
export function waitBudgetMs(
  run: ForcedRun,
  queueOf: (probe: string) => QueueState,
): number {
  const longestByProbe = new Map<string, number>();
  const forcedByProbe = new Map<string, number>();

  for (const task of run.tasks) {
    longestByProbe.set(
      task.probe,
      Math.max(longestByProbe.get(task.probe) ?? 0, longestRunOf(task)),
    );
    forcedByProbe.set(task.probe, (forcedByProbe.get(task.probe) ?? 0) + 1);
  }

  let budget = 0;

  for (const [probe, runMs] of longestByProbe) {
    const queue = queueOf(probe);
    const inLine = Math.max(
      queue.active + queue.queued,
      forcedByProbe.get(probe) ?? 0,
    );
    const waves =
      Math.ceil(inLine / queue.limit) + (run.deferredProbes.has(probe) ? 1 : 0);

    budget = Math.max(budget, waves * runMs);
  }

  return budget;
}

function longestRunOf(task: Task): number {
  const settings = task.node.probes.get(task.probe);

  // The scheduler builds tasks from this very map, so a miss is a bug in
  // the caller rather than a case to budget some default for.
  if (!settings) {
    throw new Error(
      `probe "${task.probe}" is not resolved for node "${task.node.node.name}"`,
    );
  }

  return longestRunMs(settings.timeout * 1000, settings.retries);
}
