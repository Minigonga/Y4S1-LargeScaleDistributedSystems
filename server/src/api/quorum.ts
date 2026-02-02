import { Request } from 'zeromq';
import { VectorClock } from '../crdt/VectorClock';
import cloudConfig from './cloudConfig.json';
import { hashKey } from './partitioning';

/**
 * Simple mutex for serializing socket operations.
 */
class SocketMutex {
  private locked: boolean = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }
}

/**
 * Quorum coordinator for Dynamo-style distributed operations.
 * Implements N/R/W quorum parameters for strong consistency.
 */
export class QuorumCoordinator {
  private N: number; // Replication factor
  private R: number; // Read quorum
  private W: number; // Write quorum
  private allNodes: number[]; // All server ports
  private reqSockets: Map<number, Request>;
  private socketMutexes: Map<number, SocketMutex>; // Per-socket mutex for serialization
  private localPort: number; // Current node's HTTP port

  constructor(reqSockets: Map<number, Request>, localPort: number) {
    this.N = cloudConfig.quorum.N;
    this.R = cloudConfig.quorum.R;
    this.W = cloudConfig.quorum.W;
    this.allNodes = cloudConfig.servers;
    this.reqSockets = reqSockets;
    this.localPort = localPort;
    
    // Initialize mutexes for each socket
    this.socketMutexes = new Map();
    for (const [port] of reqSockets) {
      this.socketMutexes.set(port, new SocketMutex());
    }

    // Validate quorum configuration
    if (this.R + this.W <= this.N) {
      console.warn(`⚠️ Quorum config (N=${this.N}, R=${this.R}, W=${this.W}) does not guarantee strong consistency. R+W should be > N.`);
    }
  }

  /**
   * Determines which N nodes should store a given key using consistent hashing.
   */
  private getReplicaNodes(key: string): number[] {
    const keyHash = hashKey(key);
    
    // Sort nodes by their hash distance from the key
    const nodeDistances = this.allNodes.map(port => {
      const nodeHash = hashKey(port.toString());
      // Calculate circular distance
      const distance = nodeHash >= keyHash 
        ? nodeHash - keyHash 
        : (BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF') - keyHash) + nodeHash;
      return { port, distance };
    });

    // Sort by distance and take first N nodes
    nodeDistances.sort((a, b) => Number(a.distance - b.distance));
    return nodeDistances.slice(0, this.N).map(n => n.port);
  }

  /**
   * Performs a quorum write operation.
   * Sends data to N replica nodes and waits for W confirmations.
   * Returns true if write quorum is met, false otherwise.
   */
  async quorumWrite(key: string, operation: any, timeoutMs: number = 1000): Promise<{
    success: boolean;
    successfulNodes: number[];
    failedNodes: number[];
  }> {
    const replicas = this.getReplicaNodes(key);
    console.log(`📝 Quorum write for key "${key}" to replicas: ${replicas.join(', ')} (W=${this.W})`);

    // Separate local and remote replicas
    const localReplica = replicas.find(port => port === this.localPort);
    const remoteReplicas = replicas.filter(port => port !== this.localPort);

    const successfulNodes: number[] = [];
    const failedNodes: number[] = [];

    // Local write is already done before calling quorumWrite, count it as successful
    if (localReplica) {
      successfulNodes.push(localReplica);
      console.log(`  ✅ Local write on node ${localReplica} (already completed)`);
    }

    // Send to remote replicas
    const results = await Promise.allSettled(
      remoteReplicas.map(port => this.sendToNode(port, operation, timeoutMs))
    );

    results.forEach((result, idx) => {
      const port = remoteReplicas[idx];
      if (result.status === 'fulfilled' && result.value && result.value.status === 'ok') {
        successfulNodes.push(port);
        console.log(`  ✅ Remote write succeeded on node ${port}`);
      } else {
        failedNodes.push(port);
        if (result.status === 'fulfilled') {
          console.error(`  ❌ Node ${port} returned non-ok status`, result.value);
        } else if (result.status === 'rejected') {
          console.error(`  ❌ Failed to write to node ${port}:`, result.reason?.message || result.reason);
        }
      }
    });

    const success = successfulNodes.length >= this.W;
    
    if (success) {
      console.log(`✅ Write quorum met: ${successfulNodes.length}/${this.N} nodes (W=${this.W})`);
    } else {
      console.error(`❌ Write quorum failed: ${successfulNodes.length}/${this.N} nodes (W=${this.W} required)`);
    }

    return { success, successfulNodes, failedNodes };
  }

  /**
   * Performs a quorum read operation.
   * Reads from N replica nodes and waits for R responses.
   * Returns the most recent version based on vector clock comparison.
   */
  async quorumRead(key: string, type: 'list' | 'item', timeoutMs: number = 1000): Promise<any | null> {
    const replicas = this.getReplicaNodes(key);
    console.log(`📖 Quorum read for key "${key}" from replicas: ${replicas.join(', ')} (R=${this.R})`);

    const operation = {
      type: 'READ',
      key,
      dataType: type
    };

    const results = await Promise.allSettled(
      replicas.map(port => this.sendToNode(port, operation, timeoutMs))
    );

    const validResponses: Array<{ port: number; data: any }> = [];

    results.forEach((result, idx) => {
      const port = replicas[idx];
      if (result.status === 'fulfilled' && result.value && result.value.data) {
        validResponses.push({ port, data: result.value.data });
      }
    });

    if (validResponses.length < this.R) {
      console.error(`❌ Read quorum failed: ${validResponses.length}/${this.N} nodes (R=${this.R} required)`);
      return null;
    }

    console.log(`✅ Read quorum met: ${validResponses.length}/${this.N} nodes (R=${this.R})`);

    // If only one response or all responses are identical, return it
    if (validResponses.length === 1) {
      return validResponses[0].data;
    }

    // Find the most recent version using vector clock comparison
    let mostRecent = validResponses[0].data;
    let mostRecentVC = new VectorClock();
    
    if (mostRecent?.vectorClock) {
      if (typeof mostRecent.vectorClock === 'string') {
        mostRecentVC.fromString(mostRecent.vectorClock);
      } else {
        mostRecentVC.fromObject(mostRecent.vectorClock);
      }
    }

    for (let i = 1; i < validResponses.length; i++) {
      const candidate = validResponses[i].data;
      const candidateVC = new VectorClock();
      
      if (candidate?.vectorClock) {
        if (typeof candidate.vectorClock === 'string') {
          candidateVC.fromString(candidate.vectorClock);
        } else {
          candidateVC.fromObject(candidate.vectorClock);
        }
      }

      const comparison = mostRecentVC.compare(candidateVC);
      
      if (comparison === 'before') {
        // Candidate is newer
        mostRecent = candidate;
        mostRecentVC = candidateVC;
      } else if (comparison === 'concurrent') {
        // Concurrent versions - use last-write-wins based on lastUpdated
        const mostRecentTime = mostRecent.lastUpdated || 0;
        const candidateTime = candidate.lastUpdated || 0;
        
        if (candidateTime > mostRecentTime) {
          mostRecent = candidate;
          mostRecentVC = candidateVC;
        }
      }
      // If 'after' or 'equal', keep mostRecent
    }

    return mostRecent;
  }

  /**
   * Sends an operation to a specific node and waits for response.
   * Uses mutex to serialize requests per socket (ZeroMQ REQ only allows one at a time).
   * @param port HTTP port of the target node (will be converted to ZMQ port)
   */
  private async sendToNode(port: number, operation: any, timeoutMs: number): Promise<any> {
    // Convert HTTP port to ZMQ port (ZMQ port = HTTP port + zmqPortOffset)
    const zmqPort = port + cloudConfig.storage.zmqPortOffset;
    const socket = this.reqSockets.get(zmqPort);
    if (!socket) {
      throw new Error(`No socket connection to node ${port} (ZMQ port ${zmqPort})`);
    }

    // Get or create mutex for this socket
    let mutex = this.socketMutexes.get(zmqPort);
    if (!mutex) {
      mutex = new SocketMutex();
      this.socketMutexes.set(zmqPort, mutex);
    }

    // Acquire mutex before using socket
    await mutex.acquire();
    
    try {
      await socket.send(JSON.stringify(operation));
      
      const reply = await this.recvWithTimeout(socket, timeoutMs);
      
      if (!reply) {
        throw new Error(`Timeout waiting for response from node ${port}`);
      }

      return JSON.parse(reply.toString());
    } catch (err) {
      console.error(`Error communicating with node ${port}:`, err);
      throw err;
    } finally {
      // Always release mutex
      mutex.release();
    }
  }

  /**
   * Receives a message with timeout.
   */
  private async recvWithTimeout(socket: Request, timeoutMs: number): Promise<Buffer[] | null> {
    return Promise.race([
      socket.receive() as Promise<Buffer[]>,
      new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs))
    ]);
  }
}
