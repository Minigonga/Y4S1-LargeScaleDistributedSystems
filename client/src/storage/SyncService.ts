/**
 * SyncService - Manages synchronization between local IndexedDB and cloud server.
 * Implements local-first pattern: local storage is primary, server provides backup and sync.
 */

import * as db from './db';
import { sseService } from './SSEService';
import { VectorClockOps } from '../crdt/VectorClock';
import { serverPool } from './ServerPool';
import type { StoredList, StoredItem, PendingOperation } from './db';

export interface ShoppingList extends StoredList {
  items: StoredItem[];
}

export type SyncStatus = 'synced' | 'syncing' | 'queue' | 'error';

type SyncStatusListener = (status: SyncStatus, pendingCount: number) => void;
type DataChangeListener = () => void;

class SyncService {
  private isSyncing: boolean = false;
  private statusListeners: Set<SyncStatusListener> = new Set();
  private dataChangeListeners: Set<DataChangeListener> = new Set();
  private hasInitialSynced: boolean = false;
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;
  private retryCount: number = 0;
  private readonly maxRetries: number = 5;
  private readonly baseRetryDelay: number = 500;

  constructor() {
    this.init();
  }

  private async init() {
    const nodeId = await db.getNodeId();
    console.log('🔄 SyncService initialized, nodeId:', nodeId);
    console.log('🌐 Server pool:', serverPool.getAllServers());
    
    sseService.connect();
    sseService.addListener((event, data) => this.handleSSEUpdate(event, data));
    this.syncWithServer();
  }

  private async handleSSEUpdate(event: string, data?: any): Promise<void> {
    if (event === 'sse-connected') {
      console.log('✅ Connected to server, syncing...');
      this.syncWithServer();
      return;
    }
    
    if (event === 'sse-disconnected') {
      this.notifyStatusListeners();
      return;
    }
    
    try {
      await this.processSSEUpdate(event, data);
      await db.clearSyncedOperations();
      this.notifyStatusListeners();
      this.notifyDataChangeListeners();
    } catch (error) {
      console.error('Error processing SSE update:', error);
    }
  }

  /**
   * Process SSE updates and apply them to local storage
   */
  private async processSSEUpdate(event: string, data: any): Promise<void> {
    if (!data) return;

    switch (event) {
      case 'list-created': {
        const localList = await db.getList(data.id);
        if (!localList) {
          console.log(`📭 Ignoring list creation for unknown list: ${data.name} (${data.id})`);
          return; // Skip - client hasn't loaded this list
        } 

        // Update existing list if we have it
        const comparison = VectorClockOps.compare(data.vectorClock, localList.vectorClock);
        if (comparison === 'after') {
          await db.saveList({
            id: data.id,
            name: data.name,
            createdAt: data.createdAt,
            lastUpdated: data.lastUpdated,
            vectorClock: data.vectorClock,
          });
          console.log(`📥 Updated list: ${data.name}`);
        } else if (comparison === 'concurrent') {
          const mergedClock = { ...localList.vectorClock };
          for (const [node, timestamp] of Object.entries(data.vectorClock)) {
            mergedClock[node] = Math.max(mergedClock[node] || 0, timestamp as number);
          }
          await db.saveList({
            id: data.id,
            name: data.name,
            createdAt: data.createdAt,
            lastUpdated: Math.max(data.lastUpdated, localList.lastUpdated),
            vectorClock: mergedClock,
          });
          console.log(`🔀 Merged concurrent update for list: ${data.name}`);
        }
        break;
      }

      case 'list-deleted': {
        // Only delete if we have this list locally
        const localList = await db.getList(data.listId);
        if (localList) {
          await db.deleteList(data.listId);
          console.log(`📥 List deleted: ${data.listId}`);
        }
        break;
      }

      case 'item-added': {
        // Only process items for lists we have loaded
        const list = await db.getList(data.item.listId);
        if (!list) {
          console.log(`📭 Ignoring item for unknown list: ${data.item.listId}`);
          return;
        }

        const localItem = await db.getItem(data.item.id);
        if (!localItem) {
          await db.saveItem({
            id: data.item.id,
            listId: data.item.listId,
            name: data.item.name,
            quantity: data.item.quantity,
            acquired: data.item.acquired,
            createdAt: data.item.createdAt,
            lastUpdated: data.item.lastUpdated,
            vectorClock: data.item.vectorClock,
          });
          console.log(`📥 Received new item: ${data.item.name}`);
        } else {
          const comparison = VectorClockOps.compare(data.item.vectorClock, localItem.vectorClock);
          if (comparison === 'after') {
            await db.saveItem({
              id: data.item.id,
              listId: data.item.listId,
              name: data.item.name,
              quantity: data.item.quantity,
              acquired: data.item.acquired,
              createdAt: data.item.createdAt,
              lastUpdated: data.item.lastUpdated,
              vectorClock: data.item.vectorClock,
            });
            console.log(`📥 Updated item: ${data.item.name}`);
          } else if (comparison === 'concurrent') {
            const mergedClock = { ...localItem.vectorClock };
            for (const [node, timestamp] of Object.entries(data.item.vectorClock)) {
              mergedClock[node] = Math.max(mergedClock[node] || 0, timestamp as number);
            }
            const mergedQuantity = Math.max(localItem.quantity, data.item.quantity);
            const mergedAcquired = Math.max(localItem.acquired, data.item.acquired);
            await db.saveItem({
              id: data.item.id,
              listId: data.item.listId,
              name: data.item.name,
              quantity: mergedQuantity,
              acquired: mergedAcquired,
              createdAt: data.item.createdAt,
              lastUpdated: Math.max(data.item.lastUpdated, localItem.lastUpdated),
              vectorClock: mergedClock,
            });
            console.log(`🔀 Merged concurrent update for item: ${data.item.name}`);
          }
        }
        break;
      }

      case 'item-removed': {
        // Only delete items for lists we have loaded
        const item = await db.getItem(data.itemId);
        if (item) {
          const list = await db.getList(item.listId);
          if (list) {
            await db.deleteItem(data.itemId);
            console.log(`📥 Item removed: ${data.itemId}`);
          }
        }
        break;
      }

      case 'item-toggled': {
        // Toggle only changes acquired, not quantity - preserve local quantity
        const localItem = await db.getItem(data.id);
        if (!localItem) break;

        const list = await db.getList(localItem.listId);
        if (!list) {
          console.log(`📭 Ignoring toggle for unknown list: ${localItem.listId}`);
          break;
        }
        
        const comparison = VectorClockOps.compare(data.vectorClock, localItem.vectorClock);
        if (comparison === 'after') {
          // Only update acquired and vectorClock, preserve local quantity
          await db.saveItem({ 
            ...localItem,
            acquired: data.acquired ?? localItem.acquired,
            vectorClock: data.vectorClock,
            lastUpdated: data.lastUpdated ?? localItem.lastUpdated
          });
          console.log(`📥 Item toggled: ${data.id} (acq: ${data.acquired})`);
        } else if (comparison === 'concurrent') {
          const mergedClock = { ...localItem.vectorClock };
          for (const [node, timestamp] of Object.entries(data.vectorClock)) {
            mergedClock[node] = Math.max(mergedClock[node] || 0, timestamp as number);
          }
          // For toggle, only merge acquired - keep local quantity
          const mergedAcquired = Math.max(localItem.acquired, data.acquired ?? localItem.acquired);
          
          await db.saveItem({ 
            ...localItem,
            acquired: mergedAcquired,
            vectorClock: mergedClock,
            lastUpdated: Math.max(data.lastUpdated, localItem.lastUpdated)
          });
          console.log(`🔀 Merged concurrent toggle: ${data.id} (acq: ${localItem.acquired}→${mergedAcquired})`);
        }
        break;
      }

      case 'item-name-updated': {
        const localItem = await db.getItem(data.id);
        if (!localItem) break;

        const list = await db.getList(localItem.listId);
        if (!list) {
          console.log(`📭 Ignoring name update for unknown list: ${localItem.listId}`);
          break;
        }
        
        const comparison = VectorClockOps.compare(data.vectorClock, localItem.vectorClock);
        if (comparison === 'after') {
          await db.saveItem({ 
            ...localItem,
            name: data.name ?? localItem.name,
            vectorClock: data.vectorClock,
            lastUpdated: data.lastUpdated ?? localItem.lastUpdated
          });
          console.log(`📥 Item name updated: ${data.id} (name: ${data.name})`);
        } else if (comparison === 'concurrent') {
          const mergedClock = { ...localItem.vectorClock };
          for (const [node, timestamp] of Object.entries(data.vectorClock)) {
            mergedClock[node] = Math.max(mergedClock[node] || 0, timestamp as number);
          }
          // For name, use LWW based on lastUpdated timestamp
          let mergedName = localItem.name;
          if (data.name && data.lastUpdated > localItem.lastUpdated) {
            mergedName = data.name;
          }
          
          await db.saveItem({ 
            ...localItem,
            name: mergedName,
            vectorClock: mergedClock,
            lastUpdated: Math.max(data.lastUpdated, localItem.lastUpdated)
          });
          console.log(`🔀 Merged concurrent name update: ${data.id} (name: ${mergedName})`);
        }
        break;
      }

      case 'item-updated':
      case 'item-quantity-updated': {
        // Quantity update changes quantity and acquired
        const localItem = await db.getItem(data.id);
        if (!localItem) break;

        const list = await db.getList(localItem.listId);
        if (!list) {
          console.log(`📭 Ignoring item update for unknown list: ${localItem.listId}`);
          break;
        }
        
        const comparison = VectorClockOps.compare(data.vectorClock, localItem.vectorClock);
        if (comparison === 'after') {
          // Server is newer, use server values but preserve structure
          await db.saveItem({ 
            ...localItem,
            name: data.name ?? localItem.name,
            quantity: data.quantity ?? localItem.quantity,
            acquired: data.acquired ?? localItem.acquired,
            vectorClock: data.vectorClock,
            lastUpdated: data.lastUpdated ?? localItem.lastUpdated
          });
          console.log(`📥 Item ${event.replace('item-', '')}: ${data.id}`);
        } else if (comparison === 'concurrent') {
          const mergedClock = { ...localItem.vectorClock };
          for (const [node, timestamp] of Object.entries(data.vectorClock)) {
            mergedClock[node] = Math.max(mergedClock[node] || 0, timestamp as number);
          }
          
          const mergedQuantity = Math.max(localItem.quantity, data.quantity ?? localItem.quantity);
          const mergedAcquired = Math.max(localItem.acquired, data.acquired ?? localItem.acquired);
          
          // For name, use LWW based on lastUpdated timestamp
          let mergedName = localItem.name;
          if (data.name && data.lastUpdated > localItem.lastUpdated) {
            mergedName = data.name;
          }
          
          await db.saveItem({ 
            ...localItem,
            name: mergedName,
            quantity: mergedQuantity,
            acquired: mergedAcquired,
            vectorClock: mergedClock,
            lastUpdated: Math.max(data.lastUpdated, localItem.lastUpdated)
          });
          console.log(`🔀 Merged concurrent ${event.replace('item-', '')}: ${data.id} (qty: ${localItem.quantity}→${mergedQuantity}, acq: ${localItem.acquired}→${mergedAcquired})`);
        }
        break;
      }
    }
  }

  getIsOnline(): boolean {
    return sseService.isConnected();
  }

  // ==================== STATUS LISTENERS ====================

  addStatusListener(listener: SyncStatusListener) {
    this.statusListeners.add(listener);
  }

  removeStatusListener(listener: SyncStatusListener) {
    this.statusListeners.delete(listener);
  }

  addDataChangeListener(listener: DataChangeListener) {
    this.dataChangeListeners.add(listener);
  }

  removeDataChangeListener(listener: DataChangeListener) {
    this.dataChangeListeners.delete(listener);
  }

  private notifyDataChangeListeners() {
    this.dataChangeListeners.forEach(listener => {
      try {
        listener();
      } catch (error) {
        console.error('Error in data change listener:', error);
      }
    });
  }

  private async notifyStatusListeners() {
    const pending = await db.getPendingOperations();
    
    const status: SyncStatus = this.isSyncing ? 'syncing' 
      : pending.length > 0 ? 'queue' 
      : 'synced';
    
    this.statusListeners.forEach(listener => listener(status, pending.length));
  }

  // ==================== LOCAL OPERATIONS (work offline) ====================

  async createList(name: string): Promise<ShoppingList> {
    const nodeId = await db.getNodeId();
    const now = Date.now();
    
    const list: StoredList = {
      id: crypto.randomUUID(),
      name,
      createdAt: now,
      lastUpdated: now,
      vectorClock: { [nodeId]: 1 },
    };

    await db.saveList(list);

    await db.addPendingOperation({
      type: 'CREATE_LIST',
      data: { ...list, items: [] },
      timestamp: now,
    });

    this.notifyStatusListeners();
    this.syncWithServer();
    return { ...list, items: [] };
  }

  async getList(listId: string): Promise<ShoppingList | null> {
    const list = await db.getList(listId);
    if (!list) return null;

    const items = await db.getItemsByList(listId);
    return { ...list, items };
  }

  /**
   * Fetches a list by ID from the server and saves it locally.
   * Enables users to access lists shared with them via ID.
   */
  async loadListById(listId: string): Promise<ShoppingList | null> {
    try {
      // Try to fetch from server
      const server = serverPool.getNextServer();
      const response = await fetch(`${server}/api/lists/${listId}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('List not found on server');
        }
        throw new Error(`Server error: ${response.status}`);
      }

      const data = await response.json();
      
      // Save list and items locally
      await db.saveList({
        id: data.id,
        name: data.name,
        createdAt: data.createdAt,
        lastUpdated: data.lastUpdated,
        vectorClock: data.vectorClock,
      });

      // Save all items
      for (const item of data.items) {
        await db.saveItem(item);
      }

      console.log(`📥 Loaded list from server: ${data.name} (${listId})`);
      
      // Return the loaded list
      return { ...data, items: data.items };
    } catch (error) {
      console.error('Error loading list from server:', error);
      
      // Fallback to local if server fails
      const localList = await this.getList(listId);
      if (localList) {
        console.log('Using local copy of list');
        return localList;
      }
      
      throw error;
    }
  }

  async getAllLists(): Promise<ShoppingList[]> {
    const lists = await db.getAllLists();
    const result: ShoppingList[] = [];

    for (const list of lists) {
      const items = await db.getItemsByList(list.id);
      result.push({ ...list, items });
    }

    result.sort((a, b) => b.createdAt - a.createdAt);
    return result;
  }

  async deleteList(listId: string): Promise<boolean> {
    const list = await db.getList(listId);
    if (!list) return false;

    await db.deleteList(listId);

    await db.addPendingOperation({
      type: 'DELETE_LIST',
      data: { listId },
      timestamp: Date.now(),
    });

    this.notifyStatusListeners();
    this.syncWithServer();
    return true;
  }

  async addItem(listId: string, itemData: { name: string; quantity?: number }): Promise<StoredItem | null> {
    const list = await db.getList(listId);
    if (!list) return null;

    const nodeId = await db.getNodeId();
    const now = Date.now();

    const item: StoredItem = {
      id: crypto.randomUUID(),
      listId,
      name: itemData.name,
      quantity: itemData.quantity || 1,
      acquired: 0,
      createdAt: now,
      lastUpdated: now,
      vectorClock: { [nodeId]: 1 },
    };

   await db.saveItem(item);

    list.lastUpdated = now;
    list.vectorClock = { ...list.vectorClock };
    list.vectorClock[nodeId] = (list.vectorClock[nodeId] || 0) + 1;
    await db.saveList(list);

    await db.addPendingOperation({
      type: 'ADD_ITEM',
      data: item,
      timestamp: now,
    });

    this.notifyStatusListeners();
    this.syncWithServer();
    return item;
  }

  async toggleItem(itemId: string): Promise<StoredItem | null> {
    const item = await db.getItem(itemId);
    if (!item) return null;

    const nodeId = await db.getNodeId();
    const now = Date.now();

    const wasChecked = item.acquired >= item.quantity && item.quantity > 0;
    item.acquired = wasChecked ? 0 : item.quantity;
    item.lastUpdated = now;
    item.vectorClock = { ...item.vectorClock };
    item.vectorClock[nodeId] = (item.vectorClock[nodeId] || 0) + 1;

    await db.saveItem(item);

    await db.addPendingOperation({
      type: 'TOGGLE_CHECK',
      data: {
        id: itemId,
        acquired: item.acquired,
        vectorClock: item.vectorClock,
        lastUpdated: item.lastUpdated
      },
      timestamp: now,
    });

    this.notifyStatusListeners();
    this.syncWithServer();
    return item;
  }

  async updateQuantity(itemId: string, quantity: number, acquired: number): Promise<StoredItem | null> {
    const item = await db.getItem(itemId);
    if (!item) return null;

    const nodeId = await db.getNodeId();
    const now = Date.now();

    item.quantity = quantity;
    item.acquired = acquired;
    item.lastUpdated = now;
    item.vectorClock = { ...item.vectorClock };
    item.vectorClock[nodeId] = (item.vectorClock[nodeId] || 0) + 1;

    await db.saveItem(item);

    await db.addPendingOperation({
      type: 'UPDATE_QUANTITY',
      data: {
        id: itemId,
        quantity,
        acquired,
        vectorClock: item.vectorClock,
        lastUpdated: item.lastUpdated
      },
      timestamp: now,
    });

    this.notifyStatusListeners();
    this.syncWithServer();
    return item;
  }

  async updateItemName(itemId: string, name: string): Promise<StoredItem | null> {
    const item = await db.getItem(itemId);
    if (!item) return null;

    const nodeId = await db.getNodeId();
    const now = Date.now();

    item.name = name;
    item.lastUpdated = now;
    item.vectorClock = { ...item.vectorClock };
    item.vectorClock[nodeId] = (item.vectorClock[nodeId] || 0) + 1;

    await db.saveItem(item);

    await db.addPendingOperation({
      type: 'UPDATE_NAME',
      data: {
        id: itemId,
        name,
        vectorClock: item.vectorClock,
        lastUpdated: item.lastUpdated
      },
      timestamp: now,
    });

    this.notifyStatusListeners();
    this.syncWithServer();
    return item;
  }

  async removeItem(itemId: string): Promise<boolean> {
    const item = await db.getItem(itemId);
    if (!item) return false;

    await db.deleteItem(itemId);

    await db.addPendingOperation({
      type: 'REMOVE_ITEM',
      data: { itemId },
      timestamp: Date.now(),
    });

    this.notifyStatusListeners();
    this.syncWithServer();
    return true;
  }

  // ==================== SERVER SYNC ====================

  async syncWithServer(): Promise<void> {
    if (this.isSyncing) return;

    // Clear any pending retry
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }

    this.isSyncing = true;
    this.notifyStatusListeners();

    try {
      // On first sync (or after reconnection), push local
      if (!this.hasInitialSynced) {
        await this.pushLocalLists(); 
        await this.pushPendingOperations();
        await this.pullFromServer(); 
        this.hasInitialSynced = true;
      } else {
        await this.pushPendingOperations();
      }
      await db.setLastSyncTime(Date.now());
      this.retryCount = 0; // Reset retry count on success
    } catch (error: any) {
      console.log('⚠️ Sync paused - changes saved locally');
      this.hasInitialSynced = false;
      
      // Schedule automatic retry with exponential backoff
      if (this.retryCount < this.maxRetries) {
        const delay = this.baseRetryDelay * Math.pow(2, this.retryCount);
        this.retryCount++;
        console.log(`🔄 Retrying sync in ${delay}ms (attempt ${this.retryCount}/${this.maxRetries})`);
        this.retryTimeout = setTimeout(() => {
          this.retryTimeout = null;
          this.syncWithServer();
        }, delay);
      } else {
        console.log('❌ Max retries reached, waiting for next user action');
        this.retryCount = 0;
      }
    } finally {
      this.isSyncing = false;
      this.notifyStatusListeners();
    }
  }

  private async pushLocalLists(): Promise<void> {
    const localLists = await db.getAllLists();
    
    if (localLists.length === 0) {
      return;
    }

    console.log(`📤 Syncing ${localLists.length} list${localLists.length > 1 ? 's' : ''}...`);

    for (const list of localLists) {
      try {
        const server = serverPool.getNextServer();
        console.log(`📡 Creating list "${list.name}" on ${server}`);
        const createResponse = await fetch(`${server}/api/lists`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            name: list.name, 
            id: list.id,
            vectorClock: list.vectorClock,
            createdAt: list.createdAt,
            lastUpdated: list.lastUpdated
          }),
        });
        
        // 200/201 = created, 409 = already exists
        if (createResponse.ok || createResponse.status === 409) {
          if (createResponse.ok) {
            console.log(`✅ Created list "${list.name}" on server`);
          }
          
          // Mark any pending CREATE_LIST operation for this list as synced
          const pending = await db.getPendingOperations();
          for (const op of pending) {
            if (op.type === 'CREATE_LIST' && op.data.id === list.id) {
              await db.markOperationSynced(op.id);
            }
          }
          
          // Sync items for this list
          const items = await db.getItemsByList(list.id);
          for (const item of items) {
            const itemServer = serverPool.getNextServer();
            console.log(`📡 Creating item "${item.name}" on ${itemServer}`);
            const itemResponse = await fetch(`${itemServer}/api/lists/${list.id}/items`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                name: item.name, 
                quantity: item.quantity,
                acquired: item.acquired,
                id: item.id,
                vectorClock: item.vectorClock,
                createdAt: item.createdAt,
                lastUpdated: item.lastUpdated
              }),
            });
            
            if (itemResponse.ok) {
              console.log(`✅ Created item "${item.name}" on server`);
            } else if (itemResponse.status === 409) {
              // Item already exists - update it with latest quantity/acquired
              console.log(`📡 Item "${item.name}" exists, updating quantity/acquired...`);
              await fetch(`${itemServer}/api/items/${item.id}/quantity`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  quantity: item.quantity,
                  acquired: item.acquired,
                  vectorClock: item.vectorClock,
                  lastUpdated: item.lastUpdated
                }),
              });
            }
            
            // Mark any pending ADD_ITEM operation for this item as synced
            for (const op of pending) {
              if (op.type === 'ADD_ITEM' && op.data.id === item.id) {
                await db.markOperationSynced(op.id);
              }
            }
          }
        } else if (createResponse.status >= 500) {
          throw new Error(`Server error: ${createResponse.status}`);
        }
      } catch (error) {
        throw error;
      }
    }
  }

  private async pushPendingOperations(): Promise<void> {
    const pending = await db.getPendingOperations();
    
    if (pending.length === 0) {
      return;
    }

    console.log(`📤 Syncing ${pending.length} change${pending.length > 1 ? 's' : ''}...`);

    for (const operation of pending) {
      try {
        const result = await this.sendOperationToServer(operation);
        
        // 404 on DELETE means already deleted, which is OK
        if (result.status === 404 && (operation.type === 'DELETE_LIST' || operation.type === 'REMOVE_ITEM')) {
          console.log(`✓ ${operation.type === 'DELETE_LIST' ? 'List' : 'Item'} already deleted on server`);
        }
        
        await db.markOperationSynced(operation.id);
      } catch (error: any) {
        throw error;
      }
    }
  }

  private async sendOperationToServer(operation: PendingOperation): Promise<{ status: number }> {
    const { type, data } = operation;

    switch (type) {
      case 'CREATE_LIST': {
        const server = serverPool.getNextServer();
        console.log(`📡 [${type}] "${data.name}" → ${server}`);
        const response = await fetch(`${server}/api/lists`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            name: data.name, 
            id: data.id,
            vectorClock: data.vectorClock,
            createdAt: data.createdAt,
            lastUpdated: data.lastUpdated
          }),
        });
        if (!response.ok && response.status !== 409) { // 409 = already exists, which is OK
          throw new Error(`Failed to create list: ${response.status}`);
        }
        return { status: response.status };
      }

      case 'DELETE_LIST': {
        const server = serverPool.getNextServer();
        console.log(`📡 [${type}] ${data.listId} → ${server}`);
        const response = await fetch(`${server}/api/lists/${data.listId}`, { method: 'DELETE' });
        if (!response.ok && response.status !== 404) {
          throw new Error(`Failed to delete list: ${response.status}`);
        }
        return { status: response.status };
      }

      case 'ADD_ITEM': {
        const server = serverPool.getNextServer();
        console.log(`📡 [${type}] "${data.name}" → ${server}`);
        const response = await fetch(`${server}/api/lists/${data.listId}/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            name: data.name, 
            quantity: data.quantity,
            acquired: data.acquired ?? 0,
            id: data.id,
            vectorClock: data.vectorClock,
            createdAt: data.createdAt,
            lastUpdated: data.lastUpdated
          }),
        });
        if (!response.ok && response.status !== 409) {
          throw new Error(`Failed to add item: ${response.status}`);
        }
        return { status: response.status };
      }

      case 'TOGGLE_CHECK': {
        const server = serverPool.getNextServer();
        console.log(`📡 [${type}] ${data.id} → ${server}`);
        const response = await fetch(`${server}/api/items/${data.id}/toggle`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            acquired: data.acquired,
            vectorClock: data.vectorClock,
            lastUpdated: data.lastUpdated
          })
        });
        if (!response.ok) {
          throw new Error(`Failed to toggle item: ${response.status}`);
        }
        return { status: response.status };
      }

      case 'UPDATE_QUANTITY': {
        const server = serverPool.getNextServer();
        console.log(`📡 [${type}] qty=${data.quantity} → ${server}`);
        const response = await fetch(`${server}/api/items/${data.id}/quantity`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            quantity: data.quantity,
            acquired: data.acquired,
            vectorClock: data.vectorClock,
            lastUpdated: data.lastUpdated
          }),
        });
        if (!response.ok) {
          throw new Error(`Failed to update quantity: ${response.status}`);
        }
        return { status: response.status };
      }

      case 'UPDATE_NAME': {
        const server = serverPool.getNextServer();
        console.log(`📡 [${type}] name="${data.name}" → ${server}`);
        const response = await fetch(`${server}/api/items/${data.id}/name`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: data.name,
            vectorClock: data.vectorClock,
            lastUpdated: data.lastUpdated
          }),
        });
        if (!response.ok) {
          throw new Error(`Failed to update name: ${response.status}`);
        }
        return { status: response.status };
      }

      case 'REMOVE_ITEM': {
        const server = serverPool.getNextServer();
        console.log(`📡 [${type}] ${data.itemId} → ${server}`);
        const response = await fetch(`${server}/api/items/${data.itemId}`, { method: 'DELETE' });
        if (!response.ok && response.status !== 404) {
          throw new Error(`Failed to remove item: ${response.status}`);
        }
        return { status: response.status };
      }
      
      default:
        return { status: 200 };
    }
  }

  /**
   * Pulls updates from server for lists the client already has locally.
   * Only syncs known lists to maintain privacy - clients don't fetch the entire server catalog.
   */
  private async pullFromServer(): Promise<void> {
    const localLists = await db.getAllLists();
    
    if (localLists.length === 0) {
      console.log('📭 No local lists to sync');
      return;
    }

    console.log(`📡 [PULL] Syncing ${localLists.length} list(s) from server`);
    const server = serverPool.getNextServer();
    

    for (const localList of localLists) {
      try {
        const response = await fetch(`${server}/api/lists/${localList.id}`);
        if (!response.ok) {
          if (response.status === 404) {
            console.log(`⚠️ List ${localList.id} not found on server`);
          }
          continue;
        }

        const serverList: ShoppingList = await response.json();

        // Merge list using vector clocks
        const listComparison = VectorClockOps.compare(serverList.vectorClock, localList.vectorClock);
        if (listComparison === 'after' || listComparison === 'concurrent') {
          // Merge vector clocks for list
          const mergedListClock = { ...localList.vectorClock };
          for (const [node, timestamp] of Object.entries(serverList.vectorClock || {})) {
            mergedListClock[node] = Math.max(mergedListClock[node] || 0, timestamp as number);
          }
          
          await db.saveList({
            id: serverList.id,
            name: serverList.name,
            createdAt: serverList.createdAt,
            lastUpdated: Math.max(serverList.lastUpdated, localList.lastUpdated),
            vectorClock: mergedListClock,
          });
        }

        // Merge items using CRDT semantics
        for (const serverItem of serverList.items || []) {
          const localItem = await db.getItem(serverItem.id);
          
          if (!localItem) {
            await db.saveItem(serverItem);
            console.log(`📥 New item from server: ${serverItem.name}`);
          } else {
            const itemComparison = VectorClockOps.compare(serverItem.vectorClock, localItem.vectorClock);
            
            if (itemComparison === 'after') {
              await db.saveItem(serverItem);
              console.log(`📥 Server item newer: ${serverItem.name}`);
            } else if (itemComparison === 'concurrent') {
              const mergedClock = { ...localItem.vectorClock };
              for (const [node, timestamp] of Object.entries(serverItem.vectorClock || {})) {
                mergedClock[node] = Math.max(mergedClock[node] || 0, timestamp as number);
              }
              
              const mergedQuantity = Math.max(localItem.quantity, serverItem.quantity ?? localItem.quantity);
              const mergedAcquired = Math.max(localItem.acquired, serverItem.acquired ?? localItem.acquired);
              
              // For name, use LWW
              let mergedName = localItem.name;
              if (serverItem.lastUpdated > localItem.lastUpdated) {
                mergedName = serverItem.name;
              }
              
              await db.saveItem({
                ...localItem,
                name: mergedName,
                quantity: mergedQuantity,
                acquired: mergedAcquired,
                vectorClock: mergedClock,
                lastUpdated: Math.max(serverItem.lastUpdated, localItem.lastUpdated)
              });
              console.log(`🔀 Merged item: ${serverItem.name} (qty: ${localItem.quantity}→${mergedQuantity}, acq: ${localItem.acquired}→${mergedAcquired})`);
            } else {
              // 'before' or 'equal' - local is newer or same, no action needed
              console.log(`⏭️ Local item newer/equal: ${localItem.name}`);
            }
            // If 'before' or 'equal', local is newer or same, so no action needed
          }
        }
        
        console.log(`📥 Synced list: ${serverList.name}`);
      } catch (error) {
        console.error(`Error pulling list ${localList.id}:`, error);
      }
    }
  }
}

export const syncService = new SyncService();
