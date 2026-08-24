import { z } from "zod";
import { Duration } from "./duration.js";

export const SshSchema = z.object({
  alias: z.string().optional(),
  user: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(22),
  key: z.string().optional(),
  jump: z.string().optional(),
});

export const ExposeSchema = z.enum(["public", "local", "bastion"]);

export const PortSchema = z.object({
  port: z.number().int().min(1).max(65535),
  proto: z.enum(["tcp", "udp"]).default("tcp"),
  label: z.string().min(1),
  expose: ExposeSchema.default("public"),
});

export const CheckOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  interval: Duration.optional(),
  timeout: Duration.optional(),
  retries: z.number().int().min(0).optional(),
});

export const NodeSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, "letters, digits, - and _"),
  host: z.string().min(1),
  domain: z.string().optional(),
  tags: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  local: z.boolean().default(false),
  ssh: SshSchema.optional(),
  ports: z.array(PortSchema).default([]),
  checks: z.record(z.string(), CheckOverrideSchema).default({}),
});

export const DefaultSchema = z.object({
  interval: Duration.default(300),
  timeout: Duration.default(10),
  retries: z.number().int().min(0).default(2),
});

export const ConfigSchema = z.object({
  defaults: DefaultSchema.prefault({}),
  nodes: z.array(NodeSchema).min(1, "at least one node required"),
});

export type Ssh = z.infer<typeof SshSchema>;
export type Port = z.infer<typeof PortSchema>;
export type CheckOverride = z.infer<typeof CheckOverrideSchema>;
export type Node = z.infer<typeof NodeSchema>;
export type Defaults = z.infer<typeof DefaultSchema>;
export type Config = z.infer<typeof ConfigSchema>;
