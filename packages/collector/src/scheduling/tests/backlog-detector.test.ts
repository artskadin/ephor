import { createLogger, type Logger } from "@ephorate/core";
import { describe, expect, it } from "vitest";
import { BacklogDetector } from "../backlog-detector.js";

/** Captured as parsed records, so assertions name fields, not substrings. */
function captureLogs(): { logger: Logger; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];

  const logger = createLogger({
    level: "debug",
    format: "json",
    environment: {},
    isTerminal: false,
    write: (line) => records.push(JSON.parse(line) as Record<string, unknown>),
  });

  return { logger, records };
}

function detectorOf(): {
  detector: BacklogDetector;
  records: Record<string, unknown>[];
} {
  const { logger, records } = captureLogs();

  return {
    detector: new BacklogDetector({
      subject: "system",
      logger: logger.child({ probe: "system" }),
    }),
    records,
  };
}

/** Nobody waits while a slot is free, so a waiting task means a full house. */
const queue = (queued: number, limit = 4) => ({
  active: queued > 0 ? limit : 0,
  queued,
  limit,
});

describe("BacklogDetector", () => {
  it("says once that a wave is waiting, and once that the queue emptied", () => {
    const { detector, records } = detectorOf();

    detector.observe(queue(47));
    detector.observe(queue(30));
    detector.observe(queue(2));
    detector.observe(queue(0));
    detector.observe(queue(0));

    expect(records).toMatchObject([
      {
        level: "warn",
        msg: "system is falling behind: 47 queued, limit 4",
        probe: "system",
        active: 4,
        queued: 47,
        limit: 4,
      },
      {
        level: "info",
        msg: "system caught up, peak was 47 queued",
        probe: "system",
        peak: 47,
      },
    ]);
  });

  it("stays quiet while fewer than a wave are waiting", () => {
    const { detector, records } = detectorOf();

    detector.observe(queue(3));
    detector.observe(queue(1));
    detector.observe(queue(0));

    expect(records).toEqual([]);
  });

  // Behind ends at empty, not one below the bar: a queue hovering at the
  // bar would otherwise write a pair of lines on every crossing.
  it("does not flap at the bar", () => {
    const { detector, records } = detectorOf();

    detector.observe(queue(4));
    detector.observe(queue(3));
    detector.observe(queue(4));
    detector.observe(queue(3));
    detector.observe(queue(0));

    expect(records.map((record) => record.level)).toEqual(["warn", "info"]);
  });

  // The warning carries the count at the crossing; what the operator wants
  // afterwards is how deep it went, and only the closing line can say.
  it("reports the peak reached while behind, not the count at the crossing", () => {
    const { detector, records } = detectorOf();

    detector.observe(queue(4));
    detector.observe(queue(9));
    detector.observe(queue(5));
    detector.observe(queue(0));

    expect(records[1]).toMatchObject({
      msg: "system caught up, peak was 9 queued",
      peak: 9,
    });
  });

  // The second episode is shallower than the first: a peak that survived
  // the first "caught up" would show through as 9 rather than 4.
  it("warns again for a second episode, with that episode's own peak", () => {
    const { detector, records } = detectorOf();

    detector.observe(queue(9));
    detector.observe(queue(0));
    detector.observe(queue(4));
    detector.observe(queue(0));

    expect(records.map((record) => record.msg)).toEqual([
      "system is falling behind: 9 queued, limit 4",
      "system caught up, peak was 9 queued",
      "system is falling behind: 4 queued, limit 4",
      "system caught up, peak was 4 queued",
    ]);
  });

  it("takes one waiting task as a wave under a limit of one", () => {
    const { detector, records } = detectorOf();

    detector.observe({ active: 1, queued: 1, limit: 1 });

    expect(records).toMatchObject([
      { level: "warn", msg: "system is falling behind: 1 queued, limit 1" },
    ]);
  });
});
