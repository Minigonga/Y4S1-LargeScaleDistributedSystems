import * as crypto from 'crypto';

// Mock the actual functions from partitioning.ts
function hashKey(key: string): bigint {
  return BigInt('0x' + crypto.createHash('sha1').update(key).digest('hex'));
}

function hashNode(port: number): bigint {
  return hashKey(port.toString());
}

class ConsistentHashRing {
  private ring: Array<{port: number, hash: bigint}> = [];
  private replicaCount: number;

  constructor(ports: number[], replicaCount: number = 3) {
    this.replicaCount = replicaCount;
    this.initializeRing(ports);
  }

  private initializeRing(ports: number[]): void {
    this.ring = ports
      .map(port => ({ port, hash: hashNode(port) }))
      .sort((a, b) => (a.hash < b.hash ? -1 : 1));
  }

  public getReplicas(key: string): number[] {
    if (this.ring.length === 0) {
      throw new Error('Cannot get replicas from empty ring');
    }
    
    const keyHash = hashKey(key);
    let idx = this.ring.findIndex(n => n.hash >= keyHash);
    if (idx === -1) idx = 0;

    const replicas: number[] = [];
    for (let i = 0; i < this.replicaCount; i++) {
      replicas.push(this.ring[(idx + i) % this.ring.length].port);
    }

    return replicas;
  }

  public getRing() {
    return this.ring;
  }
}

describe('Consistent Hashing', () => {
  const PORTS = [5000, 5001, 5002, 5003, 5004];
  
  test('should create sorted hash ring', () => {
    const ring = new ConsistentHashRing(PORTS);
    const hashRing = ring.getRing();
    
    expect(hashRing).toHaveLength(PORTS.length);
    
    // Verify sorting
    for (let i = 1; i < hashRing.length; i++) {
      expect(hashRing[i].hash).toBeGreaterThan(hashRing[i-1].hash);
    }
    
    // All ports should be present
    const ringPorts = hashRing.map(n => n.port);
    expect(ringPorts.sort()).toEqual(PORTS.sort());
  });

  test('should distribute keys to correct number of replicas', () => {
    const ring = new ConsistentHashRing(PORTS, 3);
    const testKeys = ['list1', 'list2', 'shopping-list', 'user-123-list'];
    
    testKeys.forEach(key => {
      const replicas = ring.getReplicas(key);
      expect(replicas).toHaveLength(3);
      expect(new Set(replicas).size).toBe(3); // No duplicates
    });
  });

  test('should always return same replicas for same key', () => {
    const ring = new ConsistentHashRing(PORTS);
    const key = 'consistent-test-key';
    
    const replicas1 = ring.getReplicas(key);
    const replicas2 = ring.getReplicas(key);
    const replicas3 = ring.getReplicas(key);
    
    expect(replicas1).toEqual(replicas2);
    expect(replicas2).toEqual(replicas3);
  });

  test('should wrap around ring when reaching end', () => {
    const smallRing = new ConsistentHashRing([5000, 5001], 3);
    // With only 2 nodes but 3 replicas requested, should wrap
    const replicas = smallRing.getReplicas('test-key');
    
    expect(replicas).toHaveLength(3);
    // Should include both nodes, with one repeated
    expect(new Set(replicas).size).toBeLessThanOrEqual(2);
  });

  test('should handle empty ring gracefully', () => {
    const ring = new ConsistentHashRing([], 3);
    expect(() => ring.getReplicas('test')).toThrow('Cannot get replicas from empty ring');
  });

  test('should handle single node ring', () => {
    const ring = new ConsistentHashRing([5000], 3);
    const replicas = ring.getReplicas('test-key');
    
    expect(replicas).toHaveLength(3);
    expect(replicas.every(p => p === 5000)).toBe(true);
  });

  test('should handle replica count larger than ring size', () => {
    const ring = new ConsistentHashRing([5000, 5001], 5);
    const replicas = ring.getReplicas('test-key');
    
    expect(replicas).toHaveLength(5);
    // Should contain both ports, cycling through
    expect(replicas.filter(p => p === 5000).length).toBeGreaterThan(0);
    expect(replicas.filter(p => p === 5001).length).toBeGreaterThan(0);
  });

  test('should demonstrate minimal disruption on node addition', () => {
    // Test that most keys don't move when adding a node
    const originalPorts = [5000, 5001, 5002];
    const newPorts = [5000, 5001, 5002, 5003];
    
    const originalRing = new ConsistentHashRing(originalPorts, 2);
    const newRing = new ConsistentHashRing(newPorts, 2);
    
    const testKeys = Array.from({length: 100}, (_, i) => `key-${i}`);
    let movedKeys = 0;
    
    for (const key of testKeys) {
      const originalReplicas = originalRing.getReplicas(key);
      const newReplicas = newRing.getReplicas(key);
      
      // Check if primary replica changed
      if (originalReplicas[0] !== newReplicas[0]) {
        movedKeys++;
      }
    }
    
    // In consistent hashing, only K/N keys should move where K=keys, N=nodes
    // With 100 keys and adding 1 node to 3, ~25 keys should move
    const expectedMoveRatio = 1 / (originalPorts.length + 1); // ~25%
    const actualMoveRatio = movedKeys / testKeys.length;
    
    console.log(`Keys moved after adding node: ${movedKeys}/${testKeys.length} (${(actualMoveRatio*100).toFixed(1)}%)`);
    expect(actualMoveRatio).toBeLessThan(0.5); // Less than 50% should move
  });
  
  test('should demonstrate minimal disruption on node removal', () => {
    const originalPorts = [5000, 5001, 5002, 5003];
    const reducedPorts = [5000, 5001, 5002]; // Remove 5003
    
    const originalRing = new ConsistentHashRing(originalPorts, 2);
    const reducedRing = new ConsistentHashRing(reducedPorts, 2);
    
    const testKeys = Array.from({length: 100}, (_, i) => `key-${i}`);
    let movedKeys = 0;
    
    for (const key of testKeys) {
      const originalReplicas = originalRing.getReplicas(key);
      const reducedReplicas = reducedRing.getReplicas(key);
      
      if (originalReplicas[0] !== reducedReplicas[0]) {
        movedKeys++;
      }
    }
    
    const actualMoveRatio = movedKeys / testKeys.length;
    console.log(`Keys moved after removing node: ${movedKeys}/${testKeys.length} (${(actualMoveRatio*100).toFixed(1)}%)`);
    expect(actualMoveRatio).toBeLessThan(0.5);
  });
});