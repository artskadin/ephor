# Incident journal: collector write path

`serve` records the journal in its SQLite database, whether `watch` is open
or not. A `check` through `serve` goes through the same writer. A standalone
`check` uses an in-memory database and has no durable journal. This slice
does not implement an API, journal tab, read-cursor updates, or the
collector checkpoint for gaps across sleep and process restarts. Provider
errors are recorded as measurement failures for the affected checks;
grouping explicitly shared provider failures is separate.

## What becomes an incident

- **Network**: a reporting point in a target country measured a failure.
  An unclassified (`unknown`) verdict can still carry a measured failure.
  Missing coverage alone is not a network incident, and cannot close one.
  Recovery requires a fresh success at all selected points in every
  configured target country. Controls help classify failures but do
  not open a network incident on their own.
- **System**: a measurement breached an operator-configured threshold, or
  the local port inventory differed from the expected ports. No default
  traffic threshold, active bandwidth test, or VPN handshake is added.
- **Measurement**: the probe failed, a local port inventory could not be
  read, or a target country yielded no observations. One missing point
  alongside reporting points in that country is not a separate incident.
  Resuming measurement closes a measurement episode, not necessarily
  the observed outage or threshold breach.

An [adapter](../packages/collector/src/journal/observations.ts) translates
one completed probe's metrics into assessments. It does not read stale
metrics or the node's rolled-up `status`. A repeated breach updates the
comparison baseline without appending a new event. A change in severity,
affected countries, or counts from the same reporting points can append
an event. A failed measurement leaves an observed episode open; returning
data may update it or confirm recovery. A later breach after recovery is
a new episode.

The key of a network check includes the node name and the entry name,
transport and actual destination. For system checks, identity includes
the configured machine: local execution, the SSH alias, or the direct
SSH host and any explicit SSH port. Changing the public host does not split
system history if SSH still uses the same alias. Changes behind an unchanged
SSH alias are not inferred. Rule identity includes the target countries (sorted),
expected ports, or the threshold and, for traffic percentages, the
reference bandwidth for that direction only.

An open episode whose check is no longer monitored, or whose rule changed,
ends as `observation_stopped`, not `recovered`. When the API is enabled,
startup must bind its listener before reconciling old episodes. Requests
with a valid token receive `503` until reconciliation and collector startup
finish. An unchanged check keeps its open episode across restarts. The
journal does not replay old metrics.

## Storage

Migration 5 adds `incidents` (the episode's current state and subject
snapshot) and `journal_events` (material transitions and their evidence).
The unique partial index prevents two open episodes for the same kind
and check. The event index serves reads of a single episode. Metric
pruning does not delete journal rows. The journal has no retention policy
in this slice.

The [writer](../packages/collector/src/storage/journal.ts) runs inside
the same transaction as `metrics` and `metrics_latest`. A failed insert
into the journal rolls back the metrics for that run as well, so a
committed observation cannot silently skip its incident transition.
The task executor logs the failure and can run later tasks.

Example inspection against a local SQLite database:

```sql
SELECT id, kind, node_name, state, first_observed_at, ended_at, end_reason
FROM incidents
ORDER BY last_event_at DESC, id DESC;

SELECT observed_at, event_kind, evidence_json
FROM journal_events
WHERE incident_id = 42
ORDER BY id;
```

Timestamps say when Ephor observed a result, not when the service first
broke or recovered. A row snapshots its subject and events carry facts
so historical entries stay meaningful after config changes or metric
pruning.
