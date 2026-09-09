import type { LogFields, Logger, QueueState, SshQueues } from "@ephorate/core";
import { BacklogDetector } from "../scheduling/backlog-detector.js";
import { ConcurrencyLimiter } from "../scheduling/concurrency-limiter.js";
import {
  resolveSshRoute,
  type SshInspector,
  type SshRoute,
} from "./ssh-route.js";

// Ssh processes on the collector host at once: ~4 MB and three descriptors
// each, so 50 keeps a 1 GB host and a default `ulimit -n` of 1024 fine.
export const SSH_TOTAL_LIMIT = 50;

// Logins into one sshd at once: refusals begin at twelve against
// `MaxStartups 10:30:100`.
export const SSH_PER_DOOR_LIMIT = 8;

interface SshGatesOptions {
  inspect: SshInspector;
  logger: Logger;
  totalLimit?: number | undefined;
  perDoorLimit?: number | undefined;
}

interface Gate {
  limiter: ConcurrencyLimiter;
  backlog: BacklogDetector;
}

// The two limits ssh has that no probe owns, below every probe. Neither is
// configurable: one is the collector host's, the other sshd's default.
export class SshGates {
  private readonly total: Gate;
  private readonly perDoor: number;
  private readonly doors = new Map<string, Gate>();
  private readonly routes = new Map<string, Promise<SshRoute>>();
  /** Targets whose route could not be resolved, so the log says so once. */
  private readonly unresolved = new Set<string>();

  constructor(private readonly options: SshGatesOptions) {
    // Not `limit`: the detector logs the number under that name.
    this.total = this.createGate(
      options.totalLimit ?? SSH_TOTAL_LIMIT,
      "ssh on the collector host",
      { gate: "processes" },
    );
    this.perDoor = options.perDoorLimit ?? SSH_PER_DOOR_LIMIT;
  }

  /** Runs one ssh process once its sshd and the collector host have room. */
  async run<T>(
    targetArgs: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const route = await this.resolveRoute(targetArgs);
    const door = this.doorFor(route);

    // The door first, or a crowded jump host would park forty sessions in
    // the total and starve the nodes reached directly.
    return this.through(door, () => this.through(this.total, operation));
  }

  /** Doors with nobody at them are left out: an idle one says nothing. */
  queues(): SshQueues {
    const logins: Record<string, QueueState> = {};

    for (const [door, gate] of this.doors) {
      const state = gate.limiter.state();
      if (state.active + state.queued > 0) logins[door] = state;
    }

    return { processes: this.total.limiter.state(), logins };
  }

  // Once per target. A failed inspection is not kept: a node remembered as
  // direct would log into the jump host outside its door for good.
  private resolveRoute(targetArgs: readonly string[]): Promise<SshRoute> {
    const key = targetArgs.join(" ");
    const cached = this.routes.get(key);
    if (cached) return cached;

    // Under the total: an inspection is an ssh process too.
    const route = this.through(this.total, () =>
      resolveSshRoute(targetArgs, this.options.inspect),
    ).catch((cause: unknown): SshRoute => {
      this.routes.delete(key);

      if (!this.unresolved.has(key)) {
        this.unresolved.add(key);
        this.options.logger.warn(
          "could not resolve the ssh route; treating the node as reached directly until it can be",
          { target: key, cause },
        );
      }

      return { door: `node:${key}` };
    });

    this.routes.set(key, route);

    return route;
  }

  private doorFor(route: SshRoute): Gate {
    let door = this.doors.get(route.door);
    if (door) return door;

    door = this.createGate(this.perDoor, doorSubject(route), {
      door: route.door,
    });
    this.doors.set(route.door, door);

    // Once per shared sshd: the limit, why, and the two ways out.
    if (route.jump !== undefined) {
      this.options.logger.warn(
        `nodes are reached through the jump host "${route.jump}" without ` +
          "connection sharing: its sshd refuses more than ~10 logins at " +
          `once, so ssh through it is limited to ${this.perDoor} at a time. ` +
          `Add to ~/.ssh/config under \`Host ${route.jump}\`: ControlMaster auto, ` +
          "ControlPath ~/.ssh/cm-%C, ControlPersist 10m — or run `ephor serve` " +
          `on ${route.jump}.`,
      );
    } else if (route.door.startsWith("proxy:")) {
      this.options.logger.warn(
        "nodes are reached through a ProxyCommand: the sshd behind it " +
          "refuses more than ~10 logins at once, so ssh through it is " +
          `limited to ${this.perDoor} at a time. A ProxyJump entry with ` +
          "ControlMaster on the jump host lifts the limit.",
        { proxyCommand: route.door.slice("proxy:".length) },
      );
    }

    return door;
  }

  private createGate(limit: number, subject: string, fields: LogFields): Gate {
    return {
      limiter: new ConcurrencyLimiter(limit),
      backlog: new BacklogDetector({
        subject,
        logger: this.options.logger.child(fields),
      }),
    };
  }

  // Sessions arrive one at a time, so a warning here carries the count at
  // the crossing; the peak is in the line that follows. A session waiting
  // at the total still holds its door slot; `/api/health` tells them apart.
  private through<T>(gate: Gate, operation: () => Promise<T>): Promise<T> {
    const result = gate.limiter.run(operation);
    gate.backlog.observe(gate.limiter.state());

    return result.finally(() => gate.backlog.observe(gate.limiter.state()));
  }
}

function doorSubject(route: SshRoute): string {
  if (route.jump !== undefined) {
    return `ssh through the jump host "${route.jump}"`;
  }

  if (route.door.startsWith("proxy:")) return "ssh through the ProxyCommand";

  return `ssh to ${route.door.slice("node:".length)}`;
}
