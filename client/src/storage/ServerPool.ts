import { config } from '../config';

/**
 * Manages server pool with round-robin load balancing and automatic health checks.
 * Tracks failed servers and attempts recovery periodically.
 */
class ServerPool {
  private servers: string[] = config.storage.servers;
  
  private currentIndex: number = 0;
  private failedServers: Set<string> = new Set();
  private healthCheckInterval: number = 10000;
  private healthCheckTimer?: ReturnType<typeof setInterval>;

  constructor() {
    this.startHealthChecks();
  }

  getNextServer(): string {
    // Filter out failed servers
    const availableServers = this.servers.filter(s => !this.failedServers.has(s));
    
    if (availableServers.length === 0) {
      // All servers failed, try the original list (maybe they recovered)
      this.failedServers.clear();
      return this.servers[0];
    }

    // Round-robin through available servers
    const server = availableServers[this.currentIndex % availableServers.length];
    this.currentIndex = (this.currentIndex + 1) % availableServers.length;
    
    return server;
  }

  getRandomServer(): string {
    const availableServers = this.servers.filter(s => !this.failedServers.has(s));
    
    if (availableServers.length === 0) {
      this.failedServers.clear();
      return this.servers[0];
    }

    const randomIndex = Math.floor(Math.random() * availableServers.length);
    return availableServers[randomIndex];
  }

  markServerFailed(server: string): void {
    if (!this.failedServers.has(server)) {
      this.failedServers.add(server);
      console.warn(`⚠️ Server ${server} marked as failed`);
    }
  }

  markServerHealthy(server: string): void {
    if (this.failedServers.has(server)) {
      this.failedServers.delete(server);
      console.log(`✅ Server ${server} recovered`);
    }
  }

  private startHealthChecks(): void {
    this.healthCheckTimer = setInterval(async () => {
      for (const server of this.failedServers) {
        try {
          const response = await fetch(`${server}/api/health`, {
            method: 'GET',
            signal: AbortSignal.timeout(3000),
          });
          
          if (response.ok) {
            this.markServerHealthy(server);
          }
        } catch {
          // Still failed, keep in failed set
        }
      }
    }, this.healthCheckInterval);
  }

  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
  }

  getAllServers(): string[] {
    return this.servers;
  }

  getHealthStatus(): { total: number; healthy: number; failed: number } {
    return {
      total: this.servers.length,
      healthy: this.servers.length - this.failedServers.size,
      failed: this.failedServers.size,
    };
  }
}

export const serverPool = new ServerPool();
