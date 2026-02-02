import { GCounter } from './GCounter';

export class PNCounter {
  private p: GCounter;
  private n: GCounter;
  private _nodeId: string;

  constructor(nodeId: string, initialValue: number = 0) {
    this._nodeId = nodeId;
    this.p = new GCounter(nodeId);
    this.n = new GCounter(nodeId);

    if (initialValue > 0) {
      this.p.increment(initialValue);
    } else if (initialValue < 0) {
      this.n.increment(-initialValue);
    }
  }

  get nodeId(): string {
    return this._nodeId;
  }

  increment(amount: number = 1) {
    this.p.increment(amount);
  }

  decrement(amount: number = 1) {
    this.n.increment(amount);
  }

  value(): number {
    return this.p.value - this.n.value;
  }

  merge(other: PNCounter) {
    this.p.merge(other.p);
    this.n.merge(other.n);
  }

  getState() {
    return { 
      p: this.p.getState(), 
      n: this.n.getState(),
      nodeId: this._nodeId
    };
  }

  setState(state: { p: [string, number][], n: [string, number][], nodeId?: string }) {
    this.p.setState(state.p);
    this.n.setState(state.n);
    if (state.nodeId) {
      this._nodeId = state.nodeId;
    }
  }
}
