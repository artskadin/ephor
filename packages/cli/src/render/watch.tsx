import { Box, Text, useInput } from "ink";
import { type ReactElement, useSyncExternalStore } from "react";
import type { NotifyLevel } from "../notify/transitions";
import { clock } from "./clock";
import { StatusTable } from "./status-table";
import type { WatchStore } from "./watch-store";

interface WatchProps {
  store: WatchStore;
  apiUrl: string;
  colour: boolean;
  /** Said in the footer unless it is the default, so silence is explained. */
  notifyOn: NotifyLevel | undefined;
  /** `q` and Ctrl-C: the command owns the screen, so it owns the exit. */
  onQuit: () => void;
}

/** The status table over a `WatchStore`, with a footer saying how fresh. */
export function Watch(props: WatchProps): ReactElement {
  const { store, apiUrl } = props;
  const { state, updatedMs, outage, notificationsFailed } =
    useSyncExternalStore(store.subscribe, store.read);

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
          {props.notifyOn === "critical"
            ? " · notify: critical and stale only"
            : ""}
          {notificationsFailed === undefined
            ? ""
            : ` · notifications off: ${notificationsFailed}`}
        </Text>
      </Box>
    </Box>
  );
}
