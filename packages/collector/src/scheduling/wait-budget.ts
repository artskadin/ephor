import type { QueueState } from "@ephorate/core";
import { longestRunMs } from "../probes/with-retry";
import type { ForcedRun, Task } from "./scheduler";

// Per probe, the slowest run its timeout and retries allow times the waves
// its queue needs; the slowest probe wins. An estimate that does not see the ssh
// limits below the probes; the caller's cap and `pending` cover that.
export function waitBudgetMs(
  run: ForcedRun,
  queueState: (probeName: string) => QueueState,
): number {
  const slowestRunMsByProbe = new Map<string, number>();
  const forcedCountByProbe = new Map<string, number>();

  for (const task of run.tasks) {
    slowestRunMsByProbe.set(
      task.probeName,
      Math.max(
        slowestRunMsByProbe.get(task.probeName) ?? 0,
        slowestRunMs(task),
      ),
    );
    forcedCountByProbe.set(
      task.probeName,
      (forcedCountByProbe.get(task.probeName) ?? 0) + 1,
    );
  }

  let budget = 0;

  for (const [probeName, runMs] of slowestRunMsByProbe) {
    const queue = queueState(probeName);
    // The forced pairs are already in the queue; the count is a floor.
    const inLine = Math.max(
      queue.active + queue.queued,
      forcedCountByProbe.get(probeName) ?? 0,
    );
    const waves =
      Math.ceil(inLine / queue.limit) +
      (run.deferredProbes.has(probeName) ? 1 : 0);

    budget = Math.max(budget, waves * runMs);
  }

  return budget;
}

function slowestRunMs(task: Task): number {
  const resolvedProbe = task.node.probes.get(task.probeName);

  if (!resolvedProbe) {
    throw new Error(
      `probe "${task.probeName}" is not resolved for node "${task.node.config.name}"`,
    );
  }

  return longestRunMs(resolvedProbe.timeout * 1000, resolvedProbe.retries);
}
