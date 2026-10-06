// A stand-in for `ssh -L local:127.0.0.1:remote host 'cat > /dev/null'`, run
// by tests through a wrapper named `ssh`. Like ssh: forwards the local port
// to the "remote" one (here, this machine's), ends when its stdin closes,
// and fails on a host it cannot reach with ssh's own words and code.
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

// Logged in, never listening: the tunnel never comes up.
if (host !== "silent.test") {
  createServer((socket) => {
    const upstream = connect(Number(remotePort), "127.0.0.1");
    socket.pipe(upstream).pipe(socket);
    // Nothing there: ssh drops the forwarded connection, as measured.
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  }).listen(Number(localPort), "127.0.0.1");
}

// As ssh: with a remote command, the end of stdin ends it; with -N, no.
process.stdin.resume();
if (!args.includes("-N")) process.stdin.on("end", () => process.exit(0));
