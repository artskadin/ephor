import type { Threshold } from "../config/schema";
import type { Verdict } from "../reachability/verdict";

interface EndpointIdentity {
  name: string;
  transport: "tcp" | "https";
  destination: string;
}

export type IncidentMachine =
  | { kind: "local" }
  | { kind: "ssh_alias"; alias: string }
  | { kind: "ssh_host"; host: string; port?: number };

export type IncidentSubject =
  | {
      kind: "network";
      nodeName: string;
      endpoint: EndpointIdentity;
      targets: readonly string[];
    }
  | {
      kind: "system";
      nodeName: string;
      machine?: IncidentMachine;
      check:
        | {
            kind: "threshold";
            metric: string;
            threshold: Threshold;
            referenceMbps?: number;
          }
        | { kind: "port_audit"; expected: readonly number[] };
    }
  | {
      kind: "measurement";
      nodeName: string;
      machine?: IncidentMachine;
      check:
        | {
            kind: "endpoint";
            endpoint: EndpointIdentity;
            targets: readonly string[];
          }
        | { kind: "probe"; probe: string }
        | { kind: "port_inventory" };
    };

export interface IncidentMonitor {
  subject: IncidentSubject;
  subjectKey: string;
  ruleKey: string;
}

export interface CountryEvidence {
  country: string;
  role: "target" | "control";
  selected: number;
  reported: number;
  passed: number;
  /** Only compare counts as a change when the reporting points are comparable. */
  reportingPoints?: readonly string[];
}

export type IncidentEvidence =
  | { kind: "network"; verdict: Verdict; countries: readonly CountryEvidence[] }
  | { kind: "threshold"; value: number }
  | {
      kind: "port_audit";
      missing: readonly number[];
      undeclared: readonly number[];
    }
  | {
      kind: "measurement";
      reason: string;
      detail?: string;
      countries?: readonly CountryEvidence[];
    };

export type IncidentAssessment =
  | { state: "healthy"; evidence: IncidentEvidence }
  | {
      state: "breached";
      severity: "warn" | "critical";
      evidence: IncidentEvidence;
    }
  | { state: "not_measured"; evidence: IncidentEvidence };

export interface IncidentObservation extends IncidentMonitor {
  assessment: IncidentAssessment;
}

export interface JournalBatch {
  observedAt: number;
  observations: readonly IncidentObservation[];
}
