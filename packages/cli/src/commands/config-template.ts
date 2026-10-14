// What `ephor init` writes. Every setting not shown has a default; the
// full reference is examples/config.example.yaml in the repository.
export const CONFIG_TEMPLATE = `# ephor: what the collector measures, read by \`ephor serve\` and
# \`ephor check\` on this machine. Written by \`ephor init\`; edit freely.
# Every setting left out has a default. The full reference, with every
# setting explained: examples/config.example.yaml in the ephor repository.
#
# Check what you wrote at any time: \`ephor check\` reads this file, probes
# every node once and prints the table, or says what is wrong and where.

probes:
  # Asks outside vantage points (check-host.net) whether each node answers:
  # nothing is installed on the nodes, and a dead node is still judged.
  reachability:
    interval: 5m

    # Where your users are. A required region is ok only when every
    # vantage point there reaches the node; the control group, not
    # required, tells a block from an outage:
    #
    #   RU 0/3   EU 3/3   ->  blocked   (filtered there, the server is fine)
    #   RU 0/3   EU 0/3   ->  down      (the server is gone)
    #   RU 2/3   EU 3/3   ->  partial   (some operators filter it)
    #   RU 3/3   EU 3/3   ->  ok
    #
    # \`match\`: country codes, lowercase, as check-host names its points.
    # \`count\`: how many to ask, at most what check-host has there (on
    # 2026-10-05: ru 3, de 3, nl 2, fi 1).
    regions:
      ru:
        match: [ru]
        count: 3
        required: true
      eu:
        match: [de, nl, fi]
        count: 3
        required: false

  # Load, memory, disk and listening ports, read over ssh. Only nodes with
  # \`ssh:\` (or \`local: true\`, the machine running ephor) get it; the
  # others are still checked for reachability.
  system:
    interval: 1m

# A value is shown and never warns until it has a threshold: none are set
# by default. By metric id, in the metric's unit; a node's own
# \`thresholds:\` replace these, and \`null\` there drops one. For example:
#
# thresholds:
#   system.disk_percent: { warn: 85, critical: 95 }
#   system.received_percent: { warn: 80, critical: 100 }
#   system.sent_percent: { warn: 80, critical: 100 }
#
# A percent of \`bandwidth\` can pass 100: more than promised is in use,
# and the hoster may cut the port back to it any day.

nodes:
  # Your servers, one entry each. Uncomment one form and fill it in; the
  # addresses below are documentation examples, not real servers.
  #
  # The usual form: \`ssh:\` is a Host alias from ~/.ssh/config, so the
  # user, port, key and jump host are taken from there.
  #
  # - name: amsterdam
  #   host: 203.0.113.10
  #   ssh: amsterdam
  #
  # Without ssh: only reachability, the rest of the row shows a dash.
  #
  # - name: frankfurt
  #   host: 203.0.113.11
  #
  # Without an alias: ssh connects to \`host\` as this user, on this port,
  # through this jump host (itself a name ssh resolves). \`key\` is tried
  # first and the agent's keys are not; the jump host itself still logs
  # in through ~/.ssh/config and the agent.
  #
  # - name: helsinki
  #   host: 203.0.113.12
  #   ssh:
  #     user: root
  #     port: 22
  #     key: ~/.ssh/id_ed25519
  #     jump: bastion       # ProxyJump; leave out to connect directly
  #
  # Ports are optional. Left out, the PORTS column lists the TCP ports
  # that listen on the node beyond loopback, for reference. Listed, one
  # that stops listening warns (say, the VPN on 443 went down), and so
  # does one that is not listed: list every such port. UDP is not seen.
  #
  #   ports: [443, 2222]
  #
  # Bandwidth is optional: TRAFFIC shows Mbit/s without it. Given, it
  # adds how full the port is as a percent of it, and the metrics
  # system.received_percent and system.sent_percent can take thresholds.
  # Write the speed you plan by: the tariff, to hear when users lean on
  # more than the hoster promises (a percent past 100), or the port's
  # real speed, to see how full it really is. \`1Gbit\` for both
  # directions, else \`{ received: 1Gbit, sent: 300Mbit }\`.
  #
  #   bandwidth: 1Gbit
`;
