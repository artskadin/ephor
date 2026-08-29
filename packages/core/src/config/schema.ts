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
  });

  return z
    .object({
      probeDefaults: optionalSection(ProbeDefaultsSchema.prefault({})),
      probes: GlobalProbesSchema,
      nodes: z.array(NodeWithKnownProbesSchema).min(1, "at least one node"),
      storage: optionalSection(StorageSchema.prefault({})),
    })
    .strict()
    .refine(
      (config) =>
        new Set(config.nodes.map((node) => node.name)).size ===
        config.nodes.length,
      { message: "node names must be unique", path: ["nodes"] },
    );
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
