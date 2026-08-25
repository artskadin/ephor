import type { Probe } from "@ephor/core";

export class ProbeRegistry {
  private readonly probes = new Map<string, Probe>();

  register(probe: Probe): void {
    if (this.probes.has(probe.name)) {
      throw new Error(`Probe "${probe.name}" is already registered`);
    }

    this.probes.set(probe.name, probe);
  }

  get(name: string): Probe | undefined {
    return this.probes.get(name);
  }

  names(): string[] {
    return [...this.probes.keys()];
  }
}
