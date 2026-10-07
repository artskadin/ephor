import { quoteForShell } from "./remote-command";

// Under the collector's ~/.ssh: it and one Include line are all there is
// to remove there; the nodes keep a line in authorized_keys each.
const DIRECTORY = "ephor";
const KEY = `~/.ssh/${DIRECTORY}/id_ed25519`;
const INCLUDE_LINE = `Include ${DIRECTORY}/*.conf`;

/** The node script's exit when no host key can be read: nothing let in. */
export const NO_HOST_KEY_EXIT = 3;

// The probes run a command; nothing else is the collector's to do there.
const KEY_OPTIONS =
  "no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty";

const PUBLIC_KEY = /^(ssh-ed25519) ([A-Za-z0-9+/]+={0,2})(?: .*)?$/;
const HOST_KEY = /^((?:ssh|ecdsa|sk)-[a-z0-9@.-]+) ([A-Za-z0-9+/]+={0,2})/;
const VERIFY_MARK = "ephor-verify";

/** A name for a file and a Host line alike: no path, no pattern. */
export const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The collector's key, made once; prints its public half. */
export const KEY_SCRIPT = [
  "set -e",
  `dir="$HOME/.ssh/${DIRECTORY}"`,
  'mkdir -p "$dir"',
  'chmod 700 "$HOME/.ssh" "$dir"',
  'if [ ! -f "$dir/id_ed25519" ]; then',
  '  ssh-keygen -q -t ed25519 -N "" -C "ephor@$(hostname)" -f "$dir/id_ed25519"',
  "fi",
  'cat "$dir/id_ed25519.pub"',
].join("\n");

export interface PublicKey {
  type: string;
  body: string;
}

/** The last line that is an ed25519 public key: a login banner may come first. */
export function publicKeyIn(stdout: string): PublicKey | undefined {
  for (const line of stdout.trim().split("\n").reverse()) {
    const match = PUBLIC_KEY.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { type: match[1], body: match[2] };
    }
  }
  return undefined;
}

/**
 * Prints the node's own host keys and lets `key` in, once; without a host
 * key to trust the node by, nothing. sshd ignores an authorized_keys others
 * can write: 700 and 600. A commented-out copy does not count as there.
 */
export function authorizeScript(
  key: PublicKey,
  comment: string,
  hostKeys = "/etc/ssh/ssh_host_*_key.pub",
): string {
  const line = `${KEY_OPTIONS} ${key.type} ${key.body} ${comment}`;

  return [
    "set -e",
    `keys=$(cat ${hostKeys} 2>/dev/null) || true`,
    `if [ -z "$keys" ]; then exit ${NO_HOST_KEY_EXIT}; fi`,
    'mkdir -p "$HOME/.ssh"',
    'chmod 700 "$HOME/.ssh"',
    'file="$HOME/.ssh/authorized_keys"',
    'touch "$file"',
    'chmod 600 "$file"',
    // Appended to a last line without its newline, the key would join it.
    'if [ -s "$file" ] && [ -n "$(tail -c 1 "$file")" ]; then echo >> "$file"; fi',
    `if ! grep -v '^[[:space:]]*#' "$file" | grep -qF ${quoteForShell(key.body)}; then`,
    `  printf '%s\\n' ${quoteForShell(line)} >> "$file"`,
    "fi",
    `printf '%s\\n' "$keys"`,
  ].join("\n");
}

export function hostKeysIn(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => HOST_KEY.exec(line.trim()))
    .filter((match) => match !== null)
    .map((match) => `${match[1]} ${match[2]}`);
}

interface SshDestination {
  hostname: string;
  port: number;
  user: string;
}

/** From `ssh -G <alias>`: where this machine's ssh goes for the alias. */
export function destinationIn(sshG: string): SshDestination | undefined {
  const values = new Map<string, string>();
  for (const line of sshG.split("\n")) {
    const [key, ...rest] = line.trim().split(" ");
    if (key !== undefined && !values.has(key)) values.set(key, rest.join(" "));
  }

  const hostname = values.get("hostname");
  const port = Number(values.get("port"));
  const user = values.get("user");
  if (!hostname || !user || !Number.isInteger(port)) return undefined;

  return { hostname, port, user };
}

export interface NodeAccess {
  alias: string;
  destination: SshDestination;
  hostKeys: string[];
}

/** One node's Host block: straight there, with the collector's own key. */
function hostBlock(access: NodeAccess): string {
  const { alias, destination } = access;

  return [
    "# Written by `ephor setup-access`; rewritten on each run.",
    `Host ${alias}`,
    `  HostName ${destination.hostname}`,
    `  Port ${destination.port}`,
    `  User ${destination.user}`,
    `  IdentityFile ${KEY}`,
    "  IdentitiesOnly yes",
    `  UserKnownHostsFile ~/.ssh/${DIRECTORY}/${alias}.known_hosts`,
    "",
  ].join("\n");
}

/** As ssh looks a host up: `[host]:port` off port 22. */
function knownHosts(access: NodeAccess): string {
  const { hostname, port } = access.destination;
  const host = port === 22 ? hostname : `[${hostname}]:${port}`;

  return access.hostKeys.map((key) => `${host} ${key}\n`).join("");
}

/**
 * Each node's files go in place only once the collector logs in with them
 * (ssh -F on the new ones, in parallel): a failed node keeps what it had.
 * Then the Include, first in ~/.ssh/config: after a `Host` line it would
 * belong to that block; written through a symlink, an unreadable one kept.
 */
export function installScript(nodes: readonly NodeAccess[]): string {
  const writes = nodes.flatMap((access) => [
    `printf '%s' ${quoteForShell(hostBlock(access))} > "$dir/${access.alias}.conf.new"`,
    `printf '%s' ${quoteForShell(knownHosts(access))} > "$dir/${access.alias}.known_hosts.new"`,
  ]);
  const aliases = nodes.map((access) => quoteForShell(access.alias)).join(" ");

  return [
    "set -e",
    `dir="$HOME/.ssh/${DIRECTORY}"`,
    'config="$HOME/.ssh/config"',
    "umask 077",
    'if [ -e "$config" ] && [ ! -r "$config" ]; then',
    '  echo "cannot read $config" >&2',
    "  exit 1",
    "fi",
    ...writes,
    "verify() {",
    '  said=$(ssh -F "$dir/$1.conf.new" -o UserKnownHostsFile="$dir/$1.known_hosts.new" \\',
    '    -o BatchMode=yes -o ConnectTimeout=10 -- "$1" true 2>&1 < /dev/null)',
    "  code=$?",
    '  if [ "$code" -eq 0 ]; then',
    '    mv -f "$dir/$1.known_hosts.new" "$dir/$1.known_hosts"',
    '    mv -f "$dir/$1.conf.new" "$dir/$1.conf"',
    "  else",
    '    rm -f "$dir/$1.conf.new" "$dir/$1.known_hosts.new"',
    "  fi",
    `  printf '${VERIFY_MARK} %s %s %s\\n' "$1" "$code" "$(printf '%s' "$said" | tail -n 1)" > "$dir/$1.verified"`,
    "}",
    "set +e",
    `for alias in ${aliases}; do verify "$alias" & done`,
    "wait",
    "set -e",
    `if ! grep -qxF ${quoteForShell(INCLUDE_LINE)} "$config" 2>/dev/null; then`,
    `  printf '%s\\n' ${quoteForShell(INCLUDE_LINE)} > "$dir/config.new"`,
    '  if [ -e "$config" ]; then cat "$config" >> "$dir/config.new"; fi',
    '  cat "$dir/config.new" > "$config"',
    '  rm -f "$dir/config.new"',
    "fi",
    `for alias in ${aliases}; do`,
    '  cat "$dir/$alias.verified" 2>/dev/null || true',
    '  rm -f "$dir/$alias.verified"',
    "done",
  ].join("\n");
}

export interface Verified {
  alias: string;
  code: number;
  said: string;
}

export function verifiedIn(stdout: string): Verified[] {
  return stdout
    .split("\n")
    .filter((line) => line.startsWith(`${VERIFY_MARK} `))
    .map((line) => {
      const [, alias = "", code = "", ...said] = line.split(" ");
      return { alias, code: Number(code), said: said.join(" ") };
    });
}
