import { z } from "zod";
import type { ProbeDescriptor } from "../types/probe-contract";
import { Duration } from "./duration";

// `ssh: achilles` for an alias in ~/.ssh/config, the object form otherwise.
const SshTargetSchema = z
  .object({
    alias: z.string().min(1).optional(),
    user: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).default(22),
    key: z.string().min(1).optional(),
    jump: z.string().min(1).optional(),
  })
  .strict();

const SshSchema = z.union([
  z
    .string()
    .min(1)
    .transform((alias) => SshTargetSchema.parse({ alias })),
  SshTargetSchema,
]);

export type Ssh = z.infer<typeof SshTargetSchema>;

// `443` for the common case, the object form for a label or a private port.
const ExposeSchema = z.enum(["public", "local", "bastion"]);

const PortTargetSchema = z
  .object({
    port: z.number().int().min(1).max(65535),
    proto: z.enum(["tcp", "udp"]).default("tcp"),
    label: z.string().min(1).optional(),
    expose: ExposeSchema.default("public"),
  })
  .strict();

const PortSchema = z.union([
  z
    .number()
    .int()
    .min(1)
    .max(65535)
    .transform((port) => PortTargetSchema.parse({ port })),
  PortTargetSchema,
]);

export type Port = z.infer<typeof PortTargetSchema>;

// The same keys at both levels. `concurrency` is global-only: it caps a
// resource shared by every node.
const baseProbeShape = {
  enabled: z.boolean().optional(),
  interval: Duration.optional(),
  timeout: Duration.optional(),
  retries: z.number().int().min(0).optional(),
} satisfies z.ZodRawShape;

const NodeProbeConfigSchema = z.object(baseProbeShape).strict();

const GlobalProbeConfigSchema = z
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

type GlobalProbeConfig = z.infer<typeof GlobalProbeConfigSchema>;

// No `interval` here: one number cannot mean both "read /proc" and
// "download for ten seconds".
const ProbeDefaultsSchema = z
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

const StorageSchema = z
  .object({
    driver: z.enum(["sqlite"]).default("sqlite"),
    // No default: a relative path follows the working directory, which in a
    // container bypasses the data volume. The collector picks an absolute one.
    path: z.string().min(1).optional(),
    retention: Duration.default(7_776_000), // 90 days
    pruneAt: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM")
      .default("04:00"),
  })
  .strict();

// The token is not here on purpose: a config file gets copied, pasted into
// bug reports and committed. It lives in `EPHOR_TOKEN`.
const ApiSchema = z
  .object({
    enabled: z.boolean().default(true),
    // Configurable only for containers, where 127.0.0.1 is unreachable from
    // the host's port mapping.
    bind: z.string().min(1).default("127.0.0.1"),
    // Unassigned at IANA and below the ephemeral ranges (Linux 32768–60999,
    // macOS 49152–65535): an outgoing connection took 53556 as a source port.
    port: z.number().int().min(1).max(65535).default(31556),
  })
  .strict();

export type ApiSettings = z.infer<typeof ApiSchema>;

// Keyed by metric id, in the metric's own unit, optional everywhere: a
// metric without a threshold is shown and never coloured.
const WorseWhenSchema = z.enum(["above", "below"]);
type WorseWhen = z.infer<typeof WorseWhenSchema>;

const ThresholdSchema = z
  .object({
    warn: z.number().optional(),
    critical: z.number().optional(),
    /** Which side of the number is the bad one. */
    worseWhen: WorseWhenSchema.optional(),
  })
  .strict()
  .superRefine((threshold, context) => {
    const { warn, critical, worseWhen } = threshold;

    if (warn === undefined && critical === undefined) {
      context.addIssue({
        code: "custom",
        message: "a threshold needs warn, critical, or both",
      });
      return;
    }

    if (warn !== undefined && critical !== undefined) {
      if (warn === critical) {
        context.addIssue({
          code: "custom",
          message: `warn and critical must differ; both are ${warn}`,
        });
        return;
      }

      // Two bounds say the direction: 85 → 95 climbs, 50 → 20 falls.
      const implied = critical > warn ? "above" : "below";
      if (worseWhen !== undefined && worseWhen !== implied) {
        context.addIssue({
          code: "custom",
          message:
            `warn ${warn} and critical ${critical} mean the metric is worse ` +
            `${implied}, but worseWhen says ${worseWhen}`,
          path: ["worseWhen"],
        });
      }
      return;
    }

    // One bound cannot imply a direction: 50 Mbit/s is bad below, 50% of a
    // disk is bad above.
    if (worseWhen === undefined) {
      context.addIssue({
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
        : // Present by the rule above; the fallback satisfies the type.
          (threshold.worseWhen ?? "above");

    const resolved: { warn?: number; critical?: number; worseWhen: WorseWhen } =
      { worseWhen };

    if (warn !== undefined) resolved.warn = warn;
    if (critical !== undefined) resolved.critical = critical;

    return resolved;
  });

export type Threshold = z.infer<typeof ThresholdSchema>;

// `null` on a node drops an inherited threshold; an invented `warn: 200`
// would hide a real problem instead.
const ThresholdsSchema = optionalSection(
  z.record(z.string().min(1), ThresholdSchema.nullable()).default({}),
);

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

const NodeSchema = z.object(nodeShape).strict();
export type Node = z.infer<typeof NodeSchema>;

/** Not baked in: registering a probe is what makes its section valid. */
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
      .transform((raw, context): Record<string, GlobalProbeConfig> => {
        for (const name of Object.keys(raw)) {
          if (globalByName.has(name)) continue;
          context.addIssue(unknownProbeIssue(name, knownNames));
        }

        const parsed: Record<string, GlobalProbeConfig> = {};

        // Every registered probe gets an entry, so its defaults apply
        // whether or not the user wrote its section.
        for (const [name, schema] of globalByName) {
          const result = schema.safeParse(raw[name] ?? {});

          if (!result.success) {
            for (const issue of result.error.issues) {
              context.addIssue({ ...issue, path: [name, ...issue.path] });
            }
            continue;
          }

          // The schema extends the shared shape, so the data is a superset.
          parsed[name] = result.data as GlobalProbeConfig;
        }

        return parsed;
      }),
  );

  const NodeWithKnownProbesSchema = NodeSchema.superRefine((node, context) => {
    for (const name of Object.keys(node.probes)) {
      if (globalByName.has(name)) continue;
      context.addIssue({
        ...unknownProbeIssue(name, knownNames),
        path: ["probes"],
      });
    }

    checkThresholdKeys(node.thresholds, knownNames, context, ["thresholds"]);
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
    .superRefine((config, context) => {
      checkThresholdKeys(config.thresholds, knownNames, context, [
        "thresholds",
      ]);
    })
    .refine(
      (config) =>
        new Set(config.nodes.map((node) => node.name)).size ===
        config.nodes.length,
      { message: "node names must be unique", path: ["nodes"] },
    );
}

// Only the probe part of a metric id can be checked: no probe declares the
// metrics it writes yet, so `system.disk_percnet` still slips through.
function checkThresholdKeys(
  thresholds: Readonly<Record<string, unknown>>,
  knownNames: readonly string[],
  context: z.RefinementCtx,
  basePath: PropertyKey[],
): void {
  for (const metric of Object.keys(thresholds)) {
    const probe = metric.split(".")[0];
    if (probe !== undefined && knownNames.includes(probe)) continue;

    context.addIssue({
      code: "custom",
      message:
        `Metric "${metric}" belongs to no known probe. A metric id starts ` +
        `with its probe: ${knownNames.join(", ")}`,
      path: [...basePath, metric],
    });
  }
}

export type Config = z.infer<ReturnType<typeof buildConfigSchema>>;

// A probe setting named like a shared key would be stripped as a shared key
// and quietly do nothing; refused at build time instead.
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

// A blanked YAML section is `null`, which neither `.default()` nor
// `.prefault()` covers.
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
