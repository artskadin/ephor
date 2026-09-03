import { createLogger } from "@ephor/core";
import { describe, expect, it } from "vitest";
import { deferred } from "../../scheduling/tests/deferred.js";
import { SshExecutor } from "../ssh-executor.js";
import { SshGates } from "../ssh-gates.js";
import type { CommandResult } from "../types.js";

const DIRECT = "hostname 203.0.113.10\nport 22\ncontrolmaster false\n";

const silent = () => createLogger({ level: "silent" });

describe("SshExecutor", () => {
  it("spawns ssh for the target with the script on stdin, through the gates", async () => {
    const spawned: {
      args: readonly string[];
      script: string;
      timeoutMs: number;
    }[] = [];
    const gates = new SshGates({
      inspect: async () => DIRECT,
      logger: silent(),
    });
    const executor = new SshExecutor(
      { alias: "achilles", port: 22 },
      "203.0.113.10",
      15_000,
      "achilles",
      {
        gates,
        spawn: async (
          command,
          args,
          script,
          timeoutMs,
        ): Promise<CommandResult> => {
          expect(command).toBe("ssh");
          spawned.push({ args, script, timeoutMs });

          return { stdout: "ok", stderr: "", exitCode: 0 };
        },
      },
    );

    const result = await executor.run("cat /proc/loadavg");

    expect(result.stdout).toBe("ok");
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.args).toEqual(
      expect.arrayContaining(["-o", "BatchMode=yes", "achilles", "bash -s"]),
    );
    expect(spawned[0]?.script).toBe("cat /proc/loadavg");
    expect(spawned[0]?.timeoutMs).toBe(15_000);
  });

  it("waits for a place in the gates before spawning", async () => {
    const gates = new SshGates({
      inspect: async () => DIRECT,
      logger: silent(),
      perDoorLimit: 1,
    });
    const hold = deferred();
    const timeouts: number[] = [];

    const executorOf = () =>
      new SshExecutor(
        { alias: "achilles", port: 22 },
        "203.0.113.10",
        1000,
        "achilles",
        {
          gates,
          spawn: async (
            _command,
            _args,
            _script,
            timeoutMs,
          ): Promise<CommandResult> => {
            timeouts.push(timeoutMs);
            await hold.promise;

            return { stdout: "", stderr: "", exitCode: 0 };
          },
        },
      );

    const first = executorOf().run("true");
    const second = executorOf().run("true");
    for (let turn = 0; turn < 5; turn++) await new Promise(setImmediate);

    expect(timeouts).toHaveLength(1);

    hold.resolve();
    await Promise.all([first, second]);

    // The wait for a place is not taken out of the timeout: the second
    // session gets its whole budget once it starts.
    expect(timeouts).toEqual([1000, 1000]);
  });
});
