import { execFile } from "node:child_process";
import { z } from "zod";
import {
  ALIAS,
  authorizeScript,
  destinationIn,
  hostKeysIn,
  installScript,
  KEY_SCRIPT,
  NO_HOST_KEY_EXIT,
  type NodeAccess,
  type PublicKey,
  publicKeyIn,
  type Verified,
  verifiedIn,
} from "../access-scripts";
import { UsageError } from "../exit-code";
import { notOnPathMessage, quoteForShell, runOverSsh } from "../remote-command";
import { lastLine } from "../tunnel";

interface SetupAccessOptions {
  /** The ssh host `serve` runs on, from cli.yaml. */
  remote: string;
  /** Only these; every node with an ssh alias when empty. */
  nodes: readonly string[];
  print: (line: string) => void;
}

const TargetsSchema = z
  .object({
    nodes: z.array(
      z.object({ node: z.string(), alias: z.string().optional() }).strict(),
    ),
  })
  .strict();

// A login script waiting for input would hold a step forever.
const STEP_TIMEOUT_MS = 30_000;

const OK = "ok";

type Target = z.infer<typeof TargetsSchema>["nodes"][number];

/**
 * Gives the collector on `remote` its own ssh access to its nodes, through
 * the access this machine has: its key in each node's authorized_keys,
 * each node's host keys and Host block beside it. Prints a line a node,
 * in the config's order.
 */
export async function runSetupAccess(
  options: SetupAccessOptions,
): Promise<void> {
  const { remote, print } = options;
  const targets = chosen(await askForTargets(remote), options.nodes, remote);
  const key = await collectorKey(remote);
  print(
    `giving ${remote} access to ${targets.map((target) => target.node).join(", ")}`,
  );

  const outcomes = new Map<string, string>();
  const reached: { node: string; access: NodeAccess }[] = [];

  for (const { node, alias } of targets) {
    if (alias === undefined || !ALIAS.test(alias)) {
      outcomes.set(
        node,
        "`ssh:` must name a Host from ~/.ssh/config (letters, digits, . _ -) " +
          "for it to be set up",
      );
      continue;
    }
    const access = await reachFromHere(alias, key, remote);
    if (typeof access === "string") outcomes.set(node, access);
    else reached.push({ node, access });
  }

  const verified =
    reached.length === 0
      ? []
      : await install(
          remote,
          reached.map((entry) => entry.access),
        );
  for (const { node, access } of reached) {
    const result = verified.find((entry) => entry.alias === access.alias);
    outcomes.set(node, loginFailure(remote, access, result) ?? OK);
  }

  for (const { node } of targets) print(`${node}: ${outcomes.get(node)}`);

  const failed = [...outcomes.values()].filter((line) => line !== OK).length;
  if (failed > 0) {
    throw new UsageError(`${failed} of ${targets.length} nodes not set up`);
  }
}

async function askForTargets(remote: string): Promise<Target[]> {
  const command = "ephor access-targets";
  const result = await runOverSsh({
    remote,
    command,
    timeoutMs: STEP_TIMEOUT_MS,
  });
  const said = lastLine(result.stderr) ?? `exit code ${result.code}`;

  if (result.timedOut) throw new UsageError(noAnswer(`\`${command}\``, remote));
  if (result.code === 255) {
    throw new UsageError(`cannot reach ${remote} over ssh: ${said}`);
  }
  if (result.code === 127) throw new UsageError(notOnPathMessage(remote, said));
  if (said.includes("unknown command 'access-targets'")) {
    throw new UsageError(
      `ephor on ${remote} is older than this one: update it there (npm i -g ephorate)`,
    );
  }
  if (result.code !== 0) throw new UsageError(`on ${remote}: ${said}`);

  try {
    return TargetsSchema.parse(JSON.parse(lastLine(result.stdout) ?? "")).nodes;
  } catch {
    throw new UsageError(
      `\`${command}\` on ${remote} answered something else than its nodes: ` +
        "is ephor there as new as here?",
    );
  }
}

function chosen(
  targets: Target[],
  names: readonly string[],
  remote: string,
): Target[] {
  if (names.length === 0) {
    if (targets.length === 0) {
      throw new UsageError(
        `no node in the config on ${remote} has \`ssh:\`: nothing to set up`,
      );
    }
    return targets;
  }

  const unknown = names.filter(
    (name) => !targets.some((target) => target.node === name),
  );
  if (unknown.length > 0) {
    throw new UsageError(
      `not a node with \`ssh:\` in the config on ${remote}: ${unknown.join(", ")}`,
    );
  }
  return targets.filter((target) => names.includes(target.node));
}

async function collectorKey(remote: string): Promise<PublicKey> {
  const result = await runOverSsh({
    remote,
    command: `sh -c ${quoteForShell(KEY_SCRIPT)}`,
    timeoutMs: STEP_TIMEOUT_MS,
  });
  const key = result.code === 0 ? publicKeyIn(result.stdout) : undefined;

  if (result.timedOut) {
    throw new UsageError(noAnswer("the key script", remote));
  }
  if (key === undefined) {
    throw new UsageError(
      `cannot make or read ephor's ssh key on ${remote}: ${
        lastLine(result.stderr) ?? `exit code ${result.code}`
      }`,
    );
  }
  return key;
}

/** This machine's way to the node: its address there, its key let in. */
async function reachFromHere(
  alias: string,
  key: PublicKey,
  remote: string,
): Promise<NodeAccess | string> {
  const destination = destinationIn(await sshG(alias));
  if (destination === undefined) return "`ssh -G` here gave no address";

  const result = await runOverSsh({
    remote: alias,
    command: `sh -c ${quoteForShell(authorizeScript(key, `ephor@${remote}`))}`,
    timeoutMs: STEP_TIMEOUT_MS,
  });
  const said = lastLine(result.stderr) ?? `exit code ${result.code}`;

  if (result.timedOut) return noAnswer("the key script", alias);
  if (result.code === 255) return `cannot reach it over ssh from here: ${said}`;
  if (result.code === NO_HOST_KEY_EXIT) {
    return "no readable host key in /etc/ssh to trust it by: nothing changed";
  }
  if (result.code !== 0) return `could not let ${remote}'s key in: ${said}`;

  const hostKeys = hostKeysIn(result.stdout);
  if (hostKeys.length === 0) return "no host key came back to trust it by";

  return { alias, destination, hostKeys };
}

async function install(
  remote: string,
  reached: readonly NodeAccess[],
): Promise<Verified[]> {
  const result = await runOverSsh({
    remote,
    command: `sh -c ${quoteForShell(installScript(reached))}`,
  });
  if (result.code === 255) {
    throw new UsageError(
      `lost the ssh link to ${remote} while it logged in to the nodes: ` +
        "run setup-access again",
    );
  }
  if (result.code !== 0) {
    throw new UsageError(
      `cannot write ssh's files on ${remote}: ${
        lastLine(result.stderr) ?? `exit code ${result.code}`
      }`,
    );
  }
  return verifiedIn(result.stdout);
}

// ssh's words are English whatever the locale: OpenSSH has no gettext.
function loginFailure(
  remote: string,
  access: NodeAccess,
  result: Verified | undefined,
): string | undefined {
  if (result === undefined) return `${remote} did not report a login`;
  if (result.code === 0) return undefined;

  const { hostname, port } = access.destination;
  if (/timed out/i.test(result.said)) {
    return (
      `${remote} cannot reach ${hostname}:${port}: does a firewall on the ` +
      `node let ${remote} in? (${result.said})`
    );
  }
  if (result.said.includes("Permission denied")) {
    return `the node refused ${remote}'s key: ${result.said}`;
  }
  return `${remote} cannot log in: ${result.said}`;
}

function noAnswer(what: string, host: string): string {
  return (
    `no answer from ${what} on ${host} within ${STEP_TIMEOUT_MS / 1000} s: ` +
    "does a login script there wait for input?"
  );
}

function sshG(alias: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("ssh", ["-G", "--", alias], (error, stdout) =>
      resolve(error === null ? stdout : ""),
    );
  });
}
