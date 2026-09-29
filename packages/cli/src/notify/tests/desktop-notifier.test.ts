import { describe, expect, it } from "vitest";
import {
  desktopNotifier,
  type RunProgram,
  runProgram,
} from "../desktop-notifier";

function recording(): RunProgram & { calls: [string, string[]][] } {
  const run = Object.assign(
    async (command: string, args: string[]): Promise<void> => {
      run.calls.push([command, args]);
    },
    { calls: [] as [string, string[]][] },
  );

  return run;
}

describe("desktopNotifier", () => {
  it("uses osascript on macOS, with the text escaped for AppleScript", async () => {
    const run = recording();
    const notify = desktopNotifier("darwin", run);

    await notify?.('ephor: "quoted"', 'back\\slash and "quotes"');

    expect(run.calls).toEqual([
      [
        "osascript",
        [
          "-e",
          'display notification "back\\\\slash and \\"quotes\\"" with title "ephor: \\"quoted\\""',
        ],
      ],
    ]);
  });

  it("uses notify-send on Linux, the texts as arguments", async () => {
    const run = recording();
    const notify = desktopNotifier("linux", run);

    await notify?.("ephor: german", "-- <ssh> says a & b");

    expect(run.calls).toEqual([
      ["notify-send", ["--", "ephor: german", "-- &lt;ssh&gt; says a &amp; b"]],
    ]);
  });

  it("has nothing to offer on other platforms", () => {
    expect(desktopNotifier("win32", recording())).toBeUndefined();
    expect(desktopNotifier("freebsd", recording())).toBeUndefined();
  });

  it("passes a failure on, so the caller can stop trying", async () => {
    const notify = desktopNotifier("linux", async () => {
      throw new Error("spawn notify-send ENOENT");
    });

    await expect(notify?.("t", "b")).rejects.toThrow("ENOENT");
  });
});

describe("runProgram", () => {
  it("resolves when the program exits 0", async () => {
    await expect(
      runProgram(process.execPath, ["-e", "process.exit(0)"]),
    ).resolves.toBeUndefined();
  });

  it("rejects with ENOENT for a program that is not there", async () => {
    await expect(
      runProgram("ephor-no-such-program", ["x"]),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects when the program fails", async () => {
    await expect(
      runProgram(process.execPath, ["-e", "process.exit(1)"]),
    ).rejects.toBeInstanceOf(Error);
  });
});
