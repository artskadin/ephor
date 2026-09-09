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

interface StatusTableProps {
  state: StateResponse;
  /** See `colourEnabled`. */
  colour: boolean;
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

// Two lines per node, the values and their ages, then one line per reason
// under the node. `!` before the name survives without colour.
export function StatusTable({ state, colour }: StatusTableProps): ReactElement {
  const { columns, rows, widths } = layoutTable(state);
  const keys = ["NODE", ...columns.map((column) => column.title)];
  const tint = (status: MetricStatus): Tint | undefined =>
    colour ? TINT_BY_STATUS[status] : undefined;

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

/** The widest line: ink lays out a cell per column per line, so no more. */
export function statusTableWidth(state: StateResponse): number {
  const { columns, rows, widths } = layoutTable(state);
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
  /** NODE first, then one per drawn column. */
  widths: number[];
}

function layoutTable(state: StateResponse): Layout {
  const columns = COLUMNS.filter((column) =>
    state.nodes.some((node) => node.probes.includes(column.probe)),
  );
  const rows = state.nodes.map((node) => buildRow(node, columns));

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

interface PaintedCell {
  text: string;
  tint?: Tint | undefined;
}

/** The last cell is not padded, so no line ends in spaces. */
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

function PaintedText({ text, tint }: PaintedCell): ReactElement {
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

// The value line is painted by what the value says, the age line by its
// staleness, the name by the node's status.
function buildRow(node: NodeState, columns: readonly Column[]): Row {
  const cells = columns.map((column) =>
    node.probes.includes(column.probe) ? column.read(node) : undefined,
  );

  return {
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

/** `ok`, or the first thing wrong in the probe's own words. */
function portsText(view: MetricView): string {
  if (view.ok !== false) return "ok";

  const missing = stringListIn(view.meta, "missing");
  if (missing.length > 0) return `missing ${missing.join(", ")}`;

  const undeclared = stringListIn(view.meta, "undeclared");
  if (undeclared.length > 0) return `extra ${undeclared.join(", ")}`;

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
