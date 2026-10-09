import type { StateResponse } from "@ephorate/core";
import { Box, type Key, Text, useInput } from "ink";
import { type ReactElement, useReducer, useSyncExternalStore } from "react";
import type { NotifyLevel } from "../notify/transitions";
import { collectorVersionWarning } from "../remote-version";
import { clock } from "./clock";
import type { Scroll, ScrollMove } from "./scroll";
import { nodeHeights, StatusTable, wrappedHeight } from "./status-table";
import type { WatchStore } from "./watch-store";

interface WatchProps {
  store: WatchStore;
  apiUrl: string;
  /** The ssh host of a collector elsewhere, named when its ephor differs. */
  remote?: string | undefined;
  colour: boolean;
  /** Said in the footer unless it is the default, so silence is explained. */
  notifyOn: NotifyLevel | undefined;
  /** Outlives a remount, so a resize keeps the place. */
  scroll: Scroll;
  /** The window, read at mount: a resize remounts the view. */
  columns: number;
  rows: number;
  /** `q` and Ctrl-C: the command owns the screen, so it owns the exit. */
  onQuit: () => void;
}

const TROUBLE = ["critical", "stale", "warn", "unknown"] as const;

const MOVE_BY_LETTER: Readonly<Record<string, ScrollMove>> = {
  j: "down",
  k: "up",
  g: "top",
  G: "end",
};

function moveOf(input: string, key: Key): ScrollMove | undefined {
  if (key.downArrow) return "down";
  if (key.upArrow) return "up";
  if (key.pageDown) return "pageDown";
  if (key.pageUp) return "pageUp";
  if (key.home) return "top";
  if (key.end) return "end";

  return MOVE_BY_LETTER[input];
}

/**
 * The status table over a `WatchStore`, as many nodes as the window holds,
 * with a footer saying which, how fresh, and how to scroll.
 */
export function Watch(props: WatchProps): ReactElement {
  const { store, apiUrl, scroll, columns } = props;
  const { state, updatedMs, outage, notificationsFailed } =
    useSyncExternalStore(store.subscribe, store.read);
  const [, redraw] = useReducer((count: number) => count + 1, 0);

  const versionWarning = collectorVersionWarning(
    { remote: props.remote, apiUrl },
    state.version,
  );
  const heights = nodeHeights(state, columns);
  const total = heights.length;
  const tail =
    (outage
      ? `collector at ${apiUrl} unreachable since ` +
        `${clock(outage.sinceMs)}, last update ${clock(updatedMs)}: ` +
        outage.message
      : `collector at ${apiUrl} · updated ${clock(updatedMs)} · q to quit`) +
    (props.notifyOn === "critical"
      ? " · notify: critical and stale only"
      : "") +
    (notificationsFailed === undefined
      ? ""
      : ` · notifications off: ${notificationsFailed}`) +
    // Its own lines: the command in it is to be copied.
    (versionWarning === undefined ? "" : `\n${versionWarning}`);

  // The footer's height is counted at its longest, every node number as
  // wide as the last. A frame as tall as the window makes ink wipe the
  // whole screen on every update (ink.js, `isFullscreen`): one line less.
  const footerHeight = wrappedHeight(
    footerText(total, total, total, state, true, tail),
    columns,
  );
  const fleet = {
    names: heights.map((each) => each.node),
    heights: heights.map((each) => each.height),
    budget: props.rows - 1 - 1 - footerHeight - 1,
  };
  const { first, count } = scroll.viewport(fleet);
  const drawnHeight = fleet.heights
    .slice(first, first + count)
    .reduce((sum, height) => sum + height, 0);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      props.onQuit();
      return;
    }

    const move = moveOf(input, key);
    if (move === undefined) return;

    scroll.move(move, fleet);
    redraw();
  });

  // Wrapped by ink, so its height is known and the frame is erased whole.
  return (
    <Box flexDirection="column">
      {/* Cut at the budget: a node taller than the window is drawn alone,
          and the frame must still stay below the window's height. */}
      <Box
        height={1 + Math.min(drawnHeight, Math.max(0, fleet.budget))}
        overflowY="hidden"
      >
        <StatusTable
          state={state}
          colour={props.colour}
          visible={{ first, count }}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor={props.colour}>
          {footerText(
            first + 1,
            first + count,
            total,
            state,
            count < total,
            tail,
          )}
        </Text>
      </Box>
    </Box>
  );
}

// `nodes 1–18 of 200 · 3 critical, 12 warn`: where the window is, and
// what is wrong across the whole fleet, the part not drawn included.
function footerText(
  from: number,
  to: number,
  total: number,
  state: StateResponse,
  canScroll: boolean,
  tail: string,
): string {
  const range = total === 0 ? "no nodes" : `nodes ${from}–${to} of ${total}`;
  const counts = TROUBLE.map((status) => ({
    status,
    count: state.nodes.filter((node) => node.status === status).length,
  })).filter((each) => each.count > 0);
  const trouble =
    counts.length === 0
      ? "all ok"
      : counts.map((each) => `${each.count} ${each.status}`).join(", ");
  const keys = canScroll ? " · ↑↓ PgUp PgDn" : "";

  return `${range} · ${trouble}${keys} · ${tail}`;
}
