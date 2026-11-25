# A4: explicit public endpoints

Public reachability requires named `nodes[].endpoints` and at least one
[target country](../AGENTS.md#reachability-countries).

## Problem and scope

Before A4, reachability took the first public TCP port from `ports` or
defaulted to 443. With `ports: [8443, 443]`, an answering panel on 8443
could stand in for an unreachable VPN on 443. See
[audit A4](../AUDIT.md#a4-implicit-destination-can-probe-the-wrong-service).

Keep three separate concepts:

| Field | Purpose |
| --- | --- |
| `endpoints` | Public entry points that users actually connect to. |
| `ssh` | Management route for the system probe; its port is not a public check. |
| `ports` | Optional inventory for the existing local TCP listener audit, not evidence of external access. The audit is unchanged by A4. |

## Endpoint contract

- One named map, whether there is one entry or several. Each entry has
  exactly one of `tcp`, `https`, or `udp`. `tcp` and `udp` have an explicit
  port (1–65535), even for TCP 443. `https` has an absolute public HTTPS
  URL without credentials or a fragment. Names like `vpn` and `site`
  identify results, not protocols.
- `tcp` uses the node's public `host` and the declared port. Show the
  method, destination, and counts by configured region, e.g.
  **“TCP connections: ru 3/3 reporting points”** when all three
  selected points reported success. Do not say the VPN works.
- `https` uses the public URL as written, including its hostname, port
  if given, and path. Do not use the origin IP, node `domain`, or any
  `ports` entry as a fallback. Report the HTTPS result as observed by the
  provider, not as proof of a VPN handshake or tunnel. If the provider
  refuses the URL, report a measurement error; do not rewrite it or
  try another destination.
- `udp` describes the public `host` and port but is **not measured**
  with the current provider. Show the endpoint and the reason. Send no
  substitute TCP, HTTPS, or ping check for it. Do not treat it as healthy,
  down, or recovered.
- Each enabled node with reachability on needs a nonempty, valid
  `endpoints` map. Missing endpoints produce a config error naming the
  node and showing an example fix. A system-only node needs no endpoint.
  The endpoint selects the method: there is no global `methods` setting
  and no background ping check. Country selection applies to all
  measurable endpoints.
- Keep results separate by endpoint. An unsupported entry cannot erase
  a sibling's measured success or failure, nor count toward an all-healthy
  summary. System metrics are still collected once per node per system
  run, not once per endpoint.
- No provider result is not a failed connection. When some selected
  points report nothing, show coverage separately from success counts.
  Malformed results are measurement errors; a failed retry does not
  overwrite the endpoint's last measured verdict or its timestamp.
  Missing coverage of a required region cannot justify an all-regions
  success or outage. Stale observations are shown in endpoint details
  but do not drive the current reachability summary.
- Keep the name and the checked destination with network evidence. A
  stable name alone is not proof that two checks concern the same target:
  changing host, port, transport, or HTTPS URL must not attach recent
  green results to the replacement or close an incident on the original.
  The summary uses only observations for the current destinations and
  region settings. Adding a required region does not make past results
  evidence from that region. An unchanged endpoint keeps its observation
  and age after edits to siblings. History in SQLite is not rewritten.
  Regional metrics are named `reachability.endpoint.<name>.<region>.tcp`
  or end in `.http` for HTTPS; ratios use reporting points. The last
  measured verdict is stored as `reachability.endpoint.<name>.verdict`;
  failed attempts go to `reachability.endpoint.<name>.attempt`, even
  when every endpoint fails. A node-level reachability threshold must
  name a metric for that node's endpoint; global thresholds can name
  endpoint metrics from the fleet.
  The node's summary is derived from its endpoint results. The future
  incident journal is separate.

## Examples

Use this `probes` block with **one** of the `nodes` examples. Ephor
reports RU, DE and NL separately, but starts one check-host job per
measurable endpoint. `system` is enabled only on the second example's
node, where `ssh` is configured.

```yaml
probes:
  reachability:
    regions:
      targets: [ru]
      control: [de, nl]
```

### One direct TCP entry

```yaml
nodes:
  - name: direct
    host: 203.0.113.10
    endpoints:
      vpn: { tcp: 443 }
```

Check `203.0.113.10:443` from the configured countries. No `ports` or SSH
settings are needed for this reachability check.

### Two independent entries on one node

```yaml
nodes:
  - name: mixed
    host: 203.0.113.20
    ssh: { user: monitor, port: 2222 }
    ports: [8443, 443, 2222]
    probes:
      system: {}
    endpoints:
      vpn: { tcp: 443 }
      site: { https: "https://vpn.example.com/" }
```

Show `vpn` at `203.0.113.20:443` and `site` at the public CDN URL
separately. The panel on 8443 is not a reachability destination.
System metrics are collected over SSH on 2222, with `ports` used only
by the existing local listener audit. Reordering `ports` does not
change either reachability check.

### UDP-only entry

```yaml
nodes:
  - name: udp-only
    host: 198.51.100.10
    endpoints:
      amneziawg: { udp: 51820 }
```

Show `amneziawg · UDP 198.51.100.10:51820 · not measured: UDP checks are
not supported`. No external check is sent for that entry; there is
no TCP/443 fallback.

## Updating an older config

There is no legacy mode: a node with reachability enabled must have an
explicit endpoint before `serve` or `check` accepts its config. Remove
the old global `methods` and node `domain` keys. Keep `ssh` and `ports`
unchanged unless you also intend to change the system probe.

Replace grouped regions with country lists: flatten old required groups'
`match` lists into `targets` and old optional groups' lists into
`control`. Keep each country in only one list. The old
`match: [de, nl], count: 3` selected up to three points across two
countries; `control: [de, nl]` measures and reports them separately.
There is no old `count` setting. Rules for country-specific thresholds
now name a country (e.g. `.de.tcp`, not a custom `.eu.tcp` group).

| Old configuration | What to write now |
| --- | --- |
| No `ports`, and the actual entry is TCP/443 | `endpoints: { vpn: { tcp: 443 } }`. |
| `ports: [8443, 443]` | Declare the actual user entry port, not the first listener. If 8443 is a panel and users connect on 443, specify `tcp: 443`; if users really enter on 8443, specify `tcp: 8443`. |
| UDP-only | Declare the UDP entry, e.g. `endpoints: { vpn: { udp: 51820 } }`. It is shown as unmeasured. |
| A node checked by HTTPS using `domain` | Move the actual public URL into `endpoints`, e.g. `endpoints: { site: { https: "https://vpn.example.com/" } }`. |
| System only | Leave reachability off for the node; no `endpoints` is needed. |
