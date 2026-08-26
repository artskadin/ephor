export class ConcurrencyLimiter {
  private activeCount = 0;
  private readonly waitingResolvers: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {
    if (maxConcurrent < 1) {
      throw new Error(`maxConcurrent must be at least 1, got ${maxConcurrent}`);
    }
  }

  get active(): number {
    return this.activeCount;
  }

  get pending(): number {
    return this.waitingResolvers.length;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquireSlot();

    try {
      return await operation();
    } finally {
      this.releaseSlot();
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++;

      return;
    }

    return new Promise<void>((resolve) => {
      this.waitingResolvers.push(resolve);
    });
  }

  private releaseSlot(): void {
    const nextInQueue = this.waitingResolvers.shift();

    if (nextInQueue) {
      nextInQueue();
    } else {
      this.activeCount--;
    }
  }
}
