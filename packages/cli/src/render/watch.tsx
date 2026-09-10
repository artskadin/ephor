import { Box, Text, useInput } from "ink";
import { type ReactElement, useSyncExternalStore } from "react";
import { StatusTable } from "./status-table";
import type { WatchStore } from "./watch-store";

interface WatchProps {
  store: WatchStore;
  apiUrl: string;
  colour: boolean;
  /** `q` and Ctrl-C: the command owns the screen, so it owns the exit. */
  onQuit: () => void;
}

/** The status table over a `WatchStore`, with a footer saying how fresh. */
export function Watch(props: WatchProps): ReactElement {
  const { store, apiUrl } = props;
  const { state, updatedMs, outage } = useSyncExternalStore(
    store.subscribe,
    store.read,
  );

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) props.onQuit();
  });

  // Wrapped by ink, so its height is known and the frame is erased whole.
  return (
    <Box flexDirection="column">
      <StatusTable state={state} colour={props.colour} />
      <Box marginTop={1}>
        <Text dimColor={props.colour}>
          {outage
            ? `collector at ${apiUrl} unreachable since ` +
              `${clock(outage.sinceMs)}, last update ${clock(updatedMs)}: ` +
              outage.message
            : `collector at ${apiUrl} · updated ${clock(updatedMs)} · q to quit`}
        </Text>
      </Box>
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
