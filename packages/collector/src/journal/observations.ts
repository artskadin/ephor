import {
  type CountryEvidence,
  endpointMetric,
  endpointTransport,
  exceededThresholdLevel,
  type IncidentAssessment,
  type IncidentEvidence,
  type IncidentMachine,
  type IncidentMonitor,
  type IncidentObservation,
  type IncidentSubject,
  type MetricPoint,
  ReachabilityRegionsSchema,
  type ResolvedNode,
  type ResolvedProbe,
  resolveEndpoints,
} from "@ephorate/core";

type Points = ReadonlyMap<string, MetricPoint>;

interface Check extends IncidentMonitor {
  assess(points: Points): IncidentAssessment | undefined;
}

interface MachineScope {
  nodeName: string;
  machine?: IncidentMachine;
}

export function incidentMonitors(
  nodes: readonly ResolvedNode[],
): IncidentMonitor[] {
  return nodes.flatMap((node) =>
    [...node.probes.keys()].flatMap((probeName) =>
      checksFor(node, probeName).map(({ subject, subjectKey, ruleKey }) => ({
        subject,
        subjectKey,
        ruleKey,
      })),
    ),
  );
}

export function incidentObservations(
  node: ResolvedNode,
  probeName: string,
  points: readonly MetricPoint[],
): IncidentObservation[] {
  const byMetric = new Map(points.map((point) => [point.metric, point]));
  return checksFor(node, probeName).flatMap(
    ({ subject, subjectKey, ruleKey, assess }) => {
      const assessment = assess(byMetric);
      return assessment === undefined
        ? []
        : [{ subject, subjectKey, ruleKey, assessment }];
    },
  );
}

function check(
  subject: IncidentSubject,
  key: readonly unknown[],
  rule: readonly unknown[],
  assess: Check["assess"],
): Check {
  return {
    subject,
    subjectKey: JSON.stringify([
      subject.nodeName,
      ...key,
      ...("machine" in subject && subject.machine !== undefined
        ? [subject.machine]
        : []),
    ]),
    ruleKey: JSON.stringify(rule),
    assess,
  };
}

function checksFor(node: ResolvedNode, probeName: string): Check[] {
  const probe = node.probes.get(probeName);
  if (!probe?.enabled) return [];
  if (probeName === "reachability") return endpointChecks(node, probe);
  const scope = machineScope(node);
  return [
    probeMeasurement(scope, probeName),
    ...thresholdChecks(node, probe, scope),
    ...(probeName === "system" ? portChecks(node, scope) : []),
  ];
}

function machineScope(node: ResolvedNode): MachineScope {
  const { name: nodeName, host, local, ssh } = node.config;
  if (local) return { nodeName, machine: { kind: "local" } };
  if (ssh === undefined) return { nodeName };
  // An SSH alias chooses the machine independently of the public host.
  const machine: IncidentMachine =
    ssh.alias === undefined
      ? {
          kind: "ssh_host",
          host,
          ...(ssh.port === undefined ? {} : { port: ssh.port }),
        }
      : { kind: "ssh_alias", alias: ssh.alias };
  return { nodeName, machine };
}

function endpointChecks(node: ResolvedNode, probe: ResolvedProbe): Check[] {
  const parsed = ReachabilityRegionsSchema.safeParse(probe.settings.regions);
  if (!parsed.success) return [];
  const targets = [...parsed.data.targets].sort();
  const endpoints = resolveEndpoints(node.config.host, node.config.endpoints);
  const nodeName = node.config.name;
  return endpoints.flatMap((endpoint) => {
    const transport = endpointTransport(endpoint);
    if (transport === "udp") return [];
    const identity = {
      name: endpoint.name,
      transport,
      destination: endpoint.destination,
    };
    const key = [
      "endpoint",
      identity.name,
      identity.transport,
      identity.destination,
    ];
    return [
      check(
        { kind: "network", nodeName, endpoint: identity, targets },
        key,
        targets,
        (points) => networkAssessment(endpoint.name, points),
      ),
      check(
        {
          kind: "measurement",
          nodeName,
          check: { kind: "endpoint", endpoint: identity, targets },
        },
        key,
        targets,
        (points) => endpointCoverage(endpoint.name, points),
      ),
    ];
  });
}

function networkAssessment(
  name: string,
  points: Points,
): IncidentAssessment | undefined {
  const verdict = points.get(endpointMetric(name, "verdict"));
  if (verdict === undefined) {
    const attempt = points.get(endpointMetric(name, "attempt"));
    return attempt?.ok === false
      ? { state: "not_measured", evidence: endpointFailure(attempt) }
      : undefined;
  }
  const countries = countriesIn(verdict);
  const value = verdict.meta?.verdict;
  if (
    value !== "ok" &&
    value !== "partial" &&
    value !== "blocked" &&
    value !== "down" &&
    value !== "unknown"
  )
    return undefined;
  const evidence: IncidentEvidence = {
    kind: "network",
    verdict: value,
    countries,
  };
  const targets = countries.filter(({ role }) => role === "target");
  if (targets.some(({ passed, reported }) => passed < reported)) {
    const allFailed = targets.every(
      ({ passed, reported, selected }) =>
        selected > 0 && reported === selected && passed === 0,
    );
    return {
      state: "breached",
      severity: allFailed ? "critical" : "warn",
      evidence,
    };
  }
  const complete =
    targets.length > 0 &&
    targets.every(
      ({ selected, passed }) => selected > 0 && passed === selected,
    );
  return { state: complete ? "healthy" : "not_measured", evidence };
}

function endpointCoverage(
  name: string,
  points: Points,
): IncidentAssessment | undefined {
  const attempt = points.get(endpointMetric(name, "attempt"));
  if (attempt?.ok === false) return failure(endpointFailure(attempt));
  const verdict = points.get(endpointMetric(name, "verdict"));
  if (verdict === undefined) return undefined;
  const countries = countriesIn(verdict);
  const missingTargets = countries.filter(
    ({ role, reported }) => role === "target" && reported === 0,
  );
  return missingTargets.length > 0
    ? failure({
        kind: "measurement",
        reason: "target_coverage_missing",
        countries,
      })
    : {
        state: "healthy",
        evidence: {
          kind: "measurement",
          reason: "results_returned",
          countries,
        },
      };
}

function endpointFailure(point: MetricPoint): IncidentEvidence {
  const detail = point.meta?.error;
  return {
    kind: "measurement",
    reason: "endpoint_attempt_failed",
    ...(typeof detail === "string" ? { detail } : {}),
    countries: countriesIn(point),
  };
}

function countriesIn(point: MetricPoint): CountryEvidence[] {
  const raw = point.meta?.regions;
  if (!Array.isArray(raw)) return [];
  const pointIds = point.meta?.reportingPoints as
    | Record<string, unknown>
    | undefined;
  return raw.flatMap((region): CountryEvidence[] => {
    if (typeof region !== "object" || region === null) return [];
    const {
      region: country,
      required,
      total,
      passed,
      reported = total,
    } = region;
    if (
      typeof country !== "string" ||
      typeof required !== "boolean" ||
      typeof total !== "number" ||
      typeof passed !== "number" ||
      typeof reported !== "number"
    )
      return [];
    const ids = pointIds?.[country];
    return [
      {
        country,
        role: required ? "target" : "control",
        selected: total,
        reported,
        passed,
        ...(Array.isArray(ids) && ids.every((id) => typeof id === "string")
          ? { reportingPoints: [...ids].sort() }
          : {}),
      },
    ];
  });
}

function failure(evidence: IncidentEvidence): IncidentAssessment {
  return { state: "breached", severity: "warn", evidence };
}

function probeMeasurement(scope: MachineScope, probe: string): Check {
  return check(
    { kind: "measurement", ...scope, check: { kind: "probe", probe } },
    ["probe", probe],
    [],
    (points) => {
      const point = points.get(`${probe}.up`);
      if (point === undefined) return undefined;
      if (point.ok !== false)
        return {
          state: "healthy",
          evidence: { kind: "measurement", reason: "results_returned" },
        };
      const { errorKind, detail } = point.meta ?? {};
      return failure({
        kind: "measurement",
        reason: typeof errorKind === "string" ? errorKind : "probe_failed",
        ...(typeof detail === "string" ? { detail } : {}),
      });
    },
  );
}

function thresholdChecks(
  node: ResolvedNode,
  probe: ResolvedProbe,
  scope: MachineScope,
): Check[] {
  return [...node.thresholds].flatMap(([metric, threshold]) => {
    if (!probe.metrics.has(metric)) return [];
    const referenceMbps =
      metric === "system.sent_percent"
        ? node.config.bandwidth?.sent
        : metric === "system.received_percent"
          ? node.config.bandwidth?.received
          : undefined;
    return [
      check(
        {
          kind: "system",
          ...scope,
          check: {
            kind: "threshold",
            metric,
            threshold,
            ...(referenceMbps === undefined ? {} : { referenceMbps }),
          },
        },
        ["threshold", metric],
        [
          threshold.worseWhen,
          threshold.warn,
          threshold.critical,
          referenceMbps,
        ],
        (points) => {
          const value = points.get(metric)?.value;
          if (value === undefined || !Number.isFinite(value)) {
            return points.get(`${probe.name}.up`)?.ok === false
              ? {
                  state: "not_measured",
                  evidence: { kind: "measurement", reason: "probe_failed" },
                }
              : undefined;
          }
          const severity = exceededThresholdLevel(value, threshold);
          const evidence: IncidentEvidence = { kind: "threshold", value };
          return severity === undefined
            ? { state: "healthy", evidence }
            : { state: "breached", severity, evidence };
        },
      ),
    ];
  });
}

function portChecks(node: ResolvedNode, scope: MachineScope): Check[] {
  const expected = [...new Set(node.config.ports.map(({ port }) => port))].sort(
    (left, right) => left - right,
  );
  const measurement = check(
    { kind: "measurement", ...scope, check: { kind: "port_inventory" } },
    ["port_inventory"],
    [],
    (points) => {
      const point = points.get("system.ports");
      if (point === undefined) return undefined;
      return typeof point.meta?.unreadable === "string"
        ? failure({
            kind: "measurement",
            reason: "port_inventory_unreadable",
            detail: point.meta.unreadable,
          })
        : {
            state: "healthy",
            evidence: { kind: "measurement", reason: "results_returned" },
          };
    },
  );
  if (expected.length === 0) return [measurement];
  const audit = check(
    { kind: "system", ...scope, check: { kind: "port_audit", expected } },
    ["port_audit"],
    expected,
    (points) => {
      const listening = points.get("system.ports")?.meta?.listening;
      if (
        !Array.isArray(listening) ||
        !listening.every((port) => typeof port === "number")
      ) {
        return {
          state: "not_measured",
          evidence: {
            kind: "measurement",
            reason: "port_inventory_unavailable",
          },
        };
      }
      const actual = new Set(listening);
      const missing = expected.filter((port) => !actual.has(port));
      const undeclared = [...actual]
        .filter((port) => !expected.includes(port))
        .sort((left, right) => left - right);
      const evidence: IncidentEvidence = {
        kind: "port_audit",
        missing,
        undeclared,
      };
      return missing.length + undeclared.length === 0
        ? { state: "healthy", evidence }
        : { state: "breached", severity: "warn", evidence };
    },
  );
  return [measurement, audit];
}
