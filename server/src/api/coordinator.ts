import express from 'express';
import { Reply } from 'zeromq';
import cloudConfig from './cloudConfig.json';

/**
 * Coordinator server for Dynamo-style architecture.
 * Manages client SSE connections and broadcasts updates received from storage nodes via ZeroMQ.
 * Does NOT store data - only coordinates real-time notifications.
 */
export class CoordinatorServer {
  private app: express.Application;
  private port: number;
  private repSocket!: Reply;
  private sseClients: Map<express.Response, NodeJS.Timeout> = new Map();
  private isRunning: boolean = false;
  private zmqListenerAbortController?: AbortController;
  private httpServer?: any;

  constructor(port: number = cloudConfig.coordinator.httpPort) {
    this.app = express();
    this.port = port;

    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());

    // CORS middleware
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }

      next();
    });
  }

  private setupRoutes(): void {
    this.app.get('/api/health', (_req, res) => {
      res.json({ status: 'OK', role: 'coordinator', timestamp: Date.now() });
    });

    this.app.get('/api/events', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');

      res.write('data: {"type":"connected"}\n\n');

      const heartbeat = setInterval(() => {
        res.write(':heartbeat\n\n');
      }, 30000);

      this.sseClients.set(res, heartbeat);
      console.log(`📡 SSE client connected (${this.sseClients.size} total)`);

      req.on('close', () => {
        clearInterval(heartbeat);
        this.sseClients.delete(res);
        console.log(`📡 SSE client disconnected (${this.sseClients.size} remaining)`);
      });
    });
  }

  private broadcastUpdate(event: string, data: any): void {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [client, heartbeat] of this.sseClients) {
      try {
        client.write(message);
      } catch {
        clearInterval(heartbeat);
        this.sseClients.delete(client);
      }
    }
  }

  public async initMessaging(repPort: number) {
    if (this.repSocket) {
      this.repSocket.close();
    }

    this.repSocket = new Reply();
    await this.repSocket.bind(`tcp://127.0.0.1:${repPort}`);
    console.log(`📨 Coordinator listening for gossip on tcp://127.0.0.1:${repPort}`);

    this.zmqListenerAbortController = new AbortController();
    this.listenForGossip();
  }

  private async listenForGossip() {
    try {
      for await (const [msg] of this.repSocket) {
        if (!this.isRunning || this.zmqListenerAbortController?.signal.aborted) {
          console.log('Coordinator gossip listener stopping...');
          break;
        }

        try {
          const update = JSON.parse(msg.toString());
          
          // Broadcast to SSE clients based on update type
          if (update.type === 'BROADCAST') {
            // Direct broadcast from storage node
            this.broadcastUpdate(update.event, update.data);
          } else {
            // Legacy gossip format
            switch (update.type) {
              case 'CREATE_LIST':
                this.broadcastUpdate('list-created', update.list);
                break;
              case 'ADD_ITEM':
                this.broadcastUpdate('item-added', { listId: update.item.listId, item: update.item });
                break;
              case 'UPDATE_ITEM':
                this.broadcastUpdate('item-updated', update.item);
                break;
              case 'TOGGLE_CHECK':
                this.broadcastUpdate('item-toggled', update.item);
                break;
              case 'UPDATE_QUANTITY':
                this.broadcastUpdate('item-quantity-updated', update.item);
                break;
              case 'REMOVE_ITEM':
                this.broadcastUpdate('item-removed', { itemId: update.itemId });
                break;
              case 'DELETE_LIST':
                this.broadcastUpdate('list-deleted', { listId: update.listId });
                break;
            }
          }

          await this.repSocket.send(JSON.stringify({ status: 'ok' }));
        } catch (err) {
          console.error('Error handling gossip message:', err);
          await this.repSocket.send(JSON.stringify({ status: 'error' }));
        }
      }
    } catch (err) {
      if (this.isRunning) {
        console.error('Coordinator gossip listener error:', err);
      }
    }
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;
    
    // Start HTTP server
    await new Promise<void>((resolve) => {
      this.httpServer = this.app.listen(this.port, () => {
        console.log(`🎯 Coordinator server running on http://localhost:${this.port}`);
        resolve();
      });
    });

    // Initialize ZeroMQ listener for gossip
    await this.initMessaging(cloudConfig.coordinator.zmqPort);
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;

    console.log('Stopping coordinator server...');
    this.isRunning = false;

    // Stop ZeroMQ listener
    if (this.zmqListenerAbortController) {
      this.zmqListenerAbortController.abort();
    }

    if (this.repSocket) {
      this.repSocket.close();
    }

    // Close all SSE connections
    for (const [client, heartbeat] of this.sseClients) {
      clearInterval(heartbeat);
      try {
        client.end();
      } catch {
        // Client may already be closed
      }
    }
    this.sseClients.clear();

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer.close(() => resolve());
      });
    }

    console.log('✅ Coordinator stopped');
  }
}
