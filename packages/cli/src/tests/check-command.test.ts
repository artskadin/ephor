import { createLogger } from "@ephorate/core";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api-client";
import { type CollectorClient, runCheck } from "../commands/check";
import { UsageError } from "../exit-code";

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
  // Measured: a tunnel's ssh killed mid-POST reads as refused.
  it("does not run it again over ssh when the remote daemon answers after", async () => {
    const failure = await checkWith({
      ...refusingClient("ssh://bastion"),
      remote: "bastion",
      state: () => Promise.resolve({ now: 0, nodes: [] }),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UsageError);
    expect((failure as Error).message).toBe(
      "lost the ssh link to bastion during the check: it goes on there, " +
        "and `ephor status` shows it once done",
    );
  });

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

describe("runCheck against an older serve", () => {
  // Measured: what a serve from before `skip` answers.
  const SAID = 'answered 400: (root): Unrecognized key: "skip"';

  function olderServe(apiUrl: string): CollectorClient {
    return {
      apiUrl,
      check: () => Promise.reject(new ApiError("rejected", SAID)),
      state: () => Promise.resolve({ now: 0, nodes: [], version: "0.0.0-old" }),
    };
  }

  async function messageFor(client: CollectorClient): Promise<string> {
    const failure = await checkWith(client).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UsageError);
    return (failure as Error).message;
  }

  it("names the update and the restart there for a remote collector", async () => {
    const message = await messageFor({
      ...olderServe("ssh://bastion"),
      remote: "bastion",
    });

    expect(message).toContain(SAID);
    expect(message).toContain("bastion has ephor 0.0.0-old");
    expect(message).toContain("ssh bastion npm i -g ephorate@");
    expect(message).toContain("ssh bastion systemctl --user restart ephor");
  });

  it("asks to restart a serve on this machine onto the new install", async () => {
    const message = await messageFor(olderServe("http://127.0.0.1:31556"));

    expect(message).toContain("takes one --probe and no --skip");
    expect(message).toContain("Restart it onto the ephor installed here");
  });

  // A serve that refuses `skip` also names its nodes the old way, so its
  // state fails too; that failure's words say which side to update.
  it("passes on what the failed state said about updating", async () => {
    const message = await messageFor({
      ...olderServe("http://127.0.0.1:31556"),
      state: () =>
        Promise.reject(
          new ApiError(
            "incompatible",
            "The ephor serve here runs ephor 0.0.0-old",
          ),
        ),
    });

    expect(message).toContain("give one probe, or update it");
    expect(message).toContain("runs ephor 0.0.0-old");
  });

  it("asks to update a collector at another address there", async () => {
    const message = await messageFor(olderServe("http://203.0.113.7:31556"));

    expect(message).toContain("Update it there and restart its serve");
  });
});
