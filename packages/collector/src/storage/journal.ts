import type { DatabaseSync } from "node:sqlite";
import type {
  CountryEvidence,
  IncidentAssessment,
  IncidentEvidence,
  IncidentMonitor,
  JournalBatch,
} from "@ephorate/core";

type EventKind =
  | "opened"
  | "changed"
  | "measurement_lost"
  | "measurement_resumed"
  | "recovered"
  | "observation_stopped";
type StopReason = "not_monitored" | "rule_changed";

interface OpenRow {
  id: number;
  kind: IncidentMonitor["subject"]["kind"];
  subject_key: string;
  rule_key: string;
  last_observed_at: number;
  last_assessment_json: string;
}

export function writeJournal(
  database: DatabaseSync,
  { observations, observedAt }: JournalBatch,
): void {
  for (const next of observations) {
    const open = database
      .prepare(`
      SELECT id, kind, subject_key, rule_key, last_observed_at, last_assessment_json
      FROM incidents WHERE kind = ? AND subject_key = ? AND state = 'open'
    `)
      .get(next.subject.kind, next.subjectKey) as OpenRow | undefined;
    if (open !== undefined && observedAt < open.last_observed_at) continue;

    if (open === undefined || open.rule_key !== next.ruleKey) {
      if (open !== undefined)
        stop(database, open.id, observedAt, "rule_changed");
      if (next.assessment.state !== "breached") continue;

      const { lastInsertRowid } = database
        .prepare(`
        INSERT INTO incidents (
          kind, node_name, subject_key, rule_key, subject_json, state,
          first_observed_at, last_observed_at, last_assessment_json, last_event_at
        ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
      `)
        .run(
          next.subject.kind,
          next.subject.nodeName,
          next.subjectKey,
          next.ruleKey,
          JSON.stringify(next.subject),
          observedAt,
          observedAt,
          JSON.stringify(next.assessment),
          observedAt,
        );
      append(database, lastInsertRowid, observedAt, "opened", next.assessment);
      continue;
    }

    const previous = JSON.parse(
      open.last_assessment_json,
    ) as IncidentAssessment;
    const event = eventFor(previous, next.assessment);
    database
      .prepare(`
      UPDATE incidents SET last_observed_at = ?, last_assessment_json = ?
      WHERE id = ?
    `)
      .run(observedAt, JSON.stringify(next.assessment), open.id);

    if (event === "recovered") {
      database
        .prepare(`
        UPDATE incidents SET state = 'recovered', ended_at = ?, end_reason = 'recovery_observed'
        WHERE id = ?
      `)
        .run(observedAt, open.id);
    }
    if (event !== undefined)
      append(database, open.id, observedAt, event, next.assessment);
  }
}

export function stopUnmonitoredIncidents(
  database: DatabaseSync,
  monitors: readonly IncidentMonitor[],
  observedAt: number,
): void {
  const rules = new Map(
    monitors.map(({ subject, subjectKey, ruleKey }) => [
      JSON.stringify([subject.kind, subjectKey]),
      ruleKey,
    ]),
  );
  const open = database
    .prepare(`
    SELECT id, kind, subject_key, rule_key, last_observed_at
    FROM incidents WHERE state = 'open'
  `)
    .all() as unknown as Omit<OpenRow, "last_assessment_json">[];
  for (const episode of open) {
    const rule = rules.get(JSON.stringify([episode.kind, episode.subject_key]));
    if (rule === episode.rule_key) continue;
    stop(
      database,
      episode.id,
      Math.max(observedAt, episode.last_observed_at),
      rule === undefined ? "not_monitored" : "rule_changed",
    );
  }
}

function stop(
  database: DatabaseSync,
  id: number,
  observedAt: number,
  reason: StopReason,
): void {
  database
    .prepare(`
    UPDATE incidents SET state = 'observation_stopped', ended_at = ?, end_reason = ?
    WHERE id = ?
  `)
    .run(observedAt, reason, id);
  append(database, id, observedAt, "observation_stopped", { reason });
}

function append(
  database: DatabaseSync,
  id: number | bigint,
  observedAt: number,
  event: EventKind,
  evidence: IncidentAssessment | { reason: StopReason },
): void {
  const { lastInsertRowid } = database
    .prepare(`
    INSERT INTO journal_events (incident_id, observed_at, event_kind, evidence_json)
    VALUES (?, ?, ?, ?)
  `)
    .run(id, observedAt, event, JSON.stringify(evidence));
  database
    .prepare(`
    UPDATE incidents SET last_event_at = ?, last_event_id = ? WHERE id = ?
  `)
    .run(observedAt, lastInsertRowid, id);
}

function eventFor(
  previous: IncidentAssessment,
  next: IncidentAssessment,
): EventKind | undefined {
  if (next.state === "healthy") return "recovered";
  if (next.state === "not_measured")
    return previous.state === "not_measured" ? undefined : "measurement_lost";
  if (previous.state === "not_measured") return "measurement_resumed";
  if (
    previous.state !== "breached" ||
    previous.severity !== next.severity ||
    evidenceChanged(previous.evidence, next.evidence)
  )
    return "changed";
  return undefined;
}

function evidenceChanged(
  previous: IncidentEvidence,
  next: IncidentEvidence,
): boolean {
  switch (next.kind) {
    case "threshold":
      return previous.kind !== "threshold";
    case "port_audit":
      return (
        previous.kind !== "port_audit" ||
        JSON.stringify(previous) !== JSON.stringify(next)
      );
    case "measurement":
      return (
        previous.kind !== "measurement" ||
        previous.reason !== next.reason ||
        measurementGap(previous.countries) !== measurementGap(next.countries) ||
        (next.reason === "endpoint_attempt_failed" &&
          previous.detail !== next.detail)
      );
    case "network":
      return (
        previous.kind !== "network" ||
        previous.verdict !== next.verdict ||
        networkCountsChanged(previous.countries, next.countries)
      );
  }
}

function measurementGap(countries: readonly CountryEvidence[] = []): string {
  return JSON.stringify(
    countries
      .filter(({ role, reported }) => role === "target" && reported === 0)
      .map(
        ({ country, selected }) =>
          `${country}:${selected === 0 ? "no_points" : "no_results"}`,
      )
      .sort(),
  );
}

function networkCountsChanged(
  previous: readonly CountryEvidence[],
  next: readonly CountryEvidence[],
): boolean {
  const before = new Map(
    previous
      .filter(({ role }) => role === "target")
      .map((country) => [country.country, country]),
  );
  return next.some((country) => {
    if (country.role !== "target") return false;
    const earlier = before.get(country.country);
    if (earlier === undefined) return true;
    const failed = (evidence: CountryEvidence) =>
      evidence.passed < evidence.reported;
    if (failed(earlier) !== failed(country)) return true;
    return (
      earlier.reportingPoints !== undefined &&
      country.reportingPoints !== undefined &&
      JSON.stringify(earlier.reportingPoints) ===
        JSON.stringify(country.reportingPoints) &&
      earlier.passed !== country.passed
    );
  });
}
