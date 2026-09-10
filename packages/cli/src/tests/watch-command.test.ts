import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { StateResponse } from "@ephorate/core";
import { describe, expect, it } from "vitest";
import { ApiClient, ApiError } from "../api-client";
import { runWatch } from "../commands/watch";
import { UsageError } from "../exit-code";
import { closedPortUrl, stateOf, TOKEN } from "./test-server";

const ENTER_ALTERNATE_SCREEN = "\u001b[?1049h";
const LEAVE_ALTERNATE_SCREEN = "\u001b[?25h\u001b[?1049l";
const CLEAR_SCREEN = "\u001b[2J\u001b[H";

/** Both refusals happen before ink is asked to draw anything. */
function refusing(isTerminal: boolean, apiUrl: string) {
  return {
    source: new ApiClient({ apiUrl, token: TOKEN }),
    intervalMs: 1000,
    colour: false,
    stdout: process.stdout,
    stdin: process.stdin,
    isTerminal,
  };
}

/**
 * A terminal of the given size that records what is written to it and
 * can be resized and typed into: ink needs a TTY-shaped pair.
 */
function fakeTerminal(columns: number) {
  const writes: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns,
    rows: 20,
    write(chunk: string, callback?: unknown): boolean {
      writes.push(chunk);
      if (typeof callback === "function") callback();

      return true;
    },
  }) as unknown as NodeJS.WriteStream;
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  }) as unknown as NodeJS.ReadStream & PassThrough;

  return { stdout, stdin, writes, output: () => writes.join("") };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;

  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("runWatch", () => {
  it("refuses a stdout that is not a terminal, pointing at status", async () => {
    await expect(
      runWatch(refusing(false, "http://127.0.0.1:1")),
    ).rejects.toThrow(UsageError);
    await expect(
      runWatch(refusing(false, "http://127.0.0.1:1")),
    ).rejects.toThrow(/ephor status/);
  });

  it("fails like status when the first fetch cannot reach the collector", async () => {
    await expect(
      runWatch(refusing(true, await closedPortUrl())),
    ).rejects.toThrow(ApiError);
  });

  it("takes the alternate screen, redraws from scratch after a resize, and gives the screen back on q", async () => {
    const terminal = fakeTerminal(80);
    const state: StateResponse = stateOf({ name: "achilles", status: "ok" });
    const source = {
      apiUrl: "http://127.0.0.1:31556",
      state: async () => state,
    };

    const finished = runWatch({
      source,
      intervalMs: 1000,
      colour: false,
      stdout: terminal.stdout,
      stdin: terminal.stdin,
      isTerminal: true,
    });
    await until(() => terminal.output().includes("q to quit"));

    const firstFrameAt = terminal.output().indexOf("achilles");
    expect(terminal.output().indexOf(ENTER_ALTERNATE_SCREEN)).toBeLessThan(
      firstFrameAt,
    );

    // A burst of resizes: one wipe and one full frame after it settles.
    const before = terminal.writes.length;
    terminal.stdout.columns = 40;
    terminal.stdout.emit("resize");
    terminal.stdout.emit("resize");
    await until(() =>
      terminal.writes.slice(before).join("").includes(CLEAR_SCREEN),
    );
    await until(
      () =>
        terminal.writes.slice(before).join("").split("q to quit").length >= 2,
    );
    const afterResize = terminal.writes.slice(before).join("");
    expect(afterResize.split(CLEAR_SCREEN).length).toBe(2);
    expect(afterResize.indexOf(CLEAR_SCREEN)).toBeLessThan(
      afterResize.lastIndexOf("achilles"),
    );

    // The remount must not count as ink exiting: still watching.
    const stillWatching = await Promise.race([
      finished.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 50)),
    ]);
    expect(stillWatching).toBe(true);

    terminal.stdin.write("q");
    await finished;

    expect(terminal.output().endsWith(LEAVE_ALTERNATE_SCREEN)).toBe(true);
  }, 10_000);
});
