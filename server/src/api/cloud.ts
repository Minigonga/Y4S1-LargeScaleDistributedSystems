import { ShoppingListServer } from './server';
import cloudConfig from './cloudConfig.json';
import { hashKey, hashNode } from './partitioning';
import { VectorClock } from '../crdt/VectorClock';

interface Node {
  server: ShoppingListServer;
  port: number;
}

interface RingNode {
  port: number;
  hash: bigint;
}

/**
 * Manages the distributed cloud infrastructure using Dynamo-style architecture.
 * Creates a hash ring of storage nodes with configurable replication factor (N=3).
 */
export class ShoppingListCloud {
  private nodes: Node[] = [];
  private ring: RingNode[] = [];
  private replicaCount = 3;
  private R: number;
  private W: number;

  constructor() {
    this.W = Math.ceil(this.replicaCount / 2);
    this.R = Math.ceil(this.replicaCount / 2);
    this.initializeNodes();
    this.initializeRing();
  }

  private initializeNodes() {
    for (let i = 0; i < cloudConfig.numServers; i++) {
      const port = cloudConfig.servers[i];
      const node = new ShoppingListServer(port);
      this.nodes.push({ server: node, port });
    }
  }

  private initializeRing() {
    this.ring = this.nodes
      .map(node => ({ port: node.port, hash: hashNode(node.port) }))
      .sort((a, b) => (a.hash < b.hash ? -1 : 1));

    console.log(
      'Consistent Hash Ring:',
      this.ring.map(n => `${n.port}:${n.hash.toString().slice(0, 6)}`).join(' -> ')
    );
  }

  public getReplicas(key: string): number[] {
    if (this.ring.length === 0) throw new Error('Hash ring not initialized');

    const keyHash = hashKey(key);
    let idx = this.ring.findIndex(n => n.hash >= keyHash);
    if (idx === -1) idx = 0;

    const replicas: number[] = [];
    for (let i = 0; i < this.replicaCount; i++) {
      replicas.push(this.ring[(idx + i) % this.ring.length].port);
    }

    return replicas;
  }

  public async startCloud() {
    for (const node of this.nodes) {
      await node.server.start();
      console.log(`Node running at http://localhost:${node.port}`);
    }

    await this.initializeMessaging();
  }

  private async initializeMessaging() {
    const total = this.nodes.length;
    const coordinatorPort = cloudConfig.coordinator.zmqPort;

    for (let i = 0; i < total; i++) {
      const node = this.nodes[i];
      
      // For quorum to work with N=3, each node needs to connect to ALL other nodes
      const allOtherZmqPorts: number[] = [];
      
      for (let j = 0; j < total; j++) {
        if (i !== j) {
          const otherHttpPort = cloudConfig.servers[j];
          allOtherZmqPorts.push(otherHttpPort + cloudConfig.storage.zmqPortOffset);
        }
      }

      const repPort = node.port + cloudConfig.storage.zmqPortOffset;
      console.log(
        `Node ${node.port}: ZMQ REP on ${repPort}, connecting to all nodes: ${allOtherZmqPorts.join(', ')}`
      );

      await node.server.initMessaging(repPort, allOtherZmqPorts, coordinatorPort);
    }
  }
}
