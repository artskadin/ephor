import { createLogger } from "@ephorate/core";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api-client.js";
import { type CollectorClient, runCheck } from "../commands/check.js";

/**
 * The one decision the binary tests cannot reach without a network: a
 * refused connection to a collector that is not on this machine.
 */
function refusingClient(apiUrl: string): CollectorClient {
  return {
    apiUrl,
    check: () =>
      Promise.reject(
        new ApiError("refused", `cannot reach the collector at ${apiUrl}`),
      ),
    state: () => Promise.reject(new Error("not asked")),
  };
}

async function checkWith(client: CollectorClient): Promise<string[]> {
  const notes: string[] = [];

  await runCheck({
    configPath: "/nonexistent/config.yaml",
    request: {},
    client,
    json: true,
    colour: false,
    logger: createLogger({ write: () => undefined }),
    print: () => undefined,
    note: (line) => notes.push(line),
  });

  return notes;
}

describe("runCheck with a refused connection", () => {
  it("does not run the probes here for a collector elsewhere", async () => {
    await expect(
      checkWith(refusingClient("http://203.0.113.7:31556")),
    ).rejects.toThrow(ApiError);
  });

  it("falls through to running here for a collector on this machine", async () => {
    // The fallback reads the config, which is not there: that error, not
    // the refusal, is the proof the fallback was taken.
    const failure = await checkWith(
      refusingClient("http://127.0.0.1:31556"),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Cannot read config file");
  });
});
