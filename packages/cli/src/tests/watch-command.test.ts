import { describe, expect, it } from "vitest";
import { ApiClient, ApiError } from "../api-client";
import { runWatch } from "../commands/watch";
import { UsageError } from "../exit-code";
import { closedPortUrl, TOKEN } from "./test-server";

/** Both refusals happen before ink is asked to draw anything. */
function watchOptions(isTerminal: boolean, apiUrl: string) {
  return {
    source: new ApiClient({ apiUrl, token: TOKEN }),
    intervalMs: 1000,
    colour: false,
    stdout: process.stdout,
    stdin: process.stdin,
    isTerminal,
  };
}

describe("runWatch", () => {
  it("refuses a stdout that is not a terminal, pointing at status", async () => {
    await expect(
      runWatch(watchOptions(false, "http://127.0.0.1:1")),
    ).rejects.toThrow(UsageError);
    await expect(
      runWatch(watchOptions(false, "http://127.0.0.1:1")),
    ).rejects.toThrow(/ephor status/);
  });

  it("fails like status when the first fetch cannot reach the collector", async () => {
    await expect(
      runWatch(watchOptions(true, await closedPortUrl())),
    ).rejects.toThrow(ApiError);
  });
});
