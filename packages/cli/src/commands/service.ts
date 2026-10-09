import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, posix, resolve } from "node:path";
import { UsageError } from "../exit-code";
import { tokenPath } from "../token";
import { accepts } from "../tunnel";
import { apiPortIn } from "./api-access";

interface ServiceOptions {
  configPath: string;
  /** The node running this and ephor's own script: what systemd starts. */
  nodePath: string;
  scriptPath: string;
  print: (line: string) => void;
}

const SERVICE = "ephor.service";
const MARK = "# Written by `ephor service install`; rewritten when run again.";
const START_WAIT_MS = 15_000;

/**
 * `serve` as a user service: started at boot and after a crash, with no
 * root. A config error (exit 2) is not retried: it would fail every 10 s.
 * Its log goes to a file: measured on Debian 12, a user's services log
 * into the system journal, which only root and `adm` can read.
 */
export function unitText(options: {
  nodePath: string;
  scriptPath: string;
  configPath: string;
  logPath: string;
}): string {
  return [
    MARK,
    "[Unit]",
    "Description=ephor collector (ephor serve)",
    "",
    "[Service]",
    `ExecStart=${quoteForCommand(options.nodePath)} ${quoteForCommand(options.scriptPath)} serve`,
    `Environment=${quoteForUnit(`EPHOR_CONFIG=${options.configPath}`)}`,
    "Restart=on-failure",
    "RestartSec=10",
    "RestartPreventExitStatus=2",
    `StandardOutput=append:${options.logPath.replaceAll("%", "%%")}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

// `%` is a specifier in every line. Measured: `Environment=` keeps `$`
// as written, `ExecStart=` reads it as a variable, so only there doubled.
function quoteForUnit(text: string): string {
  const escaped = text
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%");
  return `"${escaped}"`;
}

function quoteForCommand(text: string): string {
  return quoteForUnit(text).replaceAll("$", "$$$$");
}

/** The user manager's own environment: a `.bashrc` export is not in it. */
type ManagerEnvironment = ReadonlyMap<string, string>;

function unitPath(manager: ManagerEnvironment): string {
  const configHome =
    manager.get("XDG_CONFIG_HOME") || posix.join(homedir(), ".config");
  return posix.join(configHome, "systemd/user", SERVICE);
}

function logPath(manager: ManagerEnvironment): string {
  const stateHome =
    manager.get("XDG_STATE_HOME") || posix.join(homedir(), ".local/state");
  return posix.join(stateHome, "ephor/serve.log");
}

export async function runServiceInstall(
  options: ServiceOptions,
): Promise<void> {
  const { print } = options;
  const manager = await requireSystemd();
  // The service starts in the home directory: a relative path would move.
  const configPath = resolve(options.configPath);

  // npx's cache is cleared at will, and the service would fail every 10 s.
  if (options.scriptPath.includes("/_npx/")) {
    throw new UsageError(
      "this ephor runs from npx's cache, which can vanish under the " +
        "service: `npm i -g ephorate`, then `ephor service install`",
    );
  }

  if (!existsSync(configPath)) {
    throw new UsageError(
      `no config at ${configPath}: run \`ephor init\` here first`,
    );
  }
  // The service has no shell: an EPHOR_TOKEN exported here never reaches it.
  const token = tokenPath(configPath);
  if (!existsSync(token)) {
    throw new UsageError(
      `no token file at ${token}, and the service cannot see EPHOR_TOKEN: ` +
        "run `ephor init` here to write one",
    );
  }

  const path = unitPath(manager);
  refuseForeign(path);

  const port = apiPortIn(configPath);
  const wasActive = (await systemctl("is-active", SERVICE)).stdout.trim();
  if (wasActive !== "active" && (await accepts(port))) {
    throw new UsageError(
      `something already listens on 127.0.0.1:${port}: an \`ephor serve\` ` +
        "started by hand? Stop it first, the service starts its own",
    );
  }

  // `append:` takes the rest of the line as the path: no quoting there.
  const log = logPath(manager);
  if (/\s/.test(log)) {
    throw new UsageError(
      `the service's log would be ${log}: systemd takes no whitespace in that path`,
    );
  }
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, unitText({ ...options, configPath, logPath: log }), {
    mode: 0o644,
  });

  for (const step of [
    ["daemon-reload"],
    ["enable", SERVICE],
    ["restart", SERVICE],
  ]) {
    const result = await systemctl(...step);
    if (result.code !== 0) {
      throw new UsageError(
        `systemctl --user ${step.join(" ")} failed: ${result.stderr.trim()}`,
      );
    }
  }

  if (!(await isServing(port))) {
    const lines = existsSync(log)
      ? readFileSync(log, "utf8").trimEnd().split("\n").slice(-15)
      : [];
    for (const line of lines) print(`  ${line}`);
    throw new UsageError(
      `${SERVICE} did not start: the last lines of ${log} are above`,
    );
  }

  print(`${path}: written`);
  print(
    `ephor serve runs as a service, API on 127.0.0.1:${port}; restarted ` +
      "after a crash, started on boot",
  );
  print(await lingerLine());
  print("");
  print(`  its log            tail -f ${log}`);
  print("  after an upgrade   systemctl --user restart ephor");
  print(
    "  stop it            systemctl --user stop ephor   (until the next boot)",
  );
  print("  remove it          ephor service uninstall");
}

export async function runServiceUninstall(
  options: Pick<ServiceOptions, "print">,
): Promise<void> {
  const { print } = options;
  const manager = await requireSystemd();

  const path = unitPath(manager);
  if (!existsSync(path)) {
    print(`no ${path}: no ephor service here, nothing to remove`);
    return;
  }
  refuseForeign(path);

  const disabled = await systemctl("disable", "--now", SERVICE);
  if (disabled.code !== 0) {
    throw new UsageError(
      `systemctl --user disable --now ${SERVICE} failed, nothing removed: ` +
        disabled.stderr.trim(),
    );
  }
  rmSync(path);
  await systemctl("daemon-reload");
  // A unit that ended failed stays listed after its file is gone.
  await systemctl("reset-failed", SERVICE);

  print(`${SERVICE} stopped and removed; its log stays: ${logPath(manager)}`);
  print(
    "linger is left as it is: `loginctl disable-linger` if nothing else of " +
      "yours needs to run while you are logged out",
  );
}

async function requireSystemd(): Promise<ManagerEnvironment> {
  if (process.platform !== "linux") {
    throw new UsageError(
      "`ephor service` needs systemd, which is Linux's: here keep " +
        "`ephor serve` running another way (a terminal tab, a container)",
    );
  }
  const result = await systemctl("show-environment");
  if (result.code !== 0) {
    throw new UsageError(
      `no systemd user manager for ${userInfo().username} here: ${
        result.stderr.trim() || `exit code ${result.code}`
      }`,
    );
  }

  return new Map(
    result.stdout
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)] as const;
      }),
  );
}

function refuseForeign(path: string): void {
  if (existsSync(path) && !readFileSync(path, "utf8").startsWith(MARK)) {
    throw new UsageError(
      `${path} is not one ephor wrote: move it away to let ephor write its own`,
    );
  }
}

// Running is not serving: a bad config exits after a second or two. A
// crash shows as a restart: measured, `restart` zeroes NRestarts.
async function isServing(port: number): Promise<boolean> {
  const deadline = Date.now() + START_WAIT_MS;
  while (Date.now() < deadline) {
    const state = (await systemctl("is-active", SERVICE)).stdout.trim();
    if (state === "failed" || state === "inactive") return false;
    const restarts = await systemctl(
      "show",
      SERVICE,
      "--property",
      "NRestarts",
      "--value",
    );
    if (Number(restarts.stdout.trim()) > 0) return false;
    if (state === "active" && (await accepts(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

// Without linger a user's services stop with their last login and do not
// start on boot. Debian's polkit lets a user turn it on for themselves.
async function lingerLine(): Promise<string> {
  const user = userInfo().username;
  const shown = await run("loginctl", [
    "show-user",
    user,
    "--property",
    "Linger",
    "--value",
  ]);
  if (shown.stdout.trim() === "yes") return "linger: already on";

  const enabled = await run("loginctl", ["enable-linger", user]);
  if (enabled.code === 0) {
    return "linger: on, so it runs while you are logged out and starts on boot";
  }
  return (
    `linger is off and could not be turned on (${enabled.stderr.trim()}): ` +
    `the service stops when you log out. Ask an admin: sudo loginctl enable-linger ${user}`
  );
}

function systemctl(...args: string[]) {
  return run("systemctl", ["--user", ...args]);
}

function run(
  command: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, (error, stdout, stderr) => {
      const code =
        error === null ? 0 : typeof error.code === "number" ? error.code : 127;
      resolve({ code, stdout, stderr: stderr || (error?.message ?? "") });
    });
  });
}
