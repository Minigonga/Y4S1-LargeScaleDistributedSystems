/**
 * Static utilities for comparing vector clocks.
 * Vector clocks track causality in distributed systems - each node maintains
 * a counter, and comparing clocks reveals happened-before relationships.
 */
export const VectorClockOps = {
  /**
   * Compares two vector clocks to determine causal ordering.
   * @returns 'before' if a happened-before b, 'after' if a happened-after b,
   *          'concurrent' if neither happened-before the other, 'equal' if identical.
   */
  compare(
    a: { [nodeId: string]: number },
    b: { [nodeId: string]: number }
  ): 'before' | 'after' | 'concurrent' | 'equal' {
    let aGreater = false;
    let bGreater = false;

    const allNodes = new Set([...Object.keys(a), ...Object.keys(b)]);

    for (const nodeId of allNodes) {
      const aCount = a[nodeId] || 0;
      const bCount = b[nodeId] || 0;

      if (aCount > bCount) {
        aGreater = true;
      } else if (aCount < bCount) {
        bGreater = true;
      }
    }

    if (aGreater && !bGreater) return 'after';
    if (!aGreater && bGreater) return 'before';
    if (aGreater && bGreater) return 'concurrent';
    return 'equal';
  }
};
