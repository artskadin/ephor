import type { QueueState } from "@ephorate/core";
import { longestRunMs } from "../probes/with-retry";
import type { ForcedRun, Task } from "./scheduler";

// Per probe, the slowest run its settings allow times the waves its queue
// needs; the slowest probe wins. An estimate that does not see the ssh
// limits below the probes; the caller's cap and `pending` cover that.
export function waitBudgetMs(
  run: ForcedRun,
  queueState: (probe: string) => QueueState,
): number {
  const longestByProbe = new Map<string, number>();
  const forcedByProbe = new Map<string, number>();

  for (const task of run.tasks) {
    longestByProbe.set(
      task.probe,
      Math.max(longestByProbe.get(task.probe) ?? 0, slowestRunMs(task)),
    );
    forcedByProbe.set(task.probe, (forcedByProbe.get(task.probe) ?? 0) + 1);
  }

  let budget = 0;

  for (const [probe, runMs] of longestByProbe) {
    const queue = queueState(probe);
    // The forced pairs are already in the queue; the count is a floor.
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

function slowestRunMs(task: Task): number {
  const settings = task.node.probes.get(task.probe);

  if (!settings) {
    throw new Error(
      `probe "${task.probe}" is not resolved for node "${task.node.node.name}"`,
    );
  }

  return longestRunMs(settings.timeout * 1000, settings.retries);
}
