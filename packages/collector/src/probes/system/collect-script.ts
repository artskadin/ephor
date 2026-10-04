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

export const SYSTEM_COLLECT_SCRIPT = String.raw`
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
  printf '"listeningPorts":%s' "$listening_ports"
  printf '}'
`;
