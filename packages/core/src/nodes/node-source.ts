import type { Node } from "../config/schema.js";

export interface NodeSource {
  readonly id: string;
  load(): Promise<Node[]>;
}

export class StaticNodeSource implements NodeSource {
  readonly id = "config";

  constructor(private readonly nodes: readonly Node[]) {}

  async load(): Promise<Node[]> {
    return [...this.nodes];
  }
}
