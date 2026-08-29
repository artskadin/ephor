import type { Probe, ProbeDescriptor } from "@ephor/core";

export class ProbeRegistry {
  private readonly probes = new Map<string, Probe>();

  register(probe: Probe): void {
    const { name } = probe.descriptor;

    if (this.probes.has(name)) {
      throw new Error(`Probe "${name}" is already registered`);
    }

    this.probes.set(name, probe);
  }

  get(name: string): Probe | undefined {
    return this.probes.get(name);
  }

  names(): string[] {
    return [...this.probes.keys()];
  }

  descriptors(): ProbeDescriptor[] {
    return [...this.probes.values()].map((probe) => probe.descriptor);
  }
}
