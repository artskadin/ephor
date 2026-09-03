import type { Logger } from "@ephor/core";
import { ConcurrencyLimiter } from "../scheduling/concurrency-limiter.js";
import {
  resolveSshRoute,
  type SshInspector,
  type SshRoute,
} from "./ssh-route.js";

/**
 * Ssh processes on the collector host at once, whatever the number of
 * probes. Measured: one ssh client is ~4 MB and three descriptors, two of
 * each through a jump host; 50 keeps a 1 GB host and a default `ulimit -n`
 * of 1024 comfortable while six probes force a fleet at once.
 */
export const SSH_TOTAL_LIMIT = 50;

/**
 * Logins into one sshd at once. Measured: refusals begin at twelve
 * concurrent connections against `MaxStartups 10:30:100`; eight keeps a
 * margin for whatever else logs into the same host.
 */
export const SSH_PER_DOOR_LIMIT = 8;

export interface SshGatesOptions {
  inspect: SshInspector;
  logger: Logger;
  totalLimit?: number | undefined;
  perDoorLimit?: number | undefined;
}

/**
 * The two limits ssh has that no probe owns: how many ssh processes the
 * collector host can carry, and how many logins one sshd takes at once.
 * Both sit here, below the probes, so that a seventh probe changes nothing
 * and the no-daemon mode gets the same numbers as the daemon.
 *
 * Neither is configurable. The first is a property of the collector host,
 * the second of sshd's defaults; a user who hits the second is told the two
 * ways out, and both are cheaper than a setting.
 */
export class SshGates {
  private readonly total: ConcurrencyLimiter;
  private readonly perDoor: number;
  private readonly doors = new Map<string, ConcurrencyLimiter>();
  private readonly routes = new Map<string, Promise<SshRoute>>();
  /** Targets whose route could not be resolved, so the log says so once. */
  private readonly unresolved = new Set<string>();

  constructor(private readonly options: SshGatesOptions) {
    this.total = new ConcurrencyLimiter(options.totalLimit ?? SSH_TOTAL_LIMIT);
    this.perDoor = options.perDoorLimit ?? SSH_PER_DOOR_LIMIT;
  }

  /**
   * Runs `operation` — one ssh process — once the sshd it logs into and the
   * collector host both have room for it.
   */
  async run<T>(
    targetArgs: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const route = await this.routeOf(targetArgs);
    const door = this.doorOf(route);

    // The door first: a session takes a place in the total only once its
    // sshd can take it. The other way round, a crowded jump host would park
    // forty sessions in the total and starve the nodes reached directly.
    return door.run(() => this.total.run(operation));
  }

  /**
   * Asked of ssh once per target; the route does not change while running.
   * A failed inspection is not kept: a fleet forced at once can push a few
   * `ssh -G` past the descriptor limit or the timeout, and a node
   * remembered as reached directly would then log into the jump host
   * outside its door for the life of the daemon. It is asked again on the
   * next run, and the log says so once per target rather than once per run.
   */
  private routeOf(targetArgs: readonly string[]): Promise<SshRoute> {
    const key = targetArgs.join(" ");
    const cached = this.routes.get(key);
    if (cached) return cached;

    // Under the total: an inspection is an ssh process too, and fifty of
    // them at a cold start would be the very burst the total exists to
    // prevent. The slot is given back before the session takes its own.
    const route = this.total
      .run(() => resolveSshRoute(targetArgs, this.options.inspect))
      .catch((cause: unknown): SshRoute => {
        this.routes.delete(key);

        if (!this.unresolved.has(key)) {
          this.unresolved.add(key);
          // Whatever stopped `ssh -G` will stop the ssh itself, loudly, in
          // the probe. Nothing is hidden by treating the node as reached
          // directly meanwhile.
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

  private doorOf(route: SshRoute): ConcurrencyLimiter {
    let door = this.doors.get(route.door);
    if (door) return door;

    door = new ConcurrencyLimiter(this.perDoor);
    this.doors.set(route.door, door);

    // Once per shared sshd, at the first session through it: what the limit
    // is, why, and the two ways out. The regular schedule rarely reaches
    // it; a forced fleet-wide check does, and would otherwise report live
    // nodes as unreachable.
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
}
