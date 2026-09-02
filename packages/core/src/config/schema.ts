import { z } from "zod";
import type { ProbeDescriptor } from "../types/probe-contract.js";
import { Duration } from "./duration.js";

/* -------------------------------------------------------------------------
 * SSH target
 *
 * Two spellings for the same thing: `ssh: achilles` when the user keeps an
 * alias in ~/.ssh/config, and the full object when they do not. The alias is
 * a convenience, never a requirement — a config must be able to describe the
 * connection completely on its own.
 * ---------------------------------------------------------------------- */

const SshTargetSchema = z
  .object({
    alias: z.string().min(1).optional(),
    user: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).default(22),
    key: z.string().min(1).optional(),
    jump: z.string().min(1).optional(),
  })
  .strict();

export const SshSchema = z.union([
  z
    .string()
    .min(1)
    .transform((alias) => SshTargetSchema.parse({ alias })),
  SshTargetSchema,
]);

export type Ssh = z.infer<typeof SshTargetSchema>;

/* -------------------------------------------------------------------------
 * Ports
 *
 * `443` for the common case, the object form when the port needs a label or
 * is not meant to be reachable from the outside.
 * ---------------------------------------------------------------------- */

export const ExposeSchema = z.enum(["public", "local", "bastion"]);

const PortTargetSchema = z
  .object({
    port: z.number().int().min(1).max(65535),
    proto: z.enum(["tcp", "udp"]).default("tcp"),
    label: z.string().min(1).optional(),
    expose: ExposeSchema.default("public"),
  })
  .strict();

export const PortSchema = z.union([
  z
    .number()
    .int()
    .min(1)
    .max(65535)
    .transform((port) => PortTargetSchema.parse({ port })),
  PortTargetSchema,
]);

export type Port = z.infer<typeof PortTargetSchema>;

/* -------------------------------------------------------------------------
 * Probe settings
 *
 * The same four keys mean the same thing at both levels, so there is only
 * one word to learn. `concurrency` is global-only: it caps a shared resource
 * (ssh processes, a third-party API, bandwidth), which no single node owns.
 * ---------------------------------------------------------------------- */

const baseProbeShape = {
  enabled: z.boolean().optional(),
  interval: Duration.optional(),
  timeout: Duration.optional(),
  retries: z.number().int().min(0).optional(),
} satisfies z.ZodRawShape;

export const NodeProbeConfigSchema = z.object(baseProbeShape).strict();
export type NodeProbeConfig = z.infer<typeof NodeProbeConfigSchema>;

export const GlobalProbeConfigSchema = z
  .object({
    ...baseProbeShape,
    concurrency: z.number().int().min(1).optional(),
  })
  .strict();

/** The keys every probe understands; anything else belongs to one probe. */
export const BASE_PROBE_KEYS: readonly string[] = Object.keys({
  ...baseProbeShape,
  concurrency: true,
});

/**
 * A probe's global settings: the shared keys plus whatever the probe itself
 * declares. Probe-specific values are read through `ProbeContext.settings`,
 * so they are deliberately not described here.
 */
export type GlobalProbeConfig = z.infer<typeof GlobalProbeConfigSchema>;

/**
 * Settings applied to every probe, so that "three attempts everywhere" is
 * written once rather than once per probe.
 *
 * `interval` is deliberately not accepted here. One number cannot sensibly
 * mean both "read /proc" and "download for ten seconds", and a user who set
 * it globally would be surprised by the bandwidth bill rather than by an
 * error message.
 */
export const ProbeDefaultsSchema = z
  .object({
    enabled: z.boolean().optional(),
    timeout: Duration.optional(),
    retries: z.number().int().min(0).optional(),
    interval: z
      .undefined({
        error: "interval is set per probe, e.g. probes.system.interval",
      })
      .optional(),
  })
  .strict();

// Named apart from `ProbeDefaults` in the probe contract: that one is what a
// probe declares in code, this one is what the user writes in YAML.
export type ProbeDefaultsConfig = z.infer<typeof ProbeDefaultsSchema>;

/* -------------------------------------------------------------------------
 * Storage
 * ---------------------------------------------------------------------- */

export const StorageSchema = z
  .object({
    // Only sqlite exists today. The field is here so that adding a driver
    // later is an addition to an enum rather than a change in shape.
    driver: z.enum(["sqlite"]).default("sqlite"),
    // No default: a relative one silently follows the working directory,
    // which in a container means the data volume is bypassed and history
    // disappears on the next recreation without a word. The collector
    // picks a platform-appropriate absolute path when this is absent.
    path: z.string().min(1).optional(),
    retention: Duration.default(7_776_000), // 90 days
    pruneAt: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM")
      .default("04:00"),
  })
  .strict();

export type StorageSettings = z.infer<typeof StorageSchema>;

/* -------------------------------------------------------------------------
 * HTTP API
 *
 * Served from the collector's own process: `POST /api/check` forces a run and
 * waits for exactly those pairs, which needs the live scheduler rather than
 * the database. Clients reach it over an SSH tunnel when the collector is
 * remote.
 *
 * The token is deliberately not here. It belongs in `EPHOR_TOKEN`, because a
 * config file gets copied between machines, pasted into a bug report and
 * committed by accident.
 * ---------------------------------------------------------------------- */

export const ApiSchema = z
  .object({
    enabled: z.boolean().default(true),
    // Configurable rather than fixed only because of containers: inside one,
    // binding 127.0.0.1 makes the port unreachable from the host's mapping.
    // On a plain host it should stay as it is — and see the gotcha about
    // Docker writing nftables rules straight past ufw.
    bind: z.string().min(1).default("127.0.0.1"),
    // In the IANA dynamic range (49152-65535, RFC 6335), which is guaranteed
    // unassigned, so it will not collide with whatever else the bastion runs.
    port: z.number().int().min(1).max(65535).default(53556),
  })
  .strict();

export type ApiSettings = z.infer<typeof ApiSchema>;

/* -------------------------------------------------------------------------
 * Thresholds
 *
 * What counts as a problem is the user's to say, not ours: 85% of a disk is
 * routine on one machine and an emergency on another. Keyed by metric id —
 * the same name the user already types in `ephor history system.disk_percent`
 * — so `core` needs to know nothing about which probes exist, and a new probe
 * becomes thresholdable without touching this file.
 *
 * Numbers are in the metric's own unit: percent for `system.disk_percent`,
 * Mbit/s for `speed.download_mbps`, seconds for `time.drift_seconds`. There
 * is nothing to convert and no unit to declare.
 *
 * Thresholds are optional everywhere. A metric without one is displayed and
 * never coloured — which is the right default for a value whose normal range
 * the user does not know yet, and a wrong threshold is worse than none: it
 * paints the screen for no reason until people stop reading the colours.
 * ---------------------------------------------------------------------- */

export const WorseWhenSchema = z.enum(["above", "below"]);
export type WorseWhen = z.infer<typeof WorseWhenSchema>;

export const ThresholdSchema = z
  .object({
    warn: z.number().optional(),
    critical: z.number().optional(),
    /** Which side of the number is the bad one. */
    worseWhen: WorseWhenSchema.optional(),
  })
  .strict()
  .superRefine((threshold, ctx) => {
    const { warn, critical, worseWhen } = threshold;

    if (warn === undefined && critical === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "a threshold needs warn, critical, or both",
      });
      return;
    }

    if (warn !== undefined && critical !== undefined) {
      if (warn === critical) {
        ctx.addIssue({
          code: "custom",
          message: `warn and critical must differ; both are ${warn}`,
        });
        return;
      }

      // Two bounds say the direction by themselves: 85 → 95 climbs towards
      // trouble, 50 → 20 falls towards it.
      const implied = critical > warn ? "above" : "below";
      if (worseWhen !== undefined && worseWhen !== implied) {
        ctx.addIssue({
          code: "custom",
          message:
            `warn ${warn} and critical ${critical} mean the metric is worse ` +
            `${implied}, but worseWhen says ${worseWhen}`,
          path: ["worseWhen"],
        });
      }
      return;
    }

    // One bound cannot imply a direction, and guessing is how a monitor comes
    // to report a fast server as slow: 50 Mbit/s is bad below, 50% of a disk
    // is bad above, and the metric name says nothing to a schema.
    if (worseWhen === undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "a single bound does not say which side is bad; add " +
          "worseWhen: above or worseWhen: below",
      });
    }
  })
  .transform((threshold) => {
    const { warn, critical } = threshold;

    const worseWhen: WorseWhen =
      warn !== undefined && critical !== undefined
        ? critical > warn
          ? "above"
          : "below"
        : // Present by the rule above; the fallback keeps the type honest.
          (threshold.worseWhen ?? "above");

    const resolved: { warn?: number; critical?: number; worseWhen: WorseWhen } =
      { worseWhen };

    if (warn !== undefined) resolved.warn = warn;
    if (critical !== undefined) resolved.critical = critical;

    return resolved;
  });

export type Threshold = z.infer<typeof ThresholdSchema>;

/**
 * `null` means "no threshold for this metric". Written globally it is the
 * same as leaving the metric out; written on a node it is the only way to
 * drop an inherited one — an archive box that lives at 92% disk on purpose
 * would otherwise need an invented number like `warn: 200`, which reads as a
 * mistake and hides a real problem the day the metric passes it.
 */
const ThresholdsSchema = optionalSection(
  z.record(z.string().min(1), ThresholdSchema.nullable()).default({}),
);

export type Thresholds = z.infer<typeof ThresholdsSchema>;

/* -------------------------------------------------------------------------
 * Nodes and the config as a whole
 * ---------------------------------------------------------------------- */

const nodeShape = {
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, "letters, digits, - and _"),
  host: z.string().min(1),
  domain: z.string().min(1).optional(),
  tags: optionalSection(z.array(z.string().min(1)).default([])),
  enabled: z.boolean().default(true),
  local: z.boolean().default(false),
  ssh: SshSchema.optional(),
  ports: optionalSection(z.array(PortSchema).default([])),
  probes: optionalSection(
    z.record(z.string(), NodeProbeConfigSchema).default({}),
  ),
  thresholds: ThresholdsSchema,
} satisfies z.ZodRawShape;

export const NodeSchema = z.object(nodeShape).strict();
export type Node = z.infer<typeof NodeSchema>;

/**
 * Builds the config schema for a given set of probes.
 *
 * The probe list is not baked into `core`: registering a probe is the only
 * thing needed to make its section valid, and an unregistered name is
 * reported with the list of names that do exist rather than a bare
 * "unrecognized key".
 */
export function buildConfigSchema(descriptors: readonly ProbeDescriptor[]) {
  const globalByName = new Map(
    descriptors.map((descriptor) => [
      descriptor.name,
      buildGlobalProbeSchema(descriptor),
    ]),
  );

  const knownNames = [...globalByName.keys()];

  const GlobalProbesSchema = optionalSection(
    z
      .record(z.string(), z.unknown())
      .default({})
      .transform((raw, ctx): Record<string, GlobalProbeConfig> => {
        for (const name of Object.keys(raw)) {
          if (globalByName.has(name)) continue;
          ctx.addIssue(unknownProbeIssue(name, knownNames));
        }

        const parsed: Record<string, GlobalProbeConfig> = {};

        // Every registered probe gets an entry, whether or not the user
        // wrote one. Otherwise a probe's own defaults exist only for users
        // who happened to mention it, and `settings` reaches the probe
        // empty — a difference nothing downstream could see or explain.
        for (const [name, schema] of globalByName) {
          const result = schema.safeParse(raw[name] ?? {});

          if (!result.success) {
            for (const issue of result.error.issues) {
              ctx.addIssue({ ...issue, path: [name, ...issue.path] });
            }
            continue;
          }

          // Safe by construction: the schema is the shared shape extended
          // with the probe's own keys, so it is a superset of the base type.
          parsed[name] = result.data as GlobalProbeConfig;
        }

        return parsed;
      }),
  );

  const NodeWithKnownProbesSchema = NodeSchema.superRefine((node, ctx) => {
    for (const name of Object.keys(node.probes)) {
      if (globalByName.has(name)) continue;
      ctx.addIssue({
        ...unknownProbeIssue(name, knownNames),
        path: ["probes"],
      });
    }

    checkThresholdKeys(node.thresholds, knownNames, ctx, ["thresholds"]);
  });

  return z
    .object({
      probeDefaults: optionalSection(ProbeDefaultsSchema.prefault({})),
      probes: GlobalProbesSchema,
      thresholds: ThresholdsSchema,
      nodes: z.array(NodeWithKnownProbesSchema).min(1, "at least one node"),
      storage: optionalSection(StorageSchema.prefault({})),
      api: optionalSection(ApiSchema.prefault({})),
    })
    .strict()
    .superRefine((config, ctx) => {
      checkThresholdKeys(config.thresholds, knownNames, ctx, ["thresholds"]);
    })
    .refine(
      (config) =>
        new Set(config.nodes.map((node) => node.name)).size ===
        config.nodes.length,
      { message: "node names must be unique", path: ["nodes"] },
    );
}

/**
 * A metric id starts with the name of the probe that emits it, so a threshold
 * naming a probe that does not exist is a typo worth refusing — the same
 * treatment `probes:` already gives an unknown section.
 *
 * The part after the dot is not checked, because no probe declares the
 * metrics it writes yet. Until that exists, `system.disk_percnet` still slips
 * through, and the user believes a threshold applies when it never will.
 */
function checkThresholdKeys(
  thresholds: Readonly<Record<string, unknown>>,
  knownNames: readonly string[],
  ctx: z.RefinementCtx,
  basePath: PropertyKey[],
): void {
  for (const metric of Object.keys(thresholds)) {
    const probe = metric.split(".")[0];
    if (probe !== undefined && knownNames.includes(probe)) continue;

    ctx.addIssue({
      code: "custom",
      message:
        `Metric "${metric}" belongs to no known probe. A metric id starts ` +
        `with its probe: ${knownNames.join(", ")}`,
      path: [...basePath, metric],
    });
  }
}

export type Config = z.infer<ReturnType<typeof buildConfigSchema>>;

/**
 * A probe's own settings live alongside the shared ones, so a probe that
 * declares a key like `timeout` would silently shadow the shared meaning
 * and then be stripped out again as a shared key. Refusing at build time
 * turns a value that quietly does nothing into an error the probe author
 * sees on the first run.
 */
function buildGlobalProbeSchema(descriptor: ProbeDescriptor) {
  const collisions = Object.keys(descriptor.settings ?? {}).filter((key) =>
    BASE_PROBE_KEYS.includes(key),
  );

  if (collisions.length > 0) {
    throw new Error(
      `Probe "${descriptor.name}" declares settings that collide with the ` +
        `shared probe keys: ${collisions.join(", ")}. Rename them.`,
    );
  }

  return GlobalProbeConfigSchema.extend(descriptor.settings ?? {}).strict();
}

/**
 * A section written with no body under it parses to `null`, and neither
 * `.default()` nor `.prefault()` covers that — both only fire on
 * `undefined`. Blanking a section while editing is as common as deleting
 * it and has to mean the same thing.
 */
function optionalSection<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => value ?? undefined, schema);
}

function unknownProbeIssue(
  name: string,
  knownNames: readonly string[],
): { code: "custom"; message: string; path: PropertyKey[] } {
  return {
    code: "custom",
    message: `Unknown probe "${name}". Available: ${knownNames.join(", ")}`,
    path: [name],
  };
}
