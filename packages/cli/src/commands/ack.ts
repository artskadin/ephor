import {
  type Acknowledgement,
  type AcknowledgeRequest,
  AcknowledgeRequestSchema,
} from "@ephorate/core";
import type { ApiClient } from "../api-client";
import { UsageError } from "../exit-code";

const FLAG_BY_FIELD: Readonly<Record<string, string>> = {
  note: "--note",
  duration: "--for",
  untilOk: "--until-ok",
};

/** The daemon's own schema, so a typo is refused before any request. */
export function acknowledgeRequestFrom(flags: {
  note?: string | undefined;
  for?: string | undefined;
  untilOk?: boolean | undefined;
}): AcknowledgeRequest {
  const parsed = AcknowledgeRequestSchema.safeParse({
    ...(flags.note === undefined ? {} : { note: flags.note }),
    ...(flags.for === undefined ? {} : { duration: flags.for }),
    ...(flags.untilOk ? { untilOk: true } : {}),
  });

  if (!parsed.success) {
    throw new UsageError(
      parsed.error.issues
        .map((issue) => {
          const field = issue.path[0];
          const flag = field === undefined ? "the request" : String(field);
          return `${FLAG_BY_FIELD[flag] ?? flag}: ${issue.message}`;
        })
        .join("; "),
    );
  }

  return parsed.data;
}

interface AckOptions {
  client: Pick<ApiClient, "acknowledge" | "unacknowledge">;
  node: string;
  /** Absent: remove the node's acknowledgement instead of storing one. */
  request?: AcknowledgeRequest | undefined;
  json: boolean;
  print: (line: string) => void;
}

/** Returning is the whole answer; anything else is thrown and exits 2. */
export async function runAck(options: AckOptions): Promise<void> {
  const { client, node, request } = options;

  const answer =
    request === undefined
      ? await client.unacknowledge(node)
      : await client.acknowledge(node, request);

  if (options.json) {
    options.print(JSON.stringify(answer, null, 2));
    return;
  }

  const { acknowledgement } = answer;

  if (acknowledgement === null) {
    options.print(`${node} had no acknowledgement`);
  } else if (request === undefined) {
    options.print(
      `cleared the acknowledgement of ${node} (${acknowledgement.status})` +
        noteText(acknowledgement),
    );
  } else {
    options.print(storedText(acknowledgement));
  }
}

function storedText(acknowledgement: Acknowledgement): string {
  const lasting = acknowledgement.untilOk
    ? "until it is ok"
    : "until its status changes";
  const end =
    acknowledgement.until === undefined
      ? ""
      : `, ${exactDuration(acknowledgement.until - acknowledgement.since)} at most`;

  return (
    `acknowledged ${acknowledgement.node} (${acknowledgement.status}) ` +
    `${lasting}${end}${noteText(acknowledgement)}`
  );
}

// Every unit, not core's rounded age: `--for 90m` must not read as `1h`.
function exactDuration(seconds: number): string {
  const parts: string[] = [];
  let rest = seconds;

  for (const [unit, size] of [
    ["d", 86_400],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ] as const) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count > 0) parts.push(`${count}${unit}`);
  }

  return parts.length > 0 ? parts.join(" ") : "0s";
}

function noteText(acknowledgement: Acknowledgement): string {
  return acknowledgement.note === undefined ? "" : `: ${acknowledgement.note}`;
}
