import {
  formatDuration,
  type MetricSeverity,
  type MetricStatus,
  type MetricView,
  type NodeState,
  REACHABILITY_VERDICT_METRIC,
  type StateResponse,
} from "@ephorate/core";
import { Box, Text } from "ink";
import type { ReactElement } from "react";

export interface StatusTableProps {
  state: StateResponse;
  /** Whether the tints are painted at all; see `colourEnabled`. */
  colour: boolean;
}

/**
 * What one column shows for a node: the text, its own age, and two
 * judgements that are painted apart — what the value says, and whether it
 * is too old to trust.
 */
interface Cell {
  text: string;
  /**
   * The collector sets it together with `ts`, so a cell without one is not
   * expected; were it to happen, the value shows with nothing under it.
   */
  ageSeconds?: number | undefined;
  /** Paints the value: a stale `down` is still a red `down`. */
  severity: MetricSeverity;
  /** Paints the age: yellow when the value is older than it should be. */
  stale: boolean;
}

/**
 * A column belongs to a probe: it is drawn when any node has that probe
 * enabled, and reads a dash on the nodes that do not. `read` returns
 * nothing for a node whose probe is on but has not reported the metric.
 */
interface Column {
  title: string;
  probe: string;
  read: (node: NodeState) => Cell | undefined;
}

const NEVER_ARRIVED = "-";
const GAP = 2;

/**
 * The columns the table knows. Metric ids are named here and nowhere else
 * in the client; a probe that ships a new metric adds a column here. This
 * is the same knowledge the "probes do not declare their metrics" debt in
 * CLAUDE.md would move into the descriptors.
 */
const COLUMNS: readonly Column[] = [
  {
    title: "REACH",
    probe: "reachability",
    read: (node) => {
      const view = viewOf(node, REACHABILITY_VERDICT_METRIC);

      // The verdict text is the node's own field, folded from the same
      // view; the view is what carries the age and the severity.
      return view && cellOf(view, node.reachability ?? "unknown");
    },
  },
  percentColumn("LOAD", "system", "system.load_percent"),
  percentColumn("MEM", "system", "system.mem_percent"),
  percentColumn("DISK", "system", "system.disk_percent"),
  {
    title: "PORTS",
    probe: "system",
    read: (node) => {
      const view = viewOf(node, "system.ports");

      return view && cellOf(view, portsText(view));
    },
  },
];

/**
 * The three tints: warn and stale alike, critical, and "nothing known".
 * A node nobody has heard from is dimmed, and still marked: the `!` says
 * it needs attention, the dimming says there is nothing to read yet.
 */
type Tint = "yellow" | "red" | "dim";

const TINT_OF: Readonly<Record<MetricStatus, Tint | undefined>> = {
  ok: undefined,
  warn: "yellow",
  stale: "yellow",
  critical: "red",
  unknown: "dim",
};

/**
 * The fleet as a table: two lines per node — the values, and under each
 * its own age — then one line per reason the node is not `ok`, under the
 * node they belong to rather than at the end, where two hundred nodes
 * would put them out of reach. No status column: `!` before the name and
 * colour carry the summary, and `!` survives without colour.
 *
 * One component for `status`, `check` and `watch`: the first renders a
 * frame and leaves, the others keep it on screen and feed it new states.
 */
export function StatusTable({ state, colour }: StatusTableProps): ReactElement {
  const { columns, rows, widths } = layoutOf(state);
  const keys = ["NODE", ...columns.map((column) => column.title)];
  const tint = (status: MetricStatus): Tint | undefined =>
    colour ? TINT_OF[status] : undefined;

  return (
    <Box flexDirection="column">
      <Line
        cells={[
          { text: "NODE" },
          ...columns.map((column) => ({ text: column.title })),
        ]}
        widths={widths}
        keys={keys}
      />
      {rows.map((row) => (
        <Box key={row.node} flexDirection="column">
          <Line
            cells={[
              { text: row.name.text, tint: tint(row.name.status) },
              ...row.values.map((cell) => ({
                text: cell.text,
                tint: tint(cell.status),
              })),
            ]}
            widths={widths}
            keys={keys}
          />
          {/* No age at all — nothing has arrived — is no line, not an empty one. */}
          {row.ages.some((cell) => cell.text !== "") && (
            <Line
              cells={[
                { text: "" },
                ...row.ages.map((cell) => ({
                  text: cell.text,
                  tint: tint(cell.status),
                })),
              ]}
              widths={widths}
              keys={keys}
            />
          )}
          {/* One text, one line per reason: a list would want a key, and
              two probes may one day give the same reason. */}
          {row.reasons.length > 0 && (
            <Text dimColor={colour}>
              {row.reasons
                .map((reason) => `${" ".repeat(GAP)}${reason}`)
                .join("\n")}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

/**
 * The frame width the table needs, for `frameOf`: the widest line, so
 * nothing wraps and nothing is laid out for space that stays empty. The
 * last cell of a line is not padded, so a line is at most every column
 * width plus the gaps; a reason line is its text behind the gap.
 */
export function statusTableWidth(state: StateResponse): number {
  const { columns, rows, widths } = layoutOf(state);
  const lineWidth =
    widths.reduce((sum, width) => sum + width, 0) + GAP * columns.length;
  const reasonWidth = Math.max(
    0,
    ...rows.flatMap((row) => row.reasons.map((reason) => GAP + reason.length)),
  );

  return Math.max(lineWidth, reasonWidth);
}

interface Layout {
  columns: readonly Column[];
  rows: Row[];
  /** The NODE column first, then one per drawn column. */
  widths: number[];
}

function layoutOf(state: StateResponse): Layout {
  const columns = COLUMNS.filter((column) =>
    state.nodes.some((node) => node.probes.includes(column.probe)),
  );
  const rows = state.nodes.map((node) => rowOf(node, columns));

  // Widths from the plain text, so colour cannot move a column: the
  // header, every value and every age share one width per column.
  const widths = [
    Math.max("NODE".length, ...rows.map((row) => row.name.text.length)),
    ...columns.map((column, index) =>
      Math.max(
        column.title.length,
        ...rows.map((row) =>
          Math.max(
            row.values[index]?.text.length ?? 0,
            row.ages[index]?.text.length ?? 0,
          ),
        ),
      ),
    ),
  ];

  return { columns, rows, widths };
}

interface Painted {
  text: string;
  tint?: Tint | undefined;
}

/**
 * One line of cells, each in a box of its column's width with a gap after
 * it. The last cell gets neither: it is as wide as its text, so a line
 * never ends in padding, and the same text comes out with colour and
 * without.
 */
function Line({
  cells,
  widths,
  keys,
}: {
  cells: readonly Painted[];
  widths: readonly number[];
  keys: readonly string[];
}): ReactElement {
  return (
    <Box flexDirection="row">
      {cells.map((cell, index) =>
        index === cells.length - 1 ? (
          <Box key={keys[index]}>
            <PaintedText {...cell} />
          </Box>
        ) : (
          <Box key={keys[index]} width={widths[index] ?? 0} marginRight={GAP}>
            <PaintedText {...cell} />
          </Box>
        ),
      )}
    </Box>
  );
}

function PaintedText({ text, tint }: Painted): ReactElement {
  if (tint === undefined) return <Text>{text}</Text>;
  if (tint === "dim") return <Text dimColor>{text}</Text>;

  return <Text color={tint}>{text}</Text>;
}

interface Row {
  node: string;
  name: { text: string; status: MetricStatus };
  values: { text: string; status: MetricStatus }[];
  ages: { text: string; status: MetricStatus }[];
  reasons: string[];
}

function rowOf(node: NodeState, columns: readonly Column[]): Row {
  const cells = columns.map((column) =>
    node.probes.includes(column.probe) ? column.read(node) : undefined,
  );

  return {
    node: node.node,
    name: {
      text: `${node.status === "ok" ? "" : "! "}${node.node}`,
      status: node.status,
    },
    // Each line answers its own question. The value line: what does it
    // say — a stale `down` is a red `down`, a disk past its bound is red
    // however old the reading. The age line: is it current — a stale age
    // yellow, a fresh one plain. Painting both by one status set the whole
    // table alight whenever a daemon woke on an old database.
    values: cells.map((cell) =>
      cell
        ? { text: cell.text, status: cell.severity }
        : { text: NEVER_ARRIVED, status: "ok" },
    ),
    ages: cells.map((cell) =>
      cell?.ageSeconds !== undefined
        ? {
            text: formatDuration(cell.ageSeconds),
            status: cell.stale ? "stale" : "ok",
          }
        : { text: "", status: "ok" },
    ),
    reasons: node.reasons,
  };
}

function percentColumn(title: string, probe: string, metric: string): Column {
  return {
    title,
    probe,
    read: (node) => {
      const view = viewOf(node, metric);

      return (
        view &&
        cellOf(
          view,
          view.value === undefined ? "?" : `${Math.round(view.value)}%`,
        )
      );
    },
  };
}

/**
 * `ok`, or the first thing wrong in the collector's own words: the
 * declared ports that nobody listens on, else the listeners nobody
 * declared. Both lists come from the probe's `meta`.
 */
function portsText(view: MetricView): string {
  if (view.ok !== false) return "ok";

  const missing = listIn(view.meta, "missing");
  if (missing.length > 0) return `missing ${missing.join(", ")}`;

  const undeclared = listIn(view.meta, "undeclared");
  if (undeclared.length > 0) return `extra ${undeclared.join(", ")}`;

  return "!";
}

function listIn(
  meta: Record<string, unknown> | undefined,
  key: string,
): string[] {
  const value = meta?.[key];

  return Array.isArray(value) ? value.map(String) : [];
}

function viewOf(node: NodeState, metric: string): MetricView | undefined {
  return node.metrics.find((view) => view.metric === metric);
}

function cellOf(view: MetricView, text: string): Cell {
  return {
    text,
    ageSeconds: view.ageSeconds,
    severity: view.severity,
    stale: view.status === "stale",
  };
}
