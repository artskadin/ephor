// A stand-in for `ssh`, run by tests through a wrapper named `ssh`. With
// -L, like ssh: forwards the local port to the "remote" one (here, this
// machine's), ends when its stdin closes. Without, it runs the command
// here. Fails on a host it cannot reach with ssh's own words and code.
import { connect, createServer } from "node:net";

// The first argument is the wrapper's directory: a mark to find us by.
const args = process.argv.slice(3);
const forward = args[args.indexOf("-L") + 1] ?? "";
const [, localPort, , remotePort] = forward.split(":");
const host = args.at(-2);

if (host === "unreachable.test") {
  process.stderr.write(
    "ssh: Could not resolve hostname unreachable.test: Name or service not known\n",
  );
  process.exit(255);
}

// No -L: a command for the remote, run on this machine. The "remote"
// keeps its config where FAKE_REMOTE_CONFIG says, as a bastion's own.
if (!args.includes("-L")) {
  const { spawnSync } = await import("node:child_process");
  // A login script that talks: some ~/.bashrc echo before any command.
  if (process.env.FAKE_REMOTE_BANNER) {
    process.stdout.write(`${process.env.FAKE_REMOTE_BANNER}\n`);
  }
  const result = spawnSync("/bin/sh", ["-c", args.at(-1) ?? ""], {
    stdio: "inherit",
    env: {
      ...process.env,
      ...(process.env.FAKE_REMOTE_CONFIG
        ? { EPHOR_CONFIG: process.env.FAKE_REMOTE_CONFIG }
        : {}),
    },
  });
  process.exit(result.status ?? 255);
}

// Logged in, never listening: the tunnel never comes up.
if (host !== "silent.test") {
  createServer((socket) => {
    const upstream = connect(Number(remotePort), "127.0.0.1");
    socket.pipe(upstream).pipe(socket);
    // Nothing there: ssh drops the forwarded connection.
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  }).listen(Number(localPort), "127.0.0.1");
}

// As ssh: with a remote command, the end of stdin ends it; with -N, no.
process.stdin.resume();
if (!args.includes("-N")) process.stdin.on("end", () => process.exit(0));
