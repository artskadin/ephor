// `listening_ports`: a JSON string of the ports beyond loopback (achilles
// has 127.0.0.1:8443), or null when `ss` is missing or fails: an empty
// list would read as "nothing listens". Column 4 is the local address.
export const LISTENING_PORTS_SNIPPET = String.raw`
  if listening_ports=$(set -o pipefail; ss -tlnH 2>/dev/null \
    | awk '$4 !~ /^(127\.|\[::1\]|\[::ffff:127\.)/ && $4 !~ /%lo:/ { print $4 }' \
    | sed 's/.*://' | sort -un | paste -sd, -); then
    listening_ports="\"$listening_ports\""
  else
    listening_ports=null
  fi
`;

// One reading of the default route's byte counters as JSON, or `null`: a
// failure here must not cost the rest of the result. The root is an
// argument for the tests.
export const NETWORK_READING_SNIPPET = String.raw`
  network_reading() {
    root=$1
    # The main table, not ip route get: a WARP tunnel's policy rule would
    # win there. Mask 0: an OpenVPN 0.0.0.0/1 is no default.
    interface=$(awk 'NR > 1 && $2 == "00000000" && $8 == "00000000" &&
      (best == "" || $7 < metric) { best = $1; metric = $7 }
      END { print best }' "$root/net/route" 2>/dev/null || true)
    # IPv6 only without IPv4; lo holds IPv6's reject routes. The metric is
    # hex: compared as text, or 000003e8 would read as 3e8, 300 000 000.
    if [ -z "$interface" ]; then
      interface=$(awk '$1 == "00000000000000000000000000000000" && $2 == "00" &&
        $10 != "lo" && (best == "" || "" $6 < "" metric) { best = $10; metric = $6 }
        END { print best }' "$root/net/ipv6_route" 2>/dev/null || true)
    fi
    # print, not printf %d: Debian's mawk stops that at 2147483647.
    counters=$(awk -v name="$interface" \
      '{ sub(/:/, " ") } $1 == name { print $2, $10; exit }' \
      "$root/net/dev" 2>/dev/null || true)
    uptime_now=$(awk '{ print $1 }' "$root/uptime" 2>/dev/null || true)
    boot_id=$(cat "$root/sys/kernel/random/boot_id" 2>/dev/null || true)
    set -- $counters
    if [ -z "$interface" ] || [ -z "$boot_id" ] || [ -z "$uptime_now" ] ||
      [ $# -ne 2 ]; then
      printf null
      return
    fi
    # All of it goes into JSON unescaped: only the characters expected.
    case "$interface$boot_id" in *[!A-Za-z0-9_.@-]*) printf null; return ;; esac
    case "$uptime_now" in *[!0-9.]*) printf null; return ;; esac
    case "$1$2" in *[!0-9]*) printf null; return ;; esac
    printf '{"interface":"%s","bootId":"%s","uptimeSeconds":%s,"receivedBytes":%s,"sentBytes":%s}' \
      "$interface" "$boot_id" "$uptime_now" "$1" "$2"
  }
`;

/** What the first reading must match to be measured against the last run. */
export interface TrafficBase {
  interface: string;
  bootId: string;
  /** The node's uptime past which the last run's reading is too old. */
  usableUntilUptime: number | null;
}

// Both go into the script: only what the node's own reading may hold.
const SAFE_NAME = /^[A-Za-z0-9_.@-]+$/;

/**
 * `network`: one reading, or two `secondReadAfterSeconds` apart when there
 * is no fair base (none, a reboot, a moved route, too old), so every run
 * that reads the counters gives a rate. Needs NETWORK_READING_SNIPPET.
 */
export function trafficReadingsSnippet(
  secondReadAfterSeconds: number,
  base: TrafficBase | undefined,
  root = "/proc",
): string {
  return String.raw`${fairBaseFunction(base)}
  network=$(network_reading ${root})
  if [ "$network" != null ] && ! is_fair_base; then
    sleep ${secondReadAfterSeconds}
    second_reading=$(network_reading ${root})
    if [ "$second_reading" != null ]; then
      network="$network,$second_reading"
    fi
  fi
  if [ "$network" != null ]; then network="[$network]"; fi
`;
}

// Whether the first reading can be measured against `base`: the same
// interface and boot, and the node's clock not past the base's age.
function fairBaseFunction(base: TrafficBase | undefined): string {
  if (
    base === undefined ||
    !SAFE_NAME.test(base.interface) ||
    !SAFE_NAME.test(base.bootId)
  ) {
    return "  is_fair_base() { return 1; }";
  }

  // The reading's own uptime, the clock TS measures the window by.
  const ageCommand =
    base.usableUntilUptime === null
      ? ""
      : String.raw`printf '%s\n' "$network" | awk '{
      sub(/.*"uptimeSeconds":/, ""); sub(/,.*/, "")
      exit !($0 + 0 <= ${base.usableUntilUptime})
    }'`;

  return String.raw`  is_fair_base() {
    case "$network" in
      *'"interface":"${base.interface}","bootId":"${base.bootId}",'*) ;;
      *) return 1 ;;
    esac
    ${ageCommand}
  }`;
}

export function systemCollectScript(
  secondReadAfterSeconds: number,
  base: TrafficBase | undefined,
): string {
  return String.raw`
  set -eu

  read -r load1 load5 load15 _ < /proc/loadavg
  read -r uptime_seconds _ < /proc/uptime

  mem_total=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
  mem_available=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)

  disk_line=$(df -B1 --output=size,used / | tail -1)
  disk_total=$(echo "$disk_line" | awk '{print $1}')
  disk_used=$(echo "$disk_line" | awk '{print $2}')

  cpu_count=$(nproc)

  host_name=$(hostname)

${LISTENING_PORTS_SNIPPET}

${NETWORK_READING_SNIPPET}

${trafficReadingsSnippet(secondReadAfterSeconds, base)}
  printf '{'
  printf '"load1":%s,' "$load1"
  printf '"load5":%s,' "$load5"
  printf '"load15":%s,' "$load15"
  printf '"cpuCount":%s,' "$cpu_count"
  printf '"uptimeSeconds":%s,' "$uptime_seconds"
  printf '"memTotalKb":%s,' "$mem_total"
  printf '"memAvailableKb":%s,' "$mem_available"
  printf '"hostName":"%s",' "$host_name"
  printf '"diskTotalBytes":%s,' "$disk_total"
  printf '"diskUsedBytes":%s,' "$disk_used"
  printf '"listeningPorts":%s,' "$listening_ports"
  printf '"network":%s' "$network"
  printf '}'
`;
}
