import { VectorClock } from '../src/crdt/VectorClock';

describe('VectorClock', () => {
  let clock: VectorClock;

  beforeEach(() => {
    clock = new VectorClock();
  });

  test('should initialize with empty clocks', () => {
    expect(clock.toString()).toBe('{}');
  });

  test('should increment node counter', () => {
    clock.increment('node1');
    expect(clock.toString()).toBe('{"node1":1}');
    
    clock.increment('node1');
    expect(clock.toString()).toBe('{"node1":2}');
  });

  test('should increment different nodes independently', () => {
    clock.increment('node1');
    clock.increment('node2');
    clock.increment('node1');
    
    const parsed = JSON.parse(clock.toString());
    expect(parsed.node1).toBe(2);
    expect(parsed.node2).toBe(1);
  });

  test('should merge clocks correctly', () => {
    const clock1 = new VectorClock();
    const clock2 = new VectorClock();
    
    clock1.increment('node1');
    clock1.increment('node1');
    clock1.increment('node2');
    
    clock2.increment('node2');
    clock2.increment('node2');
    clock2.increment('node3');
    
    clock1.merge(clock2);
    
    const parsed = JSON.parse(clock1.toString());
    expect(parsed.node1).toBe(2);
    expect(parsed.node2).toBe(2); // Takes max(1, 2)
    expect(parsed.node3).toBe(1);
  });

  describe('compare', () => {
    test('should return equal for identical clocks', () => {
      const clock1 = new VectorClock();
      const clock2 = new VectorClock();
      
      clock1.increment('node1');
      clock2.increment('node1');
      
      expect(clock1.compare(clock2)).toBe('equal');
    });

    test('should return before when strictly smaller', () => {
      const clock1 = new VectorClock();
      const clock2 = new VectorClock();
      
      clock1.increment('node1'); // {node1:1}
      clock2.increment('node1'); // {node1:1}
      clock2.increment('node1'); // {node1:2}
      
      expect(clock1.compare(clock2)).toBe('before');
    });

    test('should return after when strictly larger', () => {
      const clock1 = new VectorClock();
      const clock2 = new VectorClock();
      
      clock1.increment('node1');
      clock1.increment('node1'); // {node1:2}
      clock2.increment('node1'); // {node1:1}
      
      expect(clock1.compare(clock2)).toBe('after');
    });

    test('should return concurrent for divergent updates', () => {
      const clock1 = new VectorClock();
      const clock2 = new VectorClock();
      
      clock1.increment('node1'); // {node1:1}
      clock2.increment('node2'); // {node2:1}
      
      expect(clock1.compare(clock2)).toBe('concurrent');
    });

    test('should handle mixed convergent and divergent', () => {
      const clock1 = new VectorClock();
      const clock2 = new VectorClock();
      
      clock1.increment('node1'); // {node1:1}
      clock1.increment('node2'); // {node1:1, node2:1}
      
      clock2.increment('node1'); // {node1:1}
      clock2.increment('node3'); // {node1:1, node3:1}
      
      expect(clock1.compare(clock2)).toBe('concurrent');
    });
  });

  test('should serialize and deserialize correctly', () => {
    clock.increment('node1');
    clock.increment('node2');
    clock.increment('node1');
    
    const serialized = clock.toString();
    const newClock = new VectorClock();
    newClock.fromString(serialized);
    
    expect(newClock.toString()).toBe(serialized);
    expect(newClock.compare(clock)).toBe('equal');
  });

  describe('edge cases', () => {
    test('should handle empty clock comparison', () => {
      const clock1 = new VectorClock();
      const clock2 = new VectorClock();
      
      expect(clock1.compare(clock2)).toBe('equal');
    });

    test('should handle comparison with empty clock', () => {
      const clock1 = new VectorClock();
      const clock2 = new VectorClock();
      
      clock1.increment('node1');
      
      expect(clock1.compare(clock2)).toBe('after');
      expect(clock2.compare(clock1)).toBe('before');
    });

    test('should handle many nodes', () => {
      const nodes = Array.from({ length: 100 }, (_, i) => `node${i}`);
      
      nodes.forEach(node => clock.increment(node));
      
      const parsed = JSON.parse(clock.toString());
      nodes.forEach(node => {
        expect(parsed[node]).toBe(1);
      });
    });

    test('should merge with empty clock', () => {
      clock.increment('node1');
      const emptyClock = new VectorClock();
      
      clock.merge(emptyClock);
      expect(JSON.parse(clock.toString())['node1']).toBe(1);
      
      emptyClock.merge(clock);
      expect(JSON.parse(emptyClock.toString())['node1']).toBe(1);
    });

    test('should handle fromString with invalid JSON', () => {
      expect(() => clock.fromString('invalid')).toThrow();
    });

    test('should handle fromString with empty object', () => {
      clock.fromString('{}');
      expect(clock.toString()).toBe('{}');
    });
  });
});