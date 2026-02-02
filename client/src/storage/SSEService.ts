import { serverPool } from './ServerPool';
import { config } from '../config';

export type SSEListener = (event: string, data: any) => void;

/**
 * Manages Server-Sent Events connection to the coordinator for real-time sync.
 * Handles reconnection with backoff and health monitoring.
 */
class SSEService {
  private eventSource: EventSource | null = null;
  private listeners: Set<SSEListener> = new Set();
  private reconnectAttempts = 0;
  private reconnectDelay = 5000; 
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private healthCheckDelay = 5000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentServer: string | null = null;

  connect(): void {
    if (this.eventSource) return; // Already connected

    try {
      // Connect to coordinator server for SSE (not storage nodes)
      this.currentServer = config.coordinator.url;
      this.eventSource = new EventSource(`${this.currentServer}/api/events`);
      console.log(`🌐 Connecting to SSE coordinator on ${this.currentServer}`);

      this.eventSource.onopen = () => {
        console.log(`✅ Real-time updates connected to ${this.currentServer}`);
        this.reconnectAttempts = 0;
        // Clear any pending reconnection timer
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        if (this.currentServer) {
          serverPool.markServerHealthy(this.currentServer);
        }
        this.startHealthCheck();
        // Notify listeners that SSE is connected (for auto-sync)
        this.notifyListeners('sse-connected', null);
      };

      this.eventSource.addEventListener('list-created', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          this.notifyListeners('list-created', data);
        } catch (error) {
          console.error('Error parsing list-created event:', error);
        }
      });

      this.eventSource.addEventListener('list-deleted', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          this.notifyListeners('list-deleted', data);
        } catch (error) {
          console.error('Error parsing list-deleted event:', error);
        }
      });

      this.eventSource.addEventListener('item-added', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          this.notifyListeners('item-added', data);
        } catch (error) {
          console.error('Error parsing item-added event:', error);
        }
      });

      this.eventSource.addEventListener('item-removed', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          this.notifyListeners('item-removed', data);
        } catch (error) {
          console.error('Error parsing item-removed event:', error);
        }
      });

      this.eventSource.addEventListener('item-toggled', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          this.notifyListeners('item-toggled', data);
        } catch (error) {
          console.error('Error parsing item-toggled event:', error);
        }
      });

      this.eventSource.addEventListener('item-updated', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          this.notifyListeners('item-updated', data);
        } catch (error) {
          console.error('Error parsing item-updated event:', error);
        }
      });

      this.eventSource.addEventListener('item-quantity-updated', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          this.notifyListeners('item-quantity-updated', data);
        } catch (error) {
          console.error('Error parsing item-quantity-updated event:', error);
        }
      });

      this.eventSource.addEventListener('item-name-updated', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          this.notifyListeners('item-name-updated', data);
        } catch (error) {
          console.error('Error parsing item-name-updated event:', error);
        }
      });

      this.eventSource.onerror = () => {
        this.disconnect();
        this.attemptReconnect();
      };
    } catch (error) {
      console.error('❌ Failed to connect SSE:', error);
      this.attemptReconnect();
    }
  }

  disconnect(): void {
    this.stopHealthCheck();
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
      if (!this.reconnectTimer) {
        this.notifyListeners('sse-disconnected', null);
      }
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectTimer) return;
    
    this.reconnectAttempts++;
    // Throttle logging to avoid console spam
    if (this.reconnectAttempts === 1 || this.reconnectAttempts % 5 === 0) {
      console.log(`🔄 Reconnecting to server... (attempt ${this.reconnectAttempts})`);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
  }

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthCheckInterval = setInterval(async () => {
      try {
        if (!this.currentServer) return;
        const response = await fetch(`${this.currentServer}/api/health`, { method: 'GET', signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error('Health check failed');
      } catch (error) {
        console.log('📴 Server connection lost');
        if (this.currentServer) {
          serverPool.markServerFailed(this.currentServer);
        }
        this.disconnect();
        this.attemptReconnect();
      }
    }, this.healthCheckDelay);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  addListener(listener: SSEListener): void {
    this.listeners.add(listener);
  }

  removeListener(listener: SSEListener): void {
    this.listeners.delete(listener);
  }

  private notifyListeners(event: string, data: any): void {
    this.listeners.forEach((listener) => {
      try {
        listener(event, data);
      } catch (error) {
        console.error('Error in SSE listener:', error);
      }
    });
  }

  isConnected(): boolean {
    return this.eventSource !== null && this.eventSource.readyState === EventSource.OPEN;
  }
}

export const sseService = new SSEService();
