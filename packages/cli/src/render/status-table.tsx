import {
  type Acknowledgement,
  formatDuration,
  type MetricSeverity,
  type MetricStatus,
  type MetricView,
  type NodeState,
  REACHABILITY_VERDICT_METRIC,
  STATUS_RANK,
  type StateResponse,
} from "@ephorate/core";
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import wrapAnsi from "wrap-ansi";

interface StatusTableProps {
  state: StateResponse;
  /** See `colourEnabled`. */
  colour: boolean;
  /** Of the ordered nodes, the ones drawn; all when absent. */
  visible?: { first: number; count: number } | undefined;
}

interface Cell {
  text: string;
  ageSeconds?: number | undefined;
  /** Paints the value: a stale `down` is still a red `down`. */
  severity: MetricSeverity;
  /** Paints the age. */
  stale: boolean;
}

/** Drawn when any node has the probe; a dash on the nodes that do not. */
interface Column {
  title: string;
  probe: string;
  read: (node: NodeState) => Cell | undefined;
}

const NEVER_ARRIVED = "-";
const GAP = 2;

// Metric ids are named here and nowhere else in the client.
const COLUMNS: readonly Column[] = [
  {
    title: "REACH",
    probe: "reachability",
    read: (node) => {
      const view = metricView(node, REACHABILITY_VERDICT_METRIC);

      return view && cellFromView(view, node.reachability ?? "unknown");
    },
  },
  percentColumn("LOAD", "system", "system.load_percent"),
  percentColumn("MEM", "system", "system.mem_percent"),
  percentColumn("DISK", "system", "system.disk_percent"),
  {
    title: "PORTS",
    probe: "system",
    read: (node) => {
      const view = metricView(node, "system.ports");

      return view && cellFromView(view, portsText(view));
    },
  },
];

type Tint = "yellow" | "red" | "dim";

const TINT_BY_STATUS: Readonly<Record<MetricStatus, Tint | undefined>> = {
  ok: undefined,
  warn: "yellow",
  stale: "yellow",
  critical: "red",
  unknown: "dim",
};

// Two lines per node, the values and their ages, then its acknowledgement,
// not dimmed, then one line per reason. `!` before the name survives
// without colour; an acknowledgement changes neither.
export function StatusTable({
  state,
  colour,
  visible,
}: StatusTableProps): ReactElement {
  // Widths from every node, so scrolling cannot move a column.
  const { columns, rows: allRows, widths } = layoutTable(state);
  const rows =
    visible === undefined
      ? allRows
      : allRows.slice(visible.first, visible.first + visible.count);
  const keys = ["NODE", ...columns.map((column) => column.title)];
  const tint = (status: MetricStatus): Tint | undefined =>
    colour ? TINT_BY_STATUS[status] : undefined;

  // Clipped at the window's edge: a line the terminal wrapped would be one
  // line to ink and two on screen, and the next frame erases too little.
  return (
    <Box flexDirection="column" overflowX="hidden">
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
          {row.acknowledgement !== undefined && (
            <Text>{indented([row.acknowledgement])}</Text>
          )}
          {row.reasons.length > 0 && (
            <Text dimColor={colour}>{indented(row.reasons)}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

function indented(lines: readonly string[]): string {
  return lines.map((line) => `${" ".repeat(GAP)}${line}`).join("\n");
}

// Ink wraps a `Text` with wrap-ansi, `{ trim: false, hard: true }`
// (ink/build/wrap-text.js); counting the same way gives the height exact.
export function wrappedHeight(text: string, columns: number): number {
  return wrapAnsi(text, columns, { trim: false, hard: true }).split("\n")
    .length;
}

/** Each node's lines at `columns` wide, in the table's order. */
export function nodeHeights(
  state: StateResponse,
  columns: number,
): { node: string; height: number }[] {
  return layoutTable(state).rows.map((row) => {
    let height = 1;
    if (row.ages.some((cell) => cell.text !== "")) height += 1;
    if (row.acknowledgement !== undefined) {
      height += wrappedHeight(indented([row.acknowledgement]), columns);
    }
    if (row.reasons.length > 0) {
      height += wrappedHeight(indented(row.reasons), columns);
    }

    return { node: row.node, height };
  });
}

/** The widest line: ink lays out a cell per column per line, so no more. */
export function statusTableWidth(state: StateResponse): number {
  const { columns, rows, widths } = layoutTable(state);
  const lineWidth =
    widths.reduce((sum, width) => sum + width, 0) + GAP * columns.length;
  const reasonWidth = Math.max(
    0,
    ...rows.flatMap((row) =>
      [...row.reasons, row.acknowledgement ?? ""].map(
        (line) => GAP + line.length,
      ),
    ),
  );

  return Math.max(lineWidth, reasonWidth);
}

interface Layout {
  columns: readonly Column[];
  rows: Row[];
  /** NODE first, then one per drawn column. */
  widths: number[];
}

function layoutTable(state: StateResponse): Layout {
  const columns = COLUMNS.filter((column) =>
    state.nodes.some((node) => node.probes.includes(column.probe)),
  );
  const rows = [...state.nodes]
    .sort(worstFirst)
    .map((node) => buildRow(node, columns, state.now));

  // From the plain text, so colour cannot move a column.
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

// Worst first, so a fleet's trouble is at the top; then by name, compared
// by code unit: a locale would order `B` and `b` differently per machine.
function worstFirst(left: NodeState, right: NodeState): number {
  const byStatus = STATUS_RANK[right.status] - STATUS_RANK[left.status];
  if (byStatus !== 0) return byStatus;

  return left.node < right.node ? -1 : left.node > right.node ? 1 : 0;
}

interface PaintedCell {
  text: string;
  tint?: Tint | undefined;
}

// The last cell is not padded, so no line ends in spaces. Cells never
// shrink or wrap: in a window narrower than the table, `watch` cuts the
// right columns off instead of stacking every cell letter by letter.
function Line({
  cells,
  widths,
  keys,
}: {
  cells: readonly PaintedCell[];
  widths: readonly number[];
  keys: readonly string[];
}): ReactElement {
  return (
    // Not shrunk either: in `watch`'s cut box a squeezed line drew over the
    // one above it.
    <Box flexDirection="row" flexShrink={0}>
      {cells.map((cell, index) =>
        index === cells.length - 1 ? (
          <Box key={keys[index]} flexShrink={0}>
            <PaintedText {...cell} />
          </Box>
        ) : (
          <Box
            key={keys[index]}
            width={widths[index] ?? 0}
            marginRight={GAP}
            flexShrink={0}
          >
            <PaintedText {...cell} />
          </Box>
        ),
      )}
    </Box>
  );
}

function PaintedText({ text, tint }: PaintedCell): ReactElement {
  if (tint === undefined) return <Text wrap="truncate">{text}</Text>;
  if (tint === "dim") {
    return (
      <Text dimColor wrap="truncate">
        {text}
      </Text>
    );
  }

  return (
    <Text color={tint} wrap="truncate">
      {text}
    </Text>
  );
}

interface Row {
  node: string;
  name: { text: string; status: MetricStatus };
  values: { text: string; status: MetricStatus }[];
  ages: { text: string; status: MetricStatus }[];
  acknowledgement?: string;
  reasons: string[];
}

// The value line is painted by what the value says, the age line by its
// staleness, the name by the node's status.
function buildRow(
  node: NodeState,
  columns: readonly Column[],
  now: number,
): Row {
  const cells = columns.map((column) =>
    node.probes.includes(column.probe) ? column.read(node) : undefined,
  );

  const row: Row = {
    node: node.node,
    name: {
      text: `${node.status === "ok" ? "" : "! "}${node.node}`,
      status: node.status,
    },
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
  if (node.acknowledged !== undefined) {
    row.acknowledgement = acknowledgementText(node.acknowledged, now);
  }

  return row;
}

// Ages by the collector's clock, `now` from its answer: a bastion's clock
// and the PC's may differ.
function acknowledgementText(
  acknowledgement: Acknowledgement,
  now: number,
): string {
  const parts = [
    `acknowledged ${formatDuration(now - acknowledgement.since)} ago`,
  ];
  if (acknowledgement.untilOk) parts.push("until ok");
  if (acknowledgement.until !== undefined) {
    parts.push(`${formatDuration(acknowledgement.until - now)} left`);
  }
  const note =
    acknowledgement.note === undefined ? "" : `: ${acknowledgement.note}`;

  return `${parts.join(", ")}${note}`;
}

function percentColumn(title: string, probe: string, metric: string): Column {
  return {
    title,
    probe,
    read: (node) => {
      const view = metricView(node, metric);

      return (
        view &&
        cellFromView(
          view,
          view.value === undefined ? "?" : `${Math.round(view.value)}%`,
        )
      );
    },
  };
}

// What listens, for reference: without `ports` in the config nothing is
// compared; with them, the first thing wrong in the probe's own words.
function portsText(view: MetricView): string {
  if (view.ok !== false) {
    if (!Array.isArray(view.meta?.listening)) return "ok";

    const listening = stringListIn(view.meta, "listening");
    return listening.length > 0 ? listening.join(", ") : "none";
  }

  const missing = stringListIn(view.meta, "missing");
  if (missing.length > 0) return `missing ${missing.join(", ")}`;

  const undeclared = stringListIn(view.meta, "undeclared");
  if (undeclared.length > 0) return `extra ${undeclared.join(", ")}`;

  if (typeof view.meta?.unreadable === "string") return "unreadable";

  return "!";
}

function stringListIn(
  meta: Record<string, unknown> | undefined,
  key: string,
): string[] {
  const value = meta?.[key];

  return Array.isArray(value) ? value.map(String) : [];
}

function metricView(node: NodeState, metric: string): MetricView | undefined {
  return node.metrics.find((view) => view.metric === metric);
}

function cellFromView(view: MetricView, text: string): Cell {
  return {
    text,
    ageSeconds: view.ageSeconds,
    severity: view.severity,
    stale: view.status === "stale",
  };
}
