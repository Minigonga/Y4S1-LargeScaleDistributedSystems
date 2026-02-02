/**
 * Vector clock for tracking causality in distributed systems.
 * Each node maintains a counter; comparing clocks reveals happened-before relationships.
 */
export class VectorClock {
  private clocks: { [nodeId: string]: number } = {};

  increment(nodeId: string): void {
    this.clocks[nodeId] = (this.clocks[nodeId] || 0) + 1;
  }

  /** 
   * Merges another vector clock into this one (component-wise max). 
   */
  merge(other: VectorClock): void {
    for (const [nodeId, count] of Object.entries(other.clocks)) {
      this.clocks[nodeId] = Math.max(this.clocks[nodeId] || 0, count);
    }
  }

  compare(other: VectorClock): 'before' | 'after' | 'concurrent' | 'equal' {
    let thisGreater = false;
    let otherGreater = false;

    const allNodes = new Set([
      ...Object.keys(this.clocks),
      ...Object.keys(other.clocks)
    ]);

    for (const nodeId of allNodes) {
      const thisCount = this.clocks[nodeId] || 0;
      const otherCount = other.clocks[nodeId] || 0;

      if (thisCount > otherCount) {
        thisGreater = true;
      } else if (thisCount < otherCount) {
        otherGreater = true;
      }
    }

    if (thisGreater && !otherGreater) return 'after';
    if (!thisGreater && otherGreater) return 'before';
    if (thisGreater && otherGreater) return 'concurrent';
    return 'equal';
  }

  /**
   * Static comparison of two vector clock objects (plain objects, not VectorClock instances).
   * Returns the causal relationship between clock1 and clock2.
   */
  static compare(
    clock1: Record<string, number>, 
    clock2: Record<string, number>
  ): 'before' | 'after' | 'concurrent' | 'equal' {
    let clock1Greater = false;
    let clock2Greater = false;

    const allNodes = new Set([
      ...Object.keys(clock1 || {}),
      ...Object.keys(clock2 || {})
    ]);

    for (const nodeId of allNodes) {
      const count1 = (clock1 || {})[nodeId] || 0;
      const count2 = (clock2 || {})[nodeId] || 0;

      if (count1 > count2) {
        clock1Greater = true;
      } else if (count1 < count2) {
        clock2Greater = true;
      }
    }

    if (clock1Greater && !clock2Greater) return 'after';
    if (!clock1Greater && clock2Greater) return 'before';
    if (clock1Greater && clock2Greater) return 'concurrent';
    return 'equal';
  }

  toObject(): { [nodeId: string]: number } {
    return { ...this.clocks };
  }

  fromObject(obj: { [nodeId: string]: number }): void {
    this.clocks = { ...obj };
  }

  toString(): string {
    return JSON.stringify(this.clocks);
  }

  fromString(str: string): void {
    this.clocks = JSON.parse(str);
  }
}