# Ephor: developer entry point

Ephor monitors self-hosted VPN nodes. Its main question is: **can networks
in the users' region reach the public entry point?** A successful TCP
connection is not a successful VPN handshake or tunnel. A provider's
datacentre points are samples, not proof that every residential ISP works.
SSH management access and public reachability are separate signals.

## First release and next change

- First fix: [A1: missing required region](AUDIT.md#a1-missing-required-region-can-yield-ok).
  With RU and KZ required, successful RU and control EU readings do not
  justify `ok` when KZ has no readings. A measured KZ timeout in the same
  case still means `partial`. Keep this fix separate from the journal and
  config design. See the [dated code audit](AUDIT.md) for other findings.
- First release: continuous monitoring with understandable setup and a
  persistent journal for **network and system incidents**, even when
  `watch` is closed. A failed measurement is not a measured outage.
- Active `speed` is desirable, but its value, accuracy and traffic cost
  need a separate assessment before choosing a release. Explicit `targets`,
  `requestFrom` and `config explain` are proposals, not supported features.

## What works in this checkout

- `ephor serve` schedules `system` and `reachability`, stores measurements
  in SQLite and serves a bearer-authenticated HTTP API (default
  `127.0.0.1:31556`). Inventory comes from YAML; edits take effect on
  restart. Metric history and acknowledgements are not an incident journal.
- `system` reads Linux load, memory, disk, TCP listeners and passive
  interface traffic via SSH, or locally with `local: true`. No agent to
  install on nodes. Without `ports`, listeners are informational; with it,
  the audit compares local TCP listeners, not what the firewall exposes.
  `bandwidth` adds utilization percentages, not an active speed test.
- `reachability` needs no node login. The collector requests checks from
  check-host; the provider's external points make the actual connections.
  TCP uses the first declared public TCP port, otherwise 443, even on an
  explicitly UDP-only list (see [A4](AUDIT.md#a4-implicit-destination-can-probe-the-wrong-service)).
  Methods are global: TCP wins over HTTP, then ping, among methods with
  readings in a region. For a CDN, use the public `domain` with global
  `methods: [http]`; no UDP or VPN protocol handshake is implemented.
- `status` shows a snapshot; `watch` shows the live table and can send
  desktop notifications while it runs. `ack` can suppress covered changes
  without changing the node's state. The collector keeps collecting without
  `watch`, but does not deliver unattended alerts.
- `check [node] [--probe names | --skip names]` forces probes via `serve`,
  or runs once with in-memory storage when there is no daemon. With a
  configured SSH remote, a no-daemon check runs there, not on the laptop.
  `init`, `init --remote`, `setup-access` and Linux `service
  install|uninstall` exist; remote setup requires a trusted collector.
- No `node`, `history`, or `events` CLI commands. SQLite metric history
  and the API do not provide an incident journal.

## Core concepts

| Term | Meaning |
|---|---|
| Node | A monitored server |
| Probe | A kind of measurement: `system` or `reachability` |
| Task | One run of one probe against one node |
| Vantage | An external location a reachability check is made from |
| Region | A named group of vantages, e.g. `ru`, `eu` |
| Verdict | `ok`, `blocked`, `down`, `partial`, `unknown` |

`required: false` defines a control region. Comparing regions distinguishes
regional failure from a failure also seen by controls; it does not establish
the cause. A single control region does not need to represent all of Europe.

```
RU 0/4   EU 3/3   →  blocked      RU 2/4   EU 3/3   →  partial
RU 0/4   EU 0/3   →  down         RU 4/4   EU 3/3   →  ok
```

These counts are selected points for the decisive method, not a census.
RU 3/4 is `partial`; a measured timeout is not an absent region. An
absent required region currently can be mistaken for adequate coverage
([A1](AUDIT.md#a1-missing-required-region-can-yield-ok)).

## Architecture

- [`packages/core`](packages/core): `@ephorate/core`; schema and resolution,
  verdict, node state, API shapes and async storage contract. No SQLite,
  SSH or network I/O.
- [`packages/collector`](packages/collector): `@ephorate/collector`;
  registry, scheduler (what is due), executor (what runs), Linux and
  check-host probes, SQLite and migrations, pruner and Fastify API.
  Start in [`serve.ts`](packages/collector/src/serve.ts) or
  [`collector.ts`](packages/collector/src/collector.ts).
- [`packages/cli`](packages/cli): `ephorate` is the package intended for
  publication; the binary is `ephor`. Start in
  [`src/index.ts`](packages/cli/src/index.ts). Uses OpenSSH for remote API
  access; tsdown bundles the private packages and loads the heavier
  collector dependencies on demand. [`bin/ephor.js`](packages/cli/bin/ephor.js)
  sets `NODE_ENV` before React loads.

## Invariants to preserve

- The registry builds the strict schema. A probe runs only where a section
  is written (including blank YAML), unless disabled or lacking its
  executor. A node can override enablement and timing; reachability-specific
  methods and regions are global. A config with no runnable probe anywhere
  is refused. `probeDefaults` does not enable or schedule probes.
- Use typed `ProbeOutcome` for expected failures. Every finished run writes
  `<probe>.up`, including failure. `system.up: false` is a warning about the
  measurement, not proof of a public outage. No implicit numeric thresholds.
- `buildNodeState` uses currently declared metrics, not old settings'
  leftovers. Scheduled values go stale after twice their interval; stale
  reachability does not count as a current verdict. Order:
  `critical > stale > warn > unknown > ok`. Verdict and node state are not
  interchangeable: system metrics can worsen the latter.
- `metrics_latest` and history update in the same transaction. The
  separate table keeps state reads independent of history size: an earlier
  10M-row trial measured about 1 ms instead of 13.8 s. The API reports the
  collector's clock. Forced checks wait for their own tasks;
  after the API wait cap the client polls rather than forcing them again.
  Command exit codes are `0` for an answer, `2` for a tool error;
  monitored problems are in the answer, not the exit code.
- Inventory and database belong on the collector. Config path:
  `--config` where supported, then `EPHOR_CONFIG`, then
  `~/.config/ephor/config.yaml` (`XDG_CONFIG_HOME` or Windows `APPDATA`
  applies). `serve` uses `EPHOR_TOKEN` or the adjacent `token` file;
  clients prefer `EPHOR_API_URL`, then remote `cli.yaml`, then loopback.
  `EPHOR_TOKEN` overrides the selected file token.

## Verify before handing off a change

Use Node 24+ and the pnpm version in [package.json](package.json).
Start with `git status --short --branch`; use `codegraph explore` before
grep/file reads when `.codegraph/` exists. Do not index on your own.

```sh
pnpm build
pnpm test
pnpm exec biome check .
node packages/cli/bin/ephor.js --help
pnpm --filter @ephorate/collector exec tsx scripts/check-config.ts ../../examples/config.example.yaml
```

Run the first three in order: binary tests load the fresh bundle. The last
two are offline CLI/schema checks; the config command validates but does
not run probes. Verify the changed path and an error case against fixtures
using the actual schema, fake SSH/provider or loopback servers. For A1
start at [the verdict tests](packages/core/src/reachability/tests/verdict.test.ts).
Never use the maintainer's live config as a fixture; no production
connections, configuration changes or generated traffic without explicit
permission. Use documentation IP ranges in examples.

## Conventions

### TypeScript

Strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`: optional
fields assigned `undefined` need `field?: T | undefined`; build objects
conditionally, never `x: x ?? undefined`; array access is `T | undefined`.
`verbatimModuleSyntax`: `import type`. `moduleResolution: bundler`, one
root `tsconfig.json`, `noEmit`: relative imports carry no extension, and
nothing runs without a bundler or a TypeScript-aware runner (tsdown,
vitest, tsx). The private packages point `main`/`exports` at `src`.
Functions returning a discriminated union declare the return type.

### Zod

Every object schema `.strict()`. Types via `z.infer`, never hand-written.
`.default()` on an all-defaulted object needs `.prefault({})`. Neither
fires on `null` (a blanked YAML section): wrap with `optionalSection`.
Shorthands (`ssh: vpn-admin`, `ports: [443]`) are unions in the schema;
the long form must express everything.

### Code style

- `interface` for the shape of an object; `type` for everything else:
  unions, function types, `z.infer`, derived types.
- Export only what another file imports. Options and deps types of a
  class stay unexported; TypeScript still emits them in `.d.ts`. An export
  kept only for a test is tolerated where the test would be worse without
  it: fakes, limits, descriptors, parsers (`FakeClock`, `SSH_TOTAL_LIMIT`,
  `systemProbeDescriptor`, `parseSshOptions`).
- `index.ts` of `core` lists what `collector` and `cli`, tests included,
  import, nothing more.
- Comments: the code says what; a comment says only what the code cannot
  (a constraint, a measured number, a pitfall), one to three lines, under
  80 columns (biome does not wrap them). Give a measured constraint its
  own context; do not rely on a private note.
- Names say what a thing is or does (`buildRow`, `queueState`,
  `hostWithPort`); a boolean is a question or a state (`isStale`,
  `canRun`); no abbreviations (`context`, not `ctx`), no one-letter
  lambdas, no `xOf` helper that needs a comment. Test helpers may be terse
  (`stateOf(config, points)`). Code, comments, strings, commits in English.
- One word never names two things in one scope: use `resolvedProbe`,
  `probeName`, and `probe` for config, name and implementation, not
  `settings.settings`. Arrays of names and counts say so
  (`probeNamesToRun`, `checkedNodeCount`).
- Commit messages: one line, `type(scope): what`.

### Testing

Vitest, `tests/` beside the code, on the sources. Run `tsc` and `vitest`
both, and **bundle before testing**: the client's binary tests run
`bin/ephor.js`, which loads `build/`.
`Clock`, `CommandExecutor`, `HttpRequester` are seams; test the default of
every injected dependency too. Assert from the contract, not the code.
Build inputs from reality (a real `ENOENT`, a real ssh failure, the real
descriptors). Run the real entry point, with wrong input too. Assert the
property, not a tuned number. Injected time and sleep move together.

## Working agreements

The maintainer is a TypeScript developer learning systems and networking.
Answer in Russian; code, comments and commits in English.

- Explain why, name the alternative and why it lost. Distinguish
  "documented" from "my inference". Explain an unfamiliar term at once on
  an example from this project.
- Do not agree out of politeness: a bad idea gets a concrete failure
  scenario; if reaffirmed, do it and record the objection.
- Loud over survivable, never at the cost of the daemon.
- Measure, do not estimate (ssh and reachability estimates were off 3–5×).
  Verify external tools by running them. "Should work" means go and check.
- Do not re-propose what this file rejects without saying what changed.
  Do not strengthen the maintainer's ideas when writing them down. Numbers
  in comments go stale: when one is corrected, find every use. Agreed but
  not done goes into the plan.
- Agree the scope of one small commit, edit only that, show it, wait.
  Preserve user changes, including untracked/ignored files. Report actual
  verification results and limitations.
- Before every commit, arrange one independent review with a narrow file
  list unless the maintainer is running it separately; address findings.
  Do not commit: show the diff as a file (including new files) and the
  one-line message; the maintainer commits.
- Existing code is not a constraint when it turns out to be wrong.
