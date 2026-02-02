import express from 'express';
import { join } from 'path';
import { ShoppingListManager } from '../storage/ShoppingListManager';
import { SQLiteStore } from '../storage/SQLiteStore';
import { Request, Reply } from 'zeromq';
import fs from 'fs';
import path from 'path';
import { VectorClock } from '../crdt/VectorClock';
import { QuorumCoordinator } from './quorum';

/**
 * Storage node server implementing Dynamo-style distributed architecture.
 * Handles HTTP API, ZeroMQ messaging for gossip protocol, and SSE broadcasts.
 */
export class ShoppingListServer {
  private app: express.Application;
  private listManager: ShoppingListManager;
  private port: number;
  private dbFile: string;
  private repSocket!: Reply;
  private reqSockets: Map<number, Request> = new Map();
  private coordinatorSocket: Request | null = null;
  private sseClients: Map<express.Response, NodeJS.Timeout> = new Map();
  private hintedHandOffQueue: Map<number, any[]> = new Map();
  private hintedHandoffInterval?: NodeJS.Timeout;
  private nodeId: string;
  private httpServer?: any;
  private isRunning: boolean = false;
  private zmqListenerAbortController?: AbortController;
  private quorumCoordinator?: QuorumCoordinator;

  private async recvWithTimeout(
    socket: Request,
    timeoutMs: number
  ): Promise<Buffer[] | null> {
    return Promise.race([
      socket.receive() as Promise<Buffer[]>,
      new Promise<null>(resolve =>
        setTimeout(() => resolve(null), timeoutMs)
      )
    ]);
  }


  constructor(port: number = 3000, nodeId?: string) {
    this.app = express();
    this.port = port;
    this.nodeId = nodeId || port.toString();

    const dbFolder = path.join(__dirname, '../../database/servers');
    if (!fs.existsSync(dbFolder)) fs.mkdirSync(dbFolder, { recursive: true });
    this.dbFile = path.join(dbFolder, `${port}.db`);

    const store = new SQLiteStore(this.dbFile);
    this.listManager = new ShoppingListManager(undefined, store);

    this.setupMiddleware();
    this.setupRoutes();
  }


  public async getRemoteValue(key: string, type: 'list' | 'item') {
    if (type === 'list') return this.listManager.getList(key);
    else return this.listManager.getItem(key);
  }

  public async applyRemoteUpdate(update: any) {
    await this.applyUpdate(update);
  }

  private setupMiddleware(): void {
    this.app.use(express.json());
    this.app.use(express.static('../../public/dist'));
    
    // CORS middleware
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
      
      // Handle preflight requests
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      
      next();
    });
  }

  private async initializeManager(): Promise<void> {
    await this.listManager.initialize();
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/api/health', (_req, res) => {
      res.json({ status: 'OK', timestamp: Date.now(), nodeId: this.nodeId });
    });

    // Create list
    this.app.post('/api/lists', async (req, res) => {
      try {
        const { name, id, vectorClock, createdAt, lastUpdated } = req.body;
        if (!name) return res.status(400).json({ error: 'List name is required' });

        const existing = id ? await this.listManager.getList(id) : null;
        if (existing) return res.status(409).json({ error: 'List already exists', list: existing });

        const vc = new VectorClock();
        if (vectorClock) {
          // Handle both string and object from client
          if (typeof vectorClock === 'string') {
            vc.fromString(vectorClock);
          } else {
            vc.fromObject(vectorClock);
          }
        }
        vc.increment(this.nodeId);

        const list = await this.listManager.createList(name, id, vc.toObject(), createdAt, lastUpdated);

        console.log(`✅ Created list locally: ${name} (${list.id})`);

        // Perform quorum write
        if (this.quorumCoordinator) {
          const quorumResult = await this.quorumCoordinator.quorumWrite(
            list.id,
            { type: 'CREATE_LIST', list }
          );
          
          if (!quorumResult.success) {
            console.error(`❌ Quorum write failed for list ${list.id}`);
            return res.status(503).json({ 
              error: 'Write quorum not met',
              successfulNodes: quorumResult.successfulNodes.length,
              requiredNodes: 2
            });
          }
        } else {
          // Fallback to old gossip if quorum not initialized
          await this.sendUpdateToNeighbors({ type: 'CREATE_LIST', list }).catch(err => console.error(err));
        }

        this.broadcastUpdate('list-created', list);

        res.status(201).json(list);
      } catch (error) {
        console.error('Error creating list:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Get list with items
    this.app.get('/api/lists/:listId', async (req, res) => {
      try {
        // Perform quorum read
        let list;
        if (this.quorumCoordinator) {
          list = await this.quorumCoordinator.quorumRead(req.params.listId, 'list');
          if (!list) {
            console.error(`❌ Quorum read failed for list ${req.params.listId}`);
            return res.status(503).json({ 
              error: 'Read quorum not met',
              message: 'Unable to read from sufficient replicas'
            });
          }
        } else {
          // Fallback to local read if quorum not initialized
          list = await this.listManager.getList(req.params.listId);
        }
        
        if (!list) return res.status(404).json({ error: 'List not found' });
        res.json(list);
      } catch (error) {
        console.error('Error getting list:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Add item
    this.app.post('/api/lists/:listId/items', async (req, res) => {
      try {
        const { name, quantity, acquired, id, vectorClock, createdAt, lastUpdated } = req.body;
        if (!name) return res.status(400).json({ error: 'Item name required' });

        const existing = id ? await this.listManager.getItem(id) : null;
        if (existing) return res.status(409).json({ error: 'Item already exists', item: existing });

        const vc = new VectorClock();
        if (vectorClock) {
          // Handle both string and object from client
          if (typeof vectorClock === 'string') {
            vc.fromString(vectorClock);
          } else {
            vc.fromObject(vectorClock);
          }
        }
        vc.increment(this.nodeId);

        // Ensure the list exists locally; if not, try to fetch via quorum and create it.
        let item = await this.listManager.addItemToList(req.params.listId, {
          id, name, quantity, acquired, vectorClock: vc.toObject(), createdAt, lastUpdated
        });

        if (!item && this.quorumCoordinator) {
          try {
            const fetchedList = await this.quorumCoordinator.quorumRead(req.params.listId, 'list');
            if (fetchedList) {
              await this.listManager.createList(
                fetchedList.name,
                fetchedList.id,
                typeof fetchedList.vectorClock === 'string' ? JSON.parse(fetchedList.vectorClock) : fetchedList.vectorClock,
                fetchedList.createdAt,
                fetchedList.lastUpdated
              );
              item = await this.listManager.addItemToList(req.params.listId, {
                id, name, quantity, acquired, vectorClock: vc.toObject(), createdAt, lastUpdated
              });
            }
          } catch {}
        }

        if (!item) return res.status(404).json({ error: 'List not found' });

        console.log(`✅ Added item locally: ${name} (${item.id}) to list ${req.params.listId}`);
        
        // Perform quorum write
        if (this.quorumCoordinator) {
          const quorumResult = await this.quorumCoordinator.quorumWrite(
            item.id,
            { type: 'ADD_ITEM', item }
          );
          
          if (!quorumResult.success) {
            console.error(`❌ Quorum write failed for item ${item.id}`);
            return res.status(503).json({ 
              error: 'Write quorum not met',
              successfulNodes: quorumResult.successfulNodes.length,
              requiredNodes: 2
            });
          }
        } else {
          // Fallback to old gossip if quorum not initialized
          await this.sendUpdateToNeighbors({ type: 'ADD_ITEM', item }).catch(err => console.error(err));
        }
        
        this.broadcastUpdate('item-added', { listId: req.params.listId, item });

        res.status(201).json(item);
      } catch (error) {
        console.error('Error adding item:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Update item
    this.app.put('/api/items/:itemId', async (req, res) => {
      try {
        const updates = req.body;
        const vc = new VectorClock();
        if (updates.vectorClock) vc.fromString(JSON.stringify(updates.vectorClock));
        vc.increment(this.nodeId);
        updates.vectorClock = vc.toObject();

        const item = await this.listManager.updateItem(req.params.itemId, updates);
        if (!item) return res.status(404).json({ error: 'Item not found' });

        // Perform quorum write
        if (this.quorumCoordinator) {
          const quorumResult = await this.quorumCoordinator.quorumWrite(
            req.params.itemId,
            { type: 'UPDATE_ITEM', item }
          );
          
          if (!quorumResult.success) {
            console.error(`❌ Quorum write failed for item ${req.params.itemId}`);
            return res.status(503).json({ 
              error: 'Write quorum not met',
              successfulNodes: quorumResult.successfulNodes.length,
              requiredNodes: 2
            });
          }
        } else {
          await this.sendUpdateToNeighbors({ type: 'UPDATE_ITEM', item }).catch(err => console.error(err));
        }
        
        this.broadcastUpdate('item-updated', item);

        res.json(item);
      } catch (error) {
        console.error('Error updating item:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Toggle check
    this.app.patch('/api/items/:itemId/toggle', async (req, res) => {
      try {
        const { acquired, vectorClock, lastUpdated } = req.body;
        
        // Parse client's vector clock if provided
        const clientClock = vectorClock 
          ? (typeof vectorClock === 'string' ? JSON.parse(vectorClock) : vectorClock)
          : null;

        let crdtItem = this.listManager.getCRDTItem(req.params.itemId);
        
        // DYNAMO PATTERN: If we don't have the item locally, coordinate with replicas
        if (!crdtItem && this.quorumCoordinator) {
          console.log(`📡 Item ${req.params.itemId} not found locally for toggle, coordinating with replicas...`);
          
          // Quorum read to get the item from replicas that have it
          const itemData = await this.quorumCoordinator.quorumRead(req.params.itemId, 'item');
          if (!itemData) {
            return res.status(404).json({ error: 'Item not found in any replica' });
          }
          
          // Bootstrap the item locally from the read result
          const list = await this.listManager.getList(itemData.listId);
          if (!list) {
            // Need to bootstrap the list too
            const listData = await this.quorumCoordinator.quorumRead(itemData.listId, 'list');
            if (listData) {
              await this.listManager.createList(
                listData.name,
                listData.id,
                listData.vectorClock,
                listData.createdAt,
                listData.lastUpdated
              );
            }
          }
          
          // Add item locally
          await this.listManager.addItemToList(itemData.listId, {
            name: itemData.name,
            quantity: itemData.quantity,
            id: itemData.id,
            vectorClock: itemData.vectorClock,
            createdAt: itemData.createdAt,
            lastUpdated: itemData.lastUpdated
          });
          
          // Now get the CRDT item
          crdtItem = this.listManager.getCRDTItem(req.params.itemId);
          if (!crdtItem) {
            return res.status(500).json({ error: 'Failed to bootstrap item from replicas' });
          }
          
          console.log(`✅ Bootstrapped item ${itemData.name} from replicas for toggle`);
        } else if (!crdtItem) {
          return res.status(404).json({ error: 'Item not found' });
        }

        // Determine merge strategy based on vector clock comparison
        let finalAcquired = acquired;
        
        if (clientClock) {
          const comparison = VectorClock.compare(clientClock, crdtItem.vectorClock);
          
          if (comparison === 'concurrent') {
            const currentAcquired = crdtItem.acquired.value();
            finalAcquired = Math.max(currentAcquired, acquired ?? 0);
            console.log(`🔀 Concurrent toggle update: local_acq=${currentAcquired}, remote_acq=${acquired}, merged=${finalAcquired}`);
            
            const mergedClock: Record<string, number> = { ...crdtItem.vectorClock };
            for (const [node, timestamp] of Object.entries(clientClock)) {
              mergedClock[node] = Math.max(mergedClock[node] || 0, timestamp as number);
            }
            crdtItem.vectorClock = mergedClock;
          } else if (comparison === 'before') {
            console.log(`⏭️ Ignoring older toggle update`);
            const existingItem = await this.listManager.getItem(req.params.itemId);
            return res.json(existingItem);
          } else {
            // 'after' or 'equal': client is newer or same, use client values
            crdtItem.vectorClock = clientClock;
          }
          
          if (lastUpdated) crdtItem.lastUpdated = Math.max(crdtItem.lastUpdated, lastUpdated);
        }
        
        // If client provided acquired value, set it; otherwise toggle
        let item;
        if (finalAcquired !== undefined) {
          const checked = crdtItem.quantity.value() > 0 && finalAcquired >= crdtItem.quantity.value();
          item = await this.listManager.setItemCheck(req.params.itemId, checked, finalAcquired);
        } else {
          item = await this.listManager.toggleItemCheck(req.params.itemId);
        }
        
        if (!item) return res.status(404).json({ error: 'Item not found' });

        const isChecked = item.quantity > 0 && item.acquired >= item.quantity;
        console.log(`✅ Toggled item: ${item.name} (${item.id}) checked=${isChecked}`);

        // If no client vector clock, increment server's own
        if (!clientClock) {
          const vc = new VectorClock();
          if (item.vectorClock) vc.fromString(JSON.stringify(item.vectorClock));
          vc.increment(this.nodeId);
          item.vectorClock = vc.toObject();
        }

        // Perform quorum write
        if (this.quorumCoordinator) {
          const quorumResult = await this.quorumCoordinator.quorumWrite(
            req.params.itemId,
            { type: 'TOGGLE_CHECK', item }
          );
          
          if (!quorumResult.success) {
            console.error(`❌ Quorum write failed for toggle on item ${req.params.itemId}`);
            return res.status(503).json({ 
              error: 'Write quorum not met',
              successfulNodes: quorumResult.successfulNodes.length,
              requiredNodes: 2
            });
          }
        } else {
          await this.sendUpdateToNeighbors({ type: 'TOGGLE_CHECK', item }).catch(err => console.error(err));
        }
        
        this.broadcastUpdate('item-toggled', item);

        res.json(item);
      } catch (error) {
        console.error('Error toggling item:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Update quantity
    this.app.patch('/api/items/:itemId/quantity', async (req, res) => {
      try {
        const { quantity, acquired, vectorClock, lastUpdated } = req.body;
        if (quantity === undefined) return res.status(400).json({ error: 'Quantity is required' });

        // Parse client's vector clock if provided
        const clientClock = vectorClock 
          ? (typeof vectorClock === 'string' ? JSON.parse(vectorClock) : vectorClock)
          : null;

        let crdtItem = this.listManager.getCRDTItem(req.params.itemId);
        
        // DYNAMO PATTERN: If we don't have the item locally, coordinate with replicas
        if (!crdtItem && this.quorumCoordinator) {
          console.log(`📡 Item ${req.params.itemId} not found locally, coordinating with replicas...`);
          
          // Quorum read to get the item from replicas that have it
          const itemData = await this.quorumCoordinator.quorumRead(req.params.itemId, 'item');
          if (!itemData) {
            return res.status(404).json({ error: 'Item not found in any replica' });
          }
          
          // Bootstrap the item locally from the read result
          const list = await this.listManager.getList(itemData.listId);
          if (!list) {
            // Need to bootstrap the list too
            const listData = await this.quorumCoordinator.quorumRead(itemData.listId, 'list');
            if (listData) {
              await this.listManager.createList(
                listData.name,
                listData.id,
                listData.vectorClock,
                listData.createdAt,
                listData.lastUpdated
              );
            }
          }
          
          // Add item locally
          await this.listManager.addItemToList(itemData.listId, {
            name: itemData.name,
            quantity: itemData.quantity,
            id: itemData.id,
            vectorClock: itemData.vectorClock,
            createdAt: itemData.createdAt,
            lastUpdated: itemData.lastUpdated
          });
          
          // Now get the CRDT item
          crdtItem = this.listManager.getCRDTItem(req.params.itemId);
          if (!crdtItem) {
            return res.status(500).json({ error: 'Failed to bootstrap item from replicas' });
          }
          
          console.log(`✅ Bootstrapped item ${itemData.name} from replicas`);
        } else if (!crdtItem) {
          return res.status(404).json({ error: 'Item not found' });
        }

        let finalQuantity = quantity;
        let finalAcquired = acquired;
        
        if (clientClock) {
          const comparison = VectorClock.compare(clientClock, crdtItem.vectorClock);
          
          if (comparison === 'concurrent') {
            const currentQuantity = crdtItem.quantity.value();
            const currentAcquired = crdtItem.acquired.value();
            finalQuantity = Math.max(currentQuantity, quantity);
            finalAcquired = Math.max(currentAcquired, acquired ?? 0);
            console.log(`🔀 Concurrent quantity update: local=${currentQuantity}, remote=${quantity}, merged=${finalQuantity}`);
            
            const mergedClock: Record<string, number> = { ...crdtItem.vectorClock };
            for (const [node, timestamp] of Object.entries(clientClock)) {
              mergedClock[node] = Math.max(mergedClock[node] || 0, timestamp as number);
            }
            crdtItem.vectorClock = mergedClock;
          } else if (comparison === 'before') {
            console.log(`⏭️ Ignoring older quantity update`);
            const existingItem = await this.listManager.getItem(req.params.itemId);
            return res.json(existingItem);
          } else {
            // 'after' or 'equal': client is newer or same, use client values
            crdtItem.vectorClock = clientClock;
          }
          
          if (lastUpdated) crdtItem.lastUpdated = lastUpdated;
        }

        const item = await this.listManager.updateItemQuantity(req.params.itemId, finalQuantity, finalAcquired);
        if (!item) return res.status(404).json({ error: 'Item not found' });

        const isChecked = item.quantity > 0 && item.acquired >= item.quantity;
        console.log(`✅ Updated quantity: ${item.name} qty=${finalQuantity} acq=${finalAcquired} checked=${isChecked} (${item.id})`);

        // If no client vector clock, increment server's own
        if (!clientClock) {
          const vc = new VectorClock();
          if (item.vectorClock) vc.fromString(JSON.stringify(item.vectorClock));
          vc.increment(this.nodeId);
          item.vectorClock = vc.toObject();
        }

        // Perform quorum write
        if (this.quorumCoordinator) {
          const quorumResult = await this.quorumCoordinator.quorumWrite(
            req.params.itemId,
            { type: 'UPDATE_QUANTITY', item }
          );
          
          if (!quorumResult.success) {
            console.error(`❌ Quorum write failed for quantity update on item ${req.params.itemId}`);
            return res.status(503).json({ 
              error: 'Write quorum not met',
              successfulNodes: quorumResult.successfulNodes.length,
              requiredNodes: 2
            });
          }
        } else {
          await this.sendUpdateToNeighbors({ type: 'UPDATE_QUANTITY', item }).catch(err => console.error(err));
        }
        
        this.broadcastUpdate('item-quantity-updated', item);

        res.json(item);
      } catch (error) {
        console.error('Error updating quantity:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Update item name (LWW)
    this.app.patch('/api/items/:itemId/name', async (req, res) => {
      try {
        const { name, vectorClock, lastUpdated } = req.body;
        if (!name || typeof name !== 'string') {
          return res.status(400).json({ error: 'Name is required' });
        }

        // Parse client's vector clock if provided
        const clientClock = vectorClock 
          ? (typeof vectorClock === 'string' ? JSON.parse(vectorClock) : vectorClock)
          : null;

        let crdtItem = this.listManager.getCRDTItem(req.params.itemId);
        
        // DYNAMO PATTERN: If we don't have the item locally, coordinate with replicas
        if (!crdtItem && this.quorumCoordinator) {
          console.log(`📡 Item ${req.params.itemId} not found locally for name update, coordinating with replicas...`);
          
          const itemData = await this.quorumCoordinator.quorumRead(req.params.itemId, 'item');
          if (!itemData) {
            return res.status(404).json({ error: 'Item not found in any replica' });
          }
          
          const list = await this.listManager.getList(itemData.listId);
          if (!list) {
            const listData = await this.quorumCoordinator.quorumRead(itemData.listId, 'list');
            if (listData) {
              await this.listManager.createList(
                listData.name,
                listData.id,
                listData.vectorClock,
                listData.createdAt,
                listData.lastUpdated
              );
            }
          }
          
          await this.listManager.addItemToList(itemData.listId, {
            name: itemData.name,
            quantity: itemData.quantity,
            id: itemData.id,
            vectorClock: itemData.vectorClock,
            createdAt: itemData.createdAt,
            lastUpdated: itemData.lastUpdated
          });
          
          crdtItem = this.listManager.getCRDTItem(req.params.itemId);
          if (!crdtItem) {
            return res.status(500).json({ error: 'Failed to bootstrap item from replicas' });
          }
          
          console.log(`✅ Bootstrapped item ${itemData.name} from replicas for name update`);
        } else if (!crdtItem) {
          return res.status(404).json({ error: 'Item not found' });
        }

        let finalName = name;
        
        if (clientClock) {
          const comparison = VectorClock.compare(clientClock, crdtItem.vectorClock);
          
          if (comparison === 'concurrent') {
            // LWW: use lastUpdated timestamp to decide winner
            const clientTimestamp = lastUpdated || 0;
            const localTimestamp = crdtItem.lastUpdated || 0;
            
            if (clientTimestamp >= localTimestamp) {
              finalName = name;
              console.log(`🔀 Concurrent name update: using client name "${name}" (newer timestamp)`);
            } else {
              finalName = crdtItem.name.getValue();
              console.log(`🔀 Concurrent name update: keeping local name "${finalName}" (newer timestamp)`);
            }
            
            const mergedClock: Record<string, number> = { ...crdtItem.vectorClock };
            for (const [node, timestamp] of Object.entries(clientClock)) {
              mergedClock[node] = Math.max(mergedClock[node] || 0, timestamp as number);
            }
            crdtItem.vectorClock = mergedClock;
          } else if (comparison === 'before') {
            console.log(`⏭️ Ignoring older name update`);
            const existingItem = await this.listManager.getItem(req.params.itemId);
            return res.json(existingItem);
          } else {
            crdtItem.vectorClock = clientClock;
          }
          
          if (lastUpdated) crdtItem.lastUpdated = lastUpdated;
        }

        const item = await this.listManager.updateItemName(req.params.itemId, finalName);
        if (!item) return res.status(404).json({ error: 'Item not found' });

        console.log(`✅ Updated name: ${item.name} (${item.id})`);

        // If no client vector clock, increment server's own
        if (!clientClock) {
          const vc = new VectorClock();
          if (item.vectorClock) vc.fromString(JSON.stringify(item.vectorClock));
          vc.increment(this.nodeId);
          item.vectorClock = vc.toObject();
        }

        // Perform quorum write
        if (this.quorumCoordinator) {
          const quorumResult = await this.quorumCoordinator.quorumWrite(
            req.params.itemId,
            { type: 'UPDATE_NAME', item }
          );
          
          if (!quorumResult.success) {
            console.error(`❌ Quorum write failed for name update on item ${req.params.itemId}`);
            return res.status(503).json({ 
              error: 'Write quorum not met',
              successfulNodes: quorumResult.successfulNodes.length,
              requiredNodes: 2
            });
          }
        } else {
          await this.sendUpdateToNeighbors({ type: 'UPDATE_NAME', item }).catch(err => console.error(err));
        }
        
        this.broadcastUpdate('item-name-updated', item);

        res.json(item);
      } catch (error) {
        console.error('Error updating name:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Delete item
    this.app.delete('/api/items/:itemId', async (req, res) => {
      try {
        const success = await this.listManager.removeItemFromList(req.params.itemId);
        if (!success) return res.status(404).json({ error: 'Item not found' });

        console.log(`✅ Deleted item: ${req.params.itemId}`);

        await this.sendUpdateToNeighbors({ type: 'REMOVE_ITEM', itemId: req.params.itemId }).catch(err => console.error(err));
        this.broadcastUpdate('item-removed', { itemId: req.params.itemId });

        res.json({ success: true });
      } catch (error) {
        console.error('Error deleting item:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Delete list
    this.app.delete('/api/lists/:listId', async (req, res) => {
      try {
        const success = await this.listManager.deleteList(req.params.listId);
        if (!success) return res.status(404).json({ error: 'List not found' });

        console.log(`✅ Deleted list: ${req.params.listId}`);

        await this.sendUpdateToNeighbors({ type: 'DELETE_LIST', listId: req.params.listId }).catch(err => console.error(err));
        this.broadcastUpdate('list-deleted', { listId: req.params.listId });

        res.json({ success: true });
      } catch (error) {
        console.error('Error deleting list:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // List all lists
    this.app.get('/api/lists', async (_req, res) => {
      try {
        const lists = await this.listManager.getAllLists();
        res.json(lists);
      } catch (error) {
        console.error('Error getting lists:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // List all items
    this.app.get('/api/items', async (_req, res) => {
      try {
        const items = await this.listManager.getAllItems();
        res.json(items);
      } catch (error) {
        console.error('Error getting items:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // SSE endpoint
    this.app.get('/api/events', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');

      res.write(':connected\n\n');

      const heartbeat = setInterval(() => {
        res.write(':heartbeat\n\n');
      }, 30000);

      this.sseClients.set(res, heartbeat);

      req.on('close', () => {
        clearInterval(heartbeat);
        this.sseClients.delete(res);
      });
    });

    // Serve frontend
    this.app.get('*', (_req, res) => {
      res.sendFile(join(__dirname, '../../public/dist/index.html'));
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
    
    // Also send to coordinator so all connected clients receive the update
    this.broadcastToCoordinator(event, data).catch(err => 
      console.error('Failed to broadcast to coordinator:', err)
    );
  }

  private async broadcastToCoordinator(event: string, data: any): Promise<void> {
    // Send update to coordinator for SSE broadcasting to all clients
    if (this.coordinatorSocket) {
      try {
        const update = { type: 'BROADCAST', event, data };
        await this.coordinatorSocket.send(JSON.stringify(update));
        const reply = await this.recvWithTimeout(this.coordinatorSocket, 500);
        if (!reply) {
          console.warn('⚠️ Coordinator not responding to broadcast');
        }
      } catch (err) {
        console.error('Error broadcasting to coordinator:', err);
      }
    }
  }

  public async start(): Promise<void> {
    await this.initializeManager();
    this.isRunning = true;
    
    // Start periodic hinted handoff flush (every 30 seconds)
    this.hintedHandoffInterval = setInterval(() => {
      this.flushHints().catch(err => 
        console.error('Error flushing hinted handoff:', err)
      );
    }, 30000);
    
    this.httpServer = this.app.listen(this.port, () => {
      console.log(`Shopping List Server running on port ${this.port}`);
    });
  }

  public async stop(): Promise<void> {
    this.isRunning = false;

    // Stop hinted handoff timer
    if (this.hintedHandoffInterval) {
      clearInterval(this.hintedHandoffInterval);
      this.hintedHandoffInterval = undefined;
    }

    // Signal ZeroMQ listener to stop
    if (this.zmqListenerAbortController) {
      this.zmqListenerAbortController.abort();
    }

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve, reject) => {
        this.httpServer.close((err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this.httpServer = undefined;
    }

    // Close ZeroMQ sockets
    if (this.repSocket) {
      this.repSocket.close();
    }
    for (const [_, reqSocket] of this.reqSockets) {
      reqSocket.close();
    }
    this.reqSockets.clear();

    // Clear SSE clients
    for (const [client, heartbeat] of this.sseClients) {
      clearInterval(heartbeat);
      try {
        client.end();
      } catch {
        // Client may already be closed
      }
    }
    this.sseClients.clear();

    // Close database last
    await this.listManager.close();
  }

  public async initMessaging(repPort: number, neighborPorts: number[], coordinatorPort?: number) {
    if (this.repSocket) {
      this.repSocket.close();
    }
    
    this.repSocket = new Reply();
    await this.repSocket.bind(`tcp://127.0.0.1:${repPort}`);
    
    this.zmqListenerAbortController = new AbortController();
    this.listenForRequests();

    for (const port of neighborPorts) {
      const req = new Request();
      await req.connect(`tcp://127.0.0.1:${port}`);
      this.reqSockets.set(port, req);
    }
    
    // Initialize quorum coordinator after sockets are connected
    this.quorumCoordinator = new QuorumCoordinator(this.reqSockets, this.port);
    console.log(`🔐 Quorum coordinator initialized`);
    
    // Connect to coordinator if port provided
    if (coordinatorPort) {
      this.coordinatorSocket = new Request();
      await this.coordinatorSocket.connect(`tcp://127.0.0.1:${coordinatorPort}`);
      console.log(`📨 Connected to coordinator on tcp://127.0.0.1:${coordinatorPort}`);
    }
    
    console.log(`ZeroMQ REP bound to tcp://127.0.0.1:${repPort}`);
  }

  private async listenForRequests() {
    try {
      for await (const [msg] of this.repSocket) {
        if (!this.isRunning || this.zmqListenerAbortController?.signal.aborted) {
          console.log('ZeroMQ listener stopping...');
          break;
        }

        try {
          const update = JSON.parse(msg.toString());
          const result = await this.applyUpdate(update);
          
          // For READ operations, return the data; for writes, send status based on apply result
          if (update.type === 'READ') {
            await this.repSocket.send(JSON.stringify({ status: 'ok', ...result }));
          } else {
            const ok = !!(result && result.ok);
            if (ok) {
              await this.repSocket.send(JSON.stringify({ status: 'ok' }));
            } else {
              await this.repSocket.send(JSON.stringify({ status: 'error' }));
            }
          }
        } catch (err) {
          const error = err as Error;
          if (error.message.includes('Database is closed') || !this.isRunning) {
            console.warn('Node is stopping, rejecting update');
            await this.repSocket.send(JSON.stringify({ status: 'error', error: 'Node is down' }));
            break;
          }
          console.error('Error handling neighbor request:', err);
          await this.repSocket.send(JSON.stringify({ status: 'error', error: error.message }));
        }
      }
    } catch (err) {
      if (this.isRunning) {
        console.error('ZeroMQ listener error:', err);
      }
    }
  }

  /**
   * Applies incoming updates using vector clock comparison for conflict resolution.
   * Implements "last-writer-wins" semantics with concurrent update merging.
   */
  private async applyUpdate(update: any) {
    if (!this.isRunning) {
      throw new Error('Node is not running');
    }
    switch (update.type) {
      case 'READ': {
        // Handle quorum read requests from other nodes
        const { key, dataType } = update;
        let data = null;
        
        if (dataType === 'list') {
          data = await this.listManager.getList(key);
        } else if (dataType === 'item') {
          data = await this.listManager.getItem(key);
        }
        
        return { data };
      }
      case 'CREATE_LIST': {
        const existing = await this.listManager.getList(update.list.id);
        if (!existing) {
          await this.listManager.createList(update.list.name, update.list.id, update.list.vectorClock, update.list.createdAt, update.list.lastUpdated);
        } else {
          const existingVC = new VectorClock();
          existingVC.fromString(JSON.stringify(existing.vectorClock));

          const updateVC = new VectorClock();
          updateVC.fromString(JSON.stringify(update.list.vectorClock));

          const winner = existingVC.compare(updateVC); // 'before', 'after', 'concurrent', 'equal'
          if (winner === 'after' || winner === 'concurrent') {
            await this.listManager.updateList(update.list);
          }
        }
        return { ok: true };
      }
      case 'ADD_ITEM':
      case 'UPDATE_ITEM':
      case 'TOGGLE_CHECK':
      case 'UPDATE_QUANTITY':
      case 'UPDATE_NAME': {
        const itemId = update.item.id;
        const existing = await this.listManager.getItem(itemId);
        if (!existing) {
          // Ensure the parent list exists locally; if not, try to fetch via quorum and create it.
          const localList = await this.listManager.getList(update.item.listId);
          if (!localList && this.quorumCoordinator) {
            try {
              const fetchedList = await this.quorumCoordinator.quorumRead(update.item.listId, 'list');
              if (fetchedList) {
                await this.listManager.createList(
                  fetchedList.name,
                  fetchedList.id,
                  typeof fetchedList.vectorClock === 'string' ? JSON.parse(fetchedList.vectorClock) : fetchedList.vectorClock,
                  fetchedList.createdAt,
                  fetchedList.lastUpdated
                );
              }
            } catch {}
          }

          const added = await this.listManager.addItemToList(update.item.listId, update.item);
          return { ok: !!added };
        } else {
          const existingVC = new VectorClock();
          existingVC.fromString(JSON.stringify(existing.vectorClock));

          const updateVC = new VectorClock();
          updateVC.fromString(JSON.stringify(update.item.vectorClock));

          const winner = existingVC.compare(updateVC);
          if (winner === 'after' || winner === 'concurrent') {
            await this.listManager.updateItem(itemId, update.item);
          }
          return { ok: true };
        }
      }
      case 'REMOVE_ITEM': {
        await this.listManager.removeItemFromList(update.itemId);
        return { ok: true };
      }
      case 'DELETE_LIST': {
        await this.listManager.deleteList(update.listId);
        return { ok: true };
      }
    }
  }

  /**
   * Propagates updates to neighbor nodes and coordinator.
   * Failed sends are queued in hintedHandOffQueue for later retry.
   */
  public async sendUpdateToNeighbors(update: any) {
    // Send to coordinator for SSE broadcasting
    if (this.coordinatorSocket) {
      this.sendToCoordinator(update).catch(err => 
        console.error('Failed to send update to coordinator:', err)
      );
    }
    
    // Send to neighbor storage nodes for replication
    for (const [port, reqSocket] of this.reqSockets) {
      (async () => {
        const endpoint = `tcp://127.0.0.1:${port}`;
        const ok = await this.sendLazyPirate(reqSocket, update, endpoint);

        if (!ok) {
          if (!this.hintedHandOffQueue.has(port)) {
            this.hintedHandOffQueue.set(port, []);
          }
          this.hintedHandOffQueue.get(port)!.push(update);
        }
      })();
    }
  }



  public async flushHints() {
    for (const [port, queue] of this.hintedHandOffQueue) {
      let reqSocket = this.reqSockets.get(port);
      if (!reqSocket) continue;

      const endpoint = `tcp://127.0.0.1:${port}`;

      for (const update of [...queue]) {
        const ok = await this.sendLazyPirate(reqSocket, update, endpoint);

        if (ok) {
          queue.shift();
        } else {
          break;
        }
      }
    }
  }

  private async sendLazyPirate(
    reqSocket: Request,
    update: any,
    endpoint: string,
    retries: number = 3,
    timeoutMs: number = 500
  ): Promise<boolean> {
    let attempt = 0;

    while (attempt < retries) {
      try {
        await reqSocket.send(JSON.stringify(update));

        const reply = await this.recvWithTimeout(reqSocket, timeoutMs);

        if (reply !== null) {
          try {
            const parsed = JSON.parse(reply.toString());
            if (parsed && parsed.status === 'ok') {
              return true; // Success
            }
            console.warn(`⚠ Non-ok reply from ${endpoint}:`, parsed);
          } catch (err) {
            console.warn(`⚠ Failed to parse reply from ${endpoint}:`, err);
          }
          attempt++;
          continue;
        }

        console.warn(`⚠ Timeout contacting ${endpoint}, attempt ${attempt + 1}`);

        // Required by Lazy Pirate: tear down socket
        reqSocket.close();

        const newSock = new Request();
        await newSock.connect(endpoint);

        // Update map reference
        for (const [port, sock] of this.reqSockets) {
          if (sock === reqSocket) {
            this.reqSockets.set(port, newSock);
            break;
          }
        }

        reqSocket = newSock;
        attempt++;

      } catch (err) {
        console.error("Lazy Pirate error:", err);
        attempt++;
      }
    }

    console.error(`❌ Lazy Pirate gave up on ${endpoint}`);
    return false;
  }

  /**
   * Send update to coordinator for SSE broadcasting
   */
  private async sendToCoordinator(update: any): Promise<void> {
    if (!this.coordinatorSocket) return;

    try {
      await this.coordinatorSocket.send(JSON.stringify(update));
      const reply = await this.recvWithTimeout(this.coordinatorSocket, 500);
      
      if (!reply) {
        console.warn('⚠️ Coordinator not responding');
      }
    } catch (err) {
      console.error('Error sending to coordinator:', err);
    }
  }
}
