export class GCounter {
  private counts: Map<string, number>;
  private nodeId: string;

  constructor(nodeId: string) {
    this.counts = new Map();
    this.nodeId = nodeId;
    this.counts.set(nodeId, 0);
  }

  increment(amount: number = 1): void {
    const current = this.counts.get(this.nodeId) || 0;
    this.counts.set(this.nodeId, current + amount);
  }

  get value(): number {
    let total = 0;
    for (const count of this.counts.values()) {
      total += count;
    }
    return total;
  }

  merge(other: GCounter): void {
    for (const [nodeId, count] of other.counts) {
      const current = this.counts.get(nodeId) || 0;
      this.counts.set(nodeId, Math.max(current, count));
    }
  }

  getState(): [string, number][] {
    return Array.from(this.counts.entries());
  }

  setState(state: [string, number][]): void {
    this.counts = new Map(state);
  }
}
