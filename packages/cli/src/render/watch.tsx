import type { StateResponse } from "@ephorate/core";
import { Box, Text, useApp, useInput } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import { StatusTable } from "./status-table";

/** What `watch` needs of `ApiClient`; a test stands in a fake. */
export interface WatchSource {
  apiUrl: string;
  state(): Promise<StateResponse>;
}

interface WatchProps {
  source: WatchSource;
  /** Fetched before the first frame: a failure there is the command's. */
  initial: StateResponse;
  intervalMs: number;
  colour: boolean;
  /** Epoch milliseconds, for the footer. */
  now: () => number;
}

interface Outage {
  sinceMs: number;
  message: string;
}

/**
 * The status table, refetched on an interval. A poll that fails keeps the
 * last table and says so underneath: stale data is the message, not a
 * reason to leave.
 */
export function Watch(props: WatchProps): ReactElement {
  const { source, intervalMs, now } = props;
  const { exit } = useApp();
  const [state, setState] = useState(props.initial);
  const [updatedMs, setUpdatedMs] = useState(now());
  const [outage, setOutage] = useState<Outage | undefined>(undefined);

  useInput((input) => {
    if (input === "q") exit();
  });

  useEffect(() => {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;

    const poll = async (): Promise<void> => {
      try {
        const next = await source.state();
        if (stopped) return;

        setState(next);
        setUpdatedMs(now());
        setOutage(undefined);
      } catch (error) {
        if (stopped) return;

        setOutage(
          (current) => current ?? { sinceMs: now(), message: describe(error) },
        );
      }

      timer = setTimeout(() => void poll(), intervalMs);
    };

    timer = setTimeout(() => void poll(), intervalMs);

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [source, intervalMs, now]);

  // Truncated: an outage line names the address and the error, and a
  // wrapped footer re-flows the whole frame on every redraw.
  return (
    <Box flexDirection="column">
      <StatusTable state={state} colour={props.colour} />
      <Text dimColor={props.colour} wrap="truncate">
        {outage
          ? `unreachable since ${clock(outage.sinceMs)}, ` +
            `last update ${clock(updatedMs)}: ${outage.message}`
          : `${source.apiUrl} · updated ${clock(updatedMs)} · q to quit`}
      </Text>
    </Box>
  );
}

// A fixed locale: the user's own gives `7:05:03`, `7.05.03` or wide
// glyphs, and the table measures UTF-16 units.
const CLOCK = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function clock(ms: number): string {
  return CLOCK.format(new Date(ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
