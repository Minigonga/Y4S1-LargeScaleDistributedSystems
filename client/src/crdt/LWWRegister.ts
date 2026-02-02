export class LWWRegister<T> {
  private value: T;
  private timestamp: number;
  private nodeId: string;

  constructor(initialValue: T, nodeId: string) {
    this.value = initialValue;
    this.timestamp = Date.now();
    this.nodeId = nodeId;
  }

  getValue(): T {
    return this.value;
  }

  getNodeId(): string {
    return this.nodeId;
  }

  setValue(newValue: T, nodeId: string): void {
    this.value = newValue;
    this.timestamp = Date.now();
    this.nodeId = nodeId;
  }

  merge(other: LWWRegister<T>): void {
    if (
      other.timestamp > this.timestamp ||
      (other.timestamp === this.timestamp && other.nodeId > this.nodeId)
    ) {
      this.value = other.value;
      this.timestamp = other.timestamp;
      this.nodeId = other.nodeId;
    }
  }

  getState() {
    return {
      value: this.value,
      timestamp: this.timestamp,
      nodeId: this.nodeId
    };
  }

  static fromState<T>(state: {
    value: T;
    timestamp: number;
    nodeId: string;
  }): LWWRegister<T> {
    const reg = new LWWRegister(state.value, state.nodeId);
    reg.timestamp = state.timestamp;
    return reg;
  }
}
