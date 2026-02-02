import { PNCounter } from '../src/crdt/PNCounter';

describe('PNCounter', () => {
  let counter: PNCounter;

  beforeEach(() => {
    counter = new PNCounter('node1');
  });

  describe('constructor', () => {
    it('should initialize with value 0', () => {
      expect(counter.value()).toBe(0);
    });
  });

  describe('increment', () => {
    it('should increment by 1 by default', () => {
      counter.increment();
      expect(counter.value()).toBe(1);
    });

    it('should increment by specified amount', () => {
      counter.increment(5);
      expect(counter.value()).toBe(5);
    });

    it('should accumulate increments', () => {
      counter.increment(3);
      counter.increment(2);
      expect(counter.value()).toBe(5);
    });
  });

  describe('decrement', () => {
    it('should decrement by 1 by default', () => {
      counter.increment(5);
      counter.decrement();
      expect(counter.value()).toBe(4);
    });

    it('should decrement by specified amount', () => {
      counter.increment(10);
      counter.decrement(3);
      expect(counter.value()).toBe(7);
    });

    it('should allow negative values', () => {
      counter.decrement(5);
      expect(counter.value()).toBe(-5);
    });
  });

  describe('merge', () => {
    it('should merge counters from different nodes', () => {
      const counter1 = new PNCounter('node1');
      const counter2 = new PNCounter('node2');
      
      counter1.increment(5);
      counter2.increment(3);
      
      counter1.merge(counter2);
      expect(counter1.value()).toBe(8);
    });

    it('should take max of each node counter on merge', () => {
      const counter1 = new PNCounter('node1');
      const counter2 = new PNCounter('node1'); // Same node
      
      counter1.increment(5);
      counter2.increment(3);
      
      counter1.merge(counter2);
      expect(counter1.value()).toBe(5); // Max of 5 and 3
    });

    it('should be commutative', () => {
      const c1a = new PNCounter('node1');
      const c1b = new PNCounter('node1');
      const c2a = new PNCounter('node2');
      const c2b = new PNCounter('node2');
      
      c1a.increment(3);
      c1b.increment(3);
      c2a.increment(5);
      c2b.increment(5);
      
      c1a.merge(c2a);
      c2b.merge(c1b);
      
      expect(c1a.value()).toBe(c2b.value());
    });

    it('should be associative', () => {
      const c1 = new PNCounter('node1');
      const c2 = new PNCounter('node2');
      const c3 = new PNCounter('node3');
      
      c1.increment(2);
      c2.increment(3);
      c3.increment(4);
      
      // (c1 merge c2) merge c3
      const result1 = new PNCounter('node1');
      result1.merge(c1);
      result1.merge(c2);
      result1.merge(c3);
      
      // c1 merge (c2 merge c3)
      const temp = new PNCounter('node2');
      temp.merge(c2);
      temp.merge(c3);
      const result2 = new PNCounter('node1');
      result2.merge(c1);
      result2.merge(temp);
      
      expect(result1.value()).toBe(result2.value());
    });

    it('should be idempotent', () => {
      const counter1 = new PNCounter('node1');
      const counter2 = new PNCounter('node2');
      
      counter1.increment(5);
      counter2.increment(3);
      
      counter1.merge(counter2);
      const valueAfterFirst = counter1.value();
      
      counter1.merge(counter2);
      expect(counter1.value()).toBe(valueAfterFirst);
    });

    it('should handle concurrent increments and decrements', () => {
      const counter1 = new PNCounter('node1');
      const counter2 = new PNCounter('node2');
      
      counter1.increment(10);
      counter1.decrement(3);
      
      counter2.increment(5);
      counter2.decrement(2);
      
      counter1.merge(counter2);
      
      // node1: +10, -3 = 7
      // node2: +5, -2 = 3
      // merged: 7 + 3 = 10
      expect(counter1.value()).toBe(10);
    });
  });

  describe('getState and setState', () => {
    it('should serialize and deserialize correctly', () => {
      counter.increment(5);
      counter.decrement(2);
      
      const state = counter.getState();
      
      const newCounter = new PNCounter('node2');
      newCounter.setState(state);
      
      expect(newCounter.value()).toBe(3);
    });
  });
});
