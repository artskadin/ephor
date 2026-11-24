# Ephor code audit

Reviewed 2026-11-24 on `main` at
`8913837fcb248c1d3dc2e65215278ecb76a0c572`. This records evidence against
that code. A1 is the first agreed code change; the remaining findings are
not a delivery order.

## Reproduced offline on the reviewed revision

These are direct calls into the current TypeScript sources, with fixture
addresses and an injected provider/requester where needed. No production
nodes, SSH sessions to real nodes, or live check-host calls were used.

### A1. Missing required region can yield `ok`

**Observed:** `summarize` with required `[ru, kz]`, passing TCP readings
from RU and control EU, and no KZ reading returns `ok`. Repeating with an
actual KZ TCP timeout instead of the missing reading returns `partial`.

**Code:** [`verdict.ts`](packages/core/src/reachability/verdict.ts#L55-L92)
creates region summaries only for regions with readings.
[`decideVerdict`](packages/core/src/reachability/verdict.ts#L127-L154)
checks `every` on that observed subset; it never checks that KZ is present.

**Acceptance:** a regression test in
[`verdict.test.ts`](packages/core/src/reachability/tests/verdict.test.ts)
exercises exactly this case and fails on the old `ok`; `unknown` is the
proposed result. A real KZ timeout with RU and EU succeeding stays
`partial`. Existing complete-coverage and measured partial cases still
pass. Do not invent a KZ failure reading or change provider semantics
in this fix.

### A2. Node without runnable probes can look healthy

**Observed:** global `system` only, one SSH-capable node and one without
SSH or `local: true`. The config parses; for the second node,
`buildNodeState` returns `status: "ok"`, `probes: []`, `metrics: []`,
`reasons: []` and `reachability: null`.

**Code:** [config resolution](packages/core/src/config/resolve.ts#L61-L99)
disables probes without their executor. The
[node state fold](packages/core/src/state/node-state.ts#L139-L173)
starts at `ok` and has no enabled probe to change it.

**Acceptance:** an enabled node with no runnable probes is explicitly
unmeasured, not green, with a reason the operator can act on. Cover the
mixed inventory in a contract test; do not break documented behavior for
a node with a runnable probe that simply has not returned yet.

### A3. Malformed provider TCP result counts as success

**Observed:** a fake check-host result containing `[{}]` for one selected
point yields a TCP reading with `ok: true` and no RTT.

**Code:** [`parseTcp`](packages/collector/src/reachability/check-host-provider.ts#L274-L295)
accepts an object without `error` even when it has no valid success data.

**Acceptance:** a provider fixture with this shape cannot add a passing
point. Preserve valid success with RTT and a valid reported timeout;
distinguish invalid provider evidence from a measured service failure.

### A4. Implicit destination can probe the wrong service

**Observed:** the schema accepts `ports: [8443, 443]`; a fake provider
receives TCP port 8443 even if that is a panel and users enter on 443.
An explicitly public UDP-only entry on 51820 sends TCP to 443. The schema
rejects node-level `probes.reachability.methods: [http]`, so a single
config cannot select different methods for direct TCP and CDN nodes.

**Code:** [`publicTcpPort`](packages/collector/src/probes/reachability/reachability-probe.ts#L183-L189),
[provider request target](packages/collector/src/reachability/check-host-provider.ts#L184-L196)
and [per-node probe schema](packages/core/src/config/schema.ts#L114-L134).

**Acceptance:** a supported config can select the actual public endpoint
independently of listener order or the SSH route. Fixtures show TCP for
the selected TCP entry, public HTTPS for CDN, and explicit unmeasured
state rather than a TCP fallback for a UDP target. Preserve legacy
destinations or reject an ambiguous migration with a clear remedy.

## Source-review findings (effects not reproduced here)

These are behaviors or missing guards visible in code. No claim is made
that a race, credential exposure, outage or resource failure occurred.

| ID | Code and possible manifestation | Acceptance |
| --- | --- | --- |
| B1 | [`init-remote.ts`](packages/cli/src/commands/init-remote.ts#L136-L163): `cli.yaml` is written before `chmod`; a new file may inherit a permissive mode in an existing directory, and an interrupted replacement can leave incomplete YAML. | Create privately from the first write and replace atomically. With a permissive umask or an interrupted write, a fixture sees no readable intermediate secret and preserves the previous valid file. |
| B2 | [`init-remote.ts`](packages/cli/src/commands/init-remote.ts#L68-L102) reads access settings before copying the config and [uses them afterward](packages/cli/src/commands/init-remote.ts#L132-L168). If a copied config changes `api.port`, the local client file and final probe can point at the old port. | A fake remote that receives a config with a different port leaves `cli.yaml` and final verification using the post-copy port. |
| B3 | [`setup-access.ts`](packages/cli/src/commands/setup-access.ts#L65-L90) uses aliases returned by the collector for [local resolution and provisioning](packages/cli/src/commands/setup-access.ts#L177-L190). [`access-scripts.ts`](packages/cli/src/access-scripts.ts#L12-L21) restricts forwarding and PTY, not commands or account privileges. | Establish an operator-approved destination set independently of the remote reply; an unexpected alias causes no local SSH or key installation. Document the key's actual privileges and verify a least-privilege account can run the probe. |
| B4 | [`ssh-args.ts`](packages/collector/src/execution/ssh-args.ts#L6-L42) assembles configured destinations without a destination delimiter; [SSH route inspection](packages/collector/src/execution/ssh-route.ts) also uses this target builder. Option-like values can cross the destination/option boundary; exact OpenSSH behavior was not exercised. | Reject invalid destinations or pass them as positional-only in both paths; offline argument tests preserve valid alias, user/host and jump forms. |
| B5 | [`tunnel.ts`](packages/cli/src/tunnel.ts#L101-L159) releases a reserved port, then accepts a successful loopback connection as readiness. It does not establish that OpenSSH owns that listener before the client sends credentials. | A fixture for a competing listener fails closed or retries without sending an API token to it. |
| B6 | [Collector check reply](packages/collector/src/check.ts#L84-L102) gives pending node names, not tasks; [the CLI polls for every selected probe on such nodes](packages/cli/src/commands/check.ts#L184-L255). A pair already finished in the baseline response may be incorrectly awaited until a later scheduled run. | With A done and B pending on one node, completion of B ends the check without waiting for A or issuing another POST; cover older collector replies. |
| B7 | [`ReachabilityProbe.run`](packages/collector/src/probes/reachability/reachability-probe.ts#L76-L129) does not pass the configured attempt deadline to [`DirectHttpRequester`](packages/collector/src/reachability/direct-http-requester.ts) or the [provider's polling loop](packages/collector/src/reachability/check-host-provider.ts#L127-L158). The scheduler's [wait estimate](packages/collector/src/scheduling/wait-budget.ts#L48-L57) uses that timeout. A slow request/poll can outlast a short configured attempt. | A slow fake provider/HTTP response honors one end-to-end attempt deadline, including polling, with retries and wait accounting consistent with it. |
| B8 | [`spawn-process.ts`](packages/collector/src/execution/spawn-process.ts#L10-L45) buffers both output streams without a byte bound; the time limit does not cap allocated memory. | A local child with excessive output receives a bounded, typed failure; normal probe output is unchanged. |
| B9 | [`client-config.ts`](packages/cli/src/client-config.ts#L82-L110) permits non-loopback HTTP; [`api-client.ts`](packages/cli/src/api-client.ts#L123-L141) sends a bearer token. Direct remote HTTP does not protect that token in transit. | Refuse unsafe remote plaintext by default (or require explicit opt-in with a warning); cover loopback HTTP, tunneled access and remote HTTPS separately. |
| B10 | The dev-only [read-only MCP helper](tools/mcp/fs-readonly.ts#L140-L157) checks the final basename, not all path components. Directory filtering and direct reads need review against the same privacy rule. It is not in the [npm payload](packages/cli/package.json#L27-L30). | A temporary-tree test exercises denied directories and files, including direct reads and symlinks, and verifies that listing, search and read enforce the same boundary. |

## Risks and validation still open

- **Fleet limits and provider policy:** no verified current check-host
  numerical quota or fleet-capacity result. Before making a capacity
  claim, use a provider double for periodic and forced runs, including
  a failed shared jump route and throttled provider responses. Record
  peak request rate, SSH slots, queue delay and recovery.
- **Coverage ambiguity:** selected points with no provider reply are
  currently counted as failed readings, while an unrepresented region
  has no bucket. Whether/how to report provider trouble or insufficient
  coverage beyond A1 is still a design decision. A multi-node provider
  loss must not appear as confirmed VPN outages in the journal.
- **Deployment and dependencies:** no live deployment, provider benchmark,
  dependency advisory audit, or verification across Windows/Linux/macOS
  for this pass. Use a disposable `sshd`/systemd environment for runtime
  confirmation of SSH/service findings; review production dependency
  advisories separately before publishing.

## Verification log

Fresh for 2026-11-24, Node 24.16.0 / pnpm 11.23.0: `pnpm build`, then
`pnpm test` (63 files, 949 passed), then `pnpm exec biome check .` (178
files). Vitest emitted a `MaxListenersExceededWarning` and non-TTY SSH
notices without failing. The rebuilt binary's `--help` matched command
registration. The tracked example (three nodes) and a minimal
reachability-only fixture parsed against the same registry schema.
No probes were run against either config.
