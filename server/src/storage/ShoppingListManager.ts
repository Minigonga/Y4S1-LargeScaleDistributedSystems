import { v4 as uuidv4 } from 'uuid';
import { ShoppingList, ShoppingListItem } from '../shared/types';
import { SQLiteStore } from './SQLiteStore';
import { AWORSet } from '../crdt/AWORSet';
import { CRDTShoppingListItem } from '../crdt/CRDTShoppingListItem';
import { LWWRegister } from '../crdt/LWWRegister';
import { PNCounter } from '../crdt/PNCounter';  
import { crdtToDB, dbToCRDT } from '../crdt/Converters';
import { VectorClock } from '../crdt/VectorClock';

/**
 * Manages shopping lists and items using CRDTs for conflict-free replication.
 * Handles persistence to SQLite and synchronization with other nodes.
 */
export class ShoppingListManager {
  private lists: Map<string, ShoppingList> = new Map();
  private items: AWORSet;
  private nodeId: string;
  private store: SQLiteStore;
  private isInitialized: boolean = false;

  constructor(nodeId: string = uuidv4(), store?: SQLiteStore) {
    this.nodeId = nodeId;
    this.store = store || new SQLiteStore();
    this.items = new AWORSet(nodeId);
  }

  async initialize(): Promise<void> {
    if (!this.isInitialized) {
      await this.loadFromStorage();
      this.isInitialized = true;
    }
  }

  private async loadFromStorage(): Promise<void> {
    try {
      const listsWithItems = await this.store.getAllLists();
      
      this.lists.clear();
      this.items = new AWORSet(this.nodeId);
      
      listsWithItems.forEach(listWithItems => {
        const list: ShoppingList = {
          id: listWithItems.id,
          name: listWithItems.name,
          createdAt: listWithItems.createdAt,
          lastUpdated: listWithItems.lastUpdated,
          vectorClock: listWithItems.vectorClock
        };
        this.lists.set(listWithItems.id, list);

        // Convert each stored item to CRDT item and add to AWORSet
        listWithItems.items.forEach(item => {
          const crdtItem = dbToCRDT(item, this.nodeId);
          this.items.add(crdtItem);
        });
      });
      
      console.log(`✅ Loaded ${listsWithItems.length} lists and ${this.items.getAll().length} items from storage`);
    } catch (error) {
      console.error('❌ Error loading from storage:', error);
    }
  }

  /** 
   * Increments this node's entry in the list's vector clock. 
   */
  private incrementListClock(list: ShoppingList): void {
    if (!list.vectorClock) list.vectorClock = {};
    list.vectorClock[this.nodeId] = (list.vectorClock[this.nodeId] || 0) + 1;
  }

  async createList(
    name: string, 
    clientId?: string,
    vectorClock?: { [nodeId: string]: number },
    createdAt?: number,
    lastUpdated?: number
  ): Promise<ShoppingList & { items: ShoppingListItem[] }> {
    const listId = clientId || uuidv4();
    const now = Date.now();
    
    const list: ShoppingList = {
      id: listId,
      name,
      createdAt: createdAt || now,
      lastUpdated: lastUpdated || now,
      vectorClock: vectorClock || { [this.nodeId]: 1 }  // New list starts at 1
    };

    this.lists.set(listId, list);
    await this.store.saveList(list);
    
    return { ...list, items: [] };
  }

  async getList(listId: string): Promise<(ShoppingList & { items: ShoppingListItem[] }) | null> {
    const list = this.lists.get(listId);
    if (!list) return null;

    // Get CRDT items and convert to simple items for API
    const crdtItems = this.items.getByList(listId);
    const items = crdtItems.map(item => crdtToDB(item));
    
    return { ...list, items };
  }

  async addItemToList(listId: string, itemData: {
    id?: string;
    name: string;
    quantity?: number;
    acquired?: number;
    vectorClock?: { [nodeId: string]: number; };
    createdAt?: number;
    lastUpdated?: number;
  }): Promise<ShoppingListItem | null> {
    const list = this.lists.get(listId);
    if (!list) return null;

    const now = Date.now();
    const itemId = itemData.id || uuidv4();

    // Create CRDT item
    const crdtItem: CRDTShoppingListItem = {
      id: itemId,
      listId,
      name: new LWWRegister(itemData.name, this.nodeId),
      quantity: new PNCounter(this.nodeId),
      acquired: new PNCounter(this.nodeId),
      createdAt: itemData.createdAt || now,
      lastUpdated: itemData.lastUpdated || now,
      vectorClock: itemData.vectorClock || { [this.nodeId]: 1 }  // New item starts at 1
    };

    // Initialize counters
    crdtItem.quantity.increment(itemData.quantity || 1);
    crdtItem.acquired.increment(itemData.acquired ?? 0);

    // Add to AWORSet
    this.items.add(crdtItem);

    // Update list timestamp and clock
    list.lastUpdated = now;
    this.incrementListClock(list);

    try {
      await this.store.saveList(list);
      await this.store.saveItem(crdtToDB(crdtItem));
      return crdtToDB(crdtItem);
    } catch (error) {
      console.error(`❌ Error adding item to list ${listId}:`, error);
      return null;
    }
  }

  async updateList(listData: Partial<ShoppingList> & { id: string }): Promise<ShoppingList | null> {
    const existingList = this.lists.get(listData.id);
    if (!existingList) {
      console.warn(`[${this.nodeId}] updateList called but list ${listData.id} not found`);
      return null;
    }

    // Merge fields
    if (listData.name !== undefined) existingList.name = listData.name;
    if (listData.lastUpdated !== undefined) existingList.lastUpdated = listData.lastUpdated;

    // Merge vector clocks using component-wise max
    if (!existingList.vectorClock) existingList.vectorClock = {};
    if (listData.vectorClock) {
      for (const [node, counter] of Object.entries(listData.vectorClock)) {
        existingList.vectorClock[node] = Math.max(existingList.vectorClock[node] || 0, counter);
      }
    }

    // Save to storage
    await this.store.saveList(existingList);

    return existingList;
  }

  async getItem(itemId: string): Promise<ShoppingListItem | null> {
    const crdtItem = this.items.get(itemId);
    if (!crdtItem) return null;
    return crdtToDB(crdtItem);
  }

  /** 
   * Returns the raw CRDT item for direct vector clock manipulation. 
   */
  getCRDTItem(itemId: string): CRDTShoppingListItem | undefined {
    return this.items.get(itemId);
  }

  async updateItem(itemId: string, updates: Partial<Omit<ShoppingListItem, 'id' | 'listId' | 'createdAt' | 'vectorClock'>>): Promise<ShoppingListItem | null> {
    for (const [field, value] of Object.entries(updates)) {
      if (value !== undefined) {
        const crdtField = this.mapSimpleFieldToCRDTField(field as keyof typeof updates);
        if (crdtField) {
          this.items.updateField(itemId, crdtField, value);
        }
      }
    }
    
    const crdtItem = this.items.get(itemId);
    if (!crdtItem) return null;
    
    // Update list timestamp and clock
    const list = this.lists.get(crdtItem.listId);
    if (list) {
      list.lastUpdated = Date.now();
      this.incrementListClock(list);
      await this.store.saveList(list);
    }
    
    await this.store.saveItem(crdtToDB(crdtItem));
    return crdtToDB(crdtItem);
  }

  private mapSimpleFieldToCRDTField(field: string): keyof CRDTShoppingListItem | null {
    const mapping: Record<string, keyof CRDTShoppingListItem> = {
      'name': 'name',
      'quantity': 'quantity',
      'acquired': 'acquired'
    };
    
    return mapping[field] || null;
  }

  /**
   * Update item name using LWW semantics.
   */
  async updateItemName(itemId: string, name: string): Promise<ShoppingListItem | null> {
    const nameSuccess = this.items.updateField(itemId, 'name', name);
    if (!nameSuccess) return null;
    
    const crdtItem = this.items.get(itemId);
    if (!crdtItem) return null;
    
    // Update list timestamp and clock
    const list = this.lists.get(crdtItem.listId);
    if (list) {
      list.lastUpdated = Date.now();
      this.incrementListClock(list);
      await this.store.saveList(list);
    }
    
    await this.store.saveItem(crdtToDB(crdtItem));
    return crdtToDB(crdtItem);
  }


  async updateItemQuantity(itemId: string, quantity: number, acquired: number = 0): Promise<ShoppingListItem | null> {
    // Update quantity field
    const quantitySuccess = this.items.updateField(itemId, 'quantity', quantity);
    if (!quantitySuccess) return null;
    
    // Update acquired field if provided
    if (acquired !== undefined) {
      this.items.updateField(itemId, 'acquired', acquired);
    }
    
    const crdtItem = this.items.get(itemId);
    if (!crdtItem) return null;
    
    // Update list timestamp and clock
    const list = this.lists.get(crdtItem.listId);
    if (list) {
      list.lastUpdated = Date.now();
      this.incrementListClock(list);
      await this.store.saveList(list);
    }
    
    await this.store.saveItem(crdtToDB(crdtItem));
    return crdtToDB(crdtItem);
  }

  /**
   * Set the acquired state to achieve checked/unchecked status.
   * checked = acquired >= quantity, so we set acquired accordingly.
   */
  async setItemCheck(itemId: string, checked: boolean, acquired?: number): Promise<ShoppingListItem | null> {
    const crdtItem = this.items.get(itemId);
    if (!crdtItem) return null;

    // If acquired is provided, use it; otherwise set based on checked state
    if (acquired !== undefined) {
      this.items.updateField(itemId, 'acquired', acquired);
    } else if (checked) {
      // If checking, set acquired to quantity
      this.items.updateField(itemId, 'acquired', crdtItem.quantity.value());
    } else {
      // If unchecking, set acquired to 0
      this.items.updateField(itemId, 'acquired', 0);
    }

    const updatedItem = this.items.get(itemId);
    if (!updatedItem) return null;

    // Update list timestamp and clock
    const list = this.lists.get(updatedItem.listId);
    if (list) {
      list.lastUpdated = Date.now();
      this.incrementListClock(list);
      await this.store.saveList(list);
    }

    await this.store.saveItem(crdtToDB(updatedItem));
    return crdtToDB(updatedItem);
  }

  async toggleItemCheck(itemId: string): Promise<ShoppingListItem | null> {
    const crdtItem = this.items.get(itemId);
    if (!crdtItem) return null;

    const currentQuantity = crdtItem.quantity.value();
    const currentAcquired = crdtItem.acquired.value();
    const isCurrentlyChecked = currentQuantity > 0 && currentAcquired >= currentQuantity;

    if (isCurrentlyChecked) {
      this.items.updateField(itemId, 'acquired', 0);
    } else {
      this.items.updateField(itemId, 'acquired', currentQuantity);
    }

    const updatedItem = this.items.get(itemId);
    if (!updatedItem) return null;

    // Update list timestamp and clock
    const list = this.lists.get(updatedItem.listId);
    if (list) {
      list.lastUpdated = Date.now();
      this.incrementListClock(list);
      await this.store.saveList(list);
    }

    await this.store.saveItem(crdtToDB(updatedItem));
    return crdtToDB(updatedItem);
  }

  async deleteList(listId: string): Promise<boolean> {
    const list = this.lists.get(listId);
    if (!list) return false;

    try {
      // Remove all items from this list from the AWORSet
      const listItems = this.items.getByList(listId);
      for (const item of listItems) {
        this.items.remove(item.id);
      }

      // Remove the list from local storage
      this.lists.delete(listId);
      
      // Remove from database
      await this.store.deleteList(listId);
      
      return true;
    } catch (error) {
      console.error(`❌ Error deleting list ${listId}:`, error);
      return false;
    }
  }

  async removeItemFromList(itemId: string): Promise<boolean> {
    const success = this.items.remove(itemId);
    if (!success) return false;

    // Get item before removal to get listId
    const item = this.items.get(itemId); // Note: this might return undefined if already removed
    if (item) {
      // Update list timestamp and clock
      const list = this.lists.get(item.listId);
      if (list) {
        list.lastUpdated = Date.now();
        this.incrementListClock(list);
        await this.store.saveList(list);
      }
    }

    // Remove from database
    await this.store.deleteItem(itemId);
    return true;
  }

  async getAllLists(): Promise<(ShoppingList & { items: ShoppingListItem[] })[]> {
    const result: (ShoppingList & { items: ShoppingListItem[] })[] = [];
    
    for (const list of this.lists.values()) {
      const crdtItems = this.items.getByList(list.id);
      const items = crdtItems.map(item => crdtToDB(item));
      result.push({ ...list, items });
    }
    
    return result;
  }

  async getAllItems(): Promise<ShoppingListItem[]> {
    return this.items.getAll().map(item => crdtToDB(item));
  }

  /**
   * Processes an incoming sync update from another node.
   * Supports both JSON updates (from ZeroMQ) and direct manager merges.
   */
  async syncWithOtherManager(update: any): Promise<void> {
    console.log(`[${this.nodeId}] syncWithOtherManager called with type: ${update?.type || 'unknown'}`);
    
    try {
      if (update && typeof update === 'object' && !(update instanceof ShoppingListManager)) {
        await this.handleJSONUpdate(update);
      } else if (update instanceof ShoppingListManager) {
        await this.handleManagerUpdate(update);
      } else {
        console.warn(`[${this.nodeId}] Unknown update format:`, typeof update);
      }

      await this.persistAllChanges();
    } catch (error) {
      console.error(`[${this.nodeId}] Error in syncWithOtherManager:`, error);
      throw error;
    }
  }

  private async handleJSONUpdate(update: any): Promise<void> {
    switch (update.type) {
      case 'CREATE_LIST':
        await this.handleCreateListUpdate(update.list);
        break;
        
      case 'ADD_ITEM':
        await this.handleAddItemUpdate(update.item);
        break;
        
      case 'UPDATE_ITEM':
        await this.handleUpdateItemUpdate(update.item);
        break;
        
      case 'TOGGLE_CHECK':
        await this.handleToggleCheckUpdate(update.item);
        break;
        
      case 'UPDATE_QUANTITY':
        await this.handleUpdateQuantityUpdate(update.item);
        break;
        
      case 'REMOVE_ITEM':
        await this.handleRemoveItemUpdate(update.itemId);
        break;
        
      case 'DELETE_LIST':
        await this.handleDeleteListUpdate(update.listId);
        break;
        
      case 'FULL_SYNC':
        if (update.itemsState) {
          await this.mergeItemsState(update.itemsState);
        }
        break;
        
      default:
        console.warn(`[${this.nodeId}] Unknown JSON update type: ${update.type}`);
    }
  }

  private async handleManagerUpdate(otherManager: ShoppingListManager): Promise<void> {
    // Merge CRDT items sets
    this.items.merge(otherManager.items);
    
    // Merge lists (simple LWW for now)
    for (const [listId, otherList] of otherManager.lists) {
      const currentList = this.lists.get(listId);
      if (!currentList || otherList.lastUpdated > currentList.lastUpdated) {
        this.lists.set(listId, otherList);
      }
    }
  }

  private async handleCreateListUpdate(listData: any): Promise<void> {
    if (!listData || !listData.id) {
      console.error(`[${this.nodeId}] Invalid list data for CREATE_LIST`);
      return;
    }
    
    const existingList = this.lists.get(listData.id);
    if (existingList) {
      if (listData.lastUpdated > existingList.lastUpdated) {
        this.lists.set(listData.id, listData);
        await this.store.saveList(listData);
        console.log(`[${this.nodeId}] Updated list from sync: ${listData.name}`);
      }
    } else {
      this.lists.set(listData.id, listData);
      await this.store.saveList(listData);
      console.log(`[${this.nodeId}] Created list from sync: ${listData.name}`);
    }
  }

  private async handleAddItemUpdate(itemData: any): Promise<void> {
    if (!itemData || !itemData.id || !itemData.listId) {
      console.error(`[${this.nodeId}] Invalid item data for ADD_ITEM`);
      return;
    }
    
    // Check if item already exists
    const existingItem = this.items.get(itemData.id);
    if (existingItem) {
      console.log(`[${this.nodeId}] Item ${itemData.id} already exists`);
      return;
    }
    
    // Convert incoming item data to CRDTShoppingListItem
    const crdtItem = this.jsonToCRDTItem(itemData);
    if (!crdtItem) return;
    
    // Add to AWORSet
    this.items.add(crdtItem);
    
    console.log(`[${this.nodeId}] Added item from sync: ${itemData.name}, ID: ${itemData.id}`);
    
    // Update list timestamp and clock
    const list = this.lists.get(itemData.listId);
    if (list) {
      list.lastUpdated = Date.now();
      this.incrementListClock(list);
      await this.store.saveList(list);
    }
    
    // Save item to database
    await this.store.saveItem(crdtToDB(crdtItem));
  }

  private async handleUpdateItemUpdate(itemData: any): Promise<void> {
    if (!itemData || !itemData.id) {
      console.error(`[${this.nodeId}] Invalid item data for UPDATE_ITEM`);
      return;
    }
    
    // For each field in itemData, update the corresponding CRDT field
    const fieldsToUpdate: (keyof CRDTShoppingListItem)[] = [
      'name', 'quantity', 'acquired'
    ];
    
    for (const field of fieldsToUpdate) {
      if (itemData[field] !== undefined) {
        this.items.updateField(itemData.id, field, itemData[field]);
      }
    }
    
    console.log(`[${this.nodeId}] Updated item from sync: ${itemData.id}`);
    
    // Update list timestamp and clock
    const item = this.items.get(itemData.id);
    if (item && item.listId) {
      const list = this.lists.get(item.listId);
      if (list) {
        list.lastUpdated = Date.now();
        this.incrementListClock(list);
        await this.store.saveList(list);
      }
    }
    
    // Save to database
    const updatedItem = this.items.get(itemData.id);
    if (updatedItem) {
      await this.store.saveItem(crdtToDB(updatedItem));
    }
  }

  private async handleToggleCheckUpdate(itemData: any): Promise<void> {
    if (!itemData || !itemData.id) return;
    
    const crdtItem = this.items.get(itemData.id);
    if (!crdtItem) return;
    
    const incomingClock = typeof itemData.vectorClock === 'string' 
      ? JSON.parse(itemData.vectorClock) 
      : (itemData.vectorClock || {});
    
    const comparison = VectorClock.compare(incomingClock, crdtItem.vectorClock);
    
    if (comparison === 'before') {
      console.log(`[${this.nodeId}] Ignoring older toggle update for ${itemData.id}`);
      return;
    }
    
    let finalAcquired = itemData.acquired;
    
    if (comparison === 'concurrent') {
      const currentAcquired = crdtItem.acquired.value();
      finalAcquired = Math.max(currentAcquired, itemData.acquired ?? 0);
      
      console.log(`[${this.nodeId}] Merging concurrent toggle: local_acq=${currentAcquired}, remote_acq=${itemData.acquired}, merged=${finalAcquired}`);
      
      const mergedClock: Record<string, number> = { ...crdtItem.vectorClock };
      for (const [node, timestamp] of Object.entries(incomingClock)) {
        mergedClock[node] = Math.max(mergedClock[node] || 0, timestamp as number);
      }
      crdtItem.vectorClock = mergedClock;
    } else {
      // 'after' or 'equal': incoming is newer, use incoming clock
      crdtItem.vectorClock = incomingClock;
    }
    
    if (finalAcquired !== undefined) {
      this.items.updateField(itemData.id, 'acquired', finalAcquired);
    }
    
    // Update list timestamp and clock
    const list = this.lists.get(crdtItem.listId);
    if (list) {
      list.lastUpdated = Date.now();
      this.incrementListClock(list);
      await this.store.saveList(list);
    }
    
    const updatedItem = this.items.get(itemData.id);
    if (updatedItem) {
      await this.store.saveItem(crdtToDB(updatedItem));
    }
  }

  private async handleUpdateQuantityUpdate(itemData: any): Promise<void> {
    if (!itemData || !itemData.id) return;
    
    const currentItem = this.items.get(itemData.id);
    if (!currentItem) return;
    
    const incomingClock = typeof itemData.vectorClock === 'string' 
      ? JSON.parse(itemData.vectorClock) 
      : (itemData.vectorClock || {});
    
    const comparison = VectorClock.compare(incomingClock, currentItem.vectorClock);
    
    if (comparison === 'before') {
      console.log(`[${this.nodeId}] Ignoring older quantity update for ${itemData.id}`);
      return;
    }
    
    let finalQuantity = itemData.quantity;
    let finalAcquired = itemData.acquired;
    let isConcurrentMerge = false;
    
    if (comparison === 'concurrent') {
      isConcurrentMerge = true;
      const currentQuantity = currentItem.quantity.value();
      const currentAcquired = currentItem.acquired.value();
      finalQuantity = Math.max(currentQuantity, itemData.quantity ?? currentQuantity);
      finalAcquired = Math.max(currentAcquired, itemData.acquired ?? currentAcquired);
      console.log(`[${this.nodeId}] Merging concurrent quantity: local=${currentQuantity}, remote=${itemData.quantity}, merged=${finalQuantity}`);
      
      const mergedClock: Record<string, number> = { ...currentItem.vectorClock };
      for (const [node, timestamp] of Object.entries(incomingClock)) {
        mergedClock[node] = Math.max(mergedClock[node] || 0, timestamp as number);
      }
      currentItem.vectorClock = mergedClock;
    } else {
      // 'after' or 'equal': incoming is newer, use incoming values and clock
      currentItem.vectorClock = incomingClock;
    }
    
    if (finalQuantity !== undefined) {
      this.items.updateField(itemData.id, 'quantity', finalQuantity);
    }
    
    if (finalAcquired !== undefined) {
      this.items.updateField(itemData.id, 'acquired', finalAcquired);
    }
    
    // Update list timestamp and clock
    const item = this.items.get(itemData.id);
    if (item && item.listId) {
      const list = this.lists.get(item.listId);
      if (list) {
        list.lastUpdated = Date.now();
        this.incrementListClock(list);
        await this.store.saveList(list);
      }
    }
    
    const updatedItem = this.items.get(itemData.id);
    if (updatedItem) {
      await this.store.saveItem(crdtToDB(updatedItem));
    }
  }

  private async handleRemoveItemUpdate(itemId: string): Promise<void> {
    const success = this.items.remove(itemId);
    if (success) {
      console.log(`[${this.nodeId}] Removed item from sync: ${itemId}`);
      await this.store.deleteItem(itemId);
    } else {
      console.log(`[${this.nodeId}] Item ${itemId} not found or already removed`);
    }
  }

  private async handleDeleteListUpdate(listId: string): Promise<void> {
    const list = this.lists.get(listId);
    if (!list) {
      console.log(`[${this.nodeId}] List ${listId} not found for deletion`);
      return;
    }
    
    try {
      // Remove all items from this list from the AWORSet
      const listItems = this.items.getByList(listId);
      for (const item of listItems) {
        this.items.remove(item.id);
      }

      // Remove the list
      this.lists.delete(listId);
      
      // Remove from database
      await this.store.deleteList(listId);
      
      console.log(`[${this.nodeId}] Deleted list from sync: ${list.name} (${listId})`);
    } catch (error) {
      console.error(`[${this.nodeId}] Error deleting list ${listId}:`, error);
    }
  }

  private async mergeItemsState(itemsState: any): Promise<void> {
    console.log(`[${this.nodeId}] Merging full items state`);
    
    // Create a temporary AWORSet with the received state
    const tempItems = new AWORSet(this.nodeId);
    
    if (itemsState && typeof itemsState === 'object') {
      tempItems.setState(itemsState);
      
      // Merge with our items AWORSet
      this.items.merge(tempItems);
      console.log(`[${this.nodeId}] Merged items AWORSet state`);
    }
  }

  private async persistAllChanges(): Promise<void> {
    // Save all lists
    for (const list of this.lists.values()) {
      await this.store.saveList(list);
    }

    // Save all items (convert CRDT items to simple items for storage)
    for (const crdtItem of this.items.getAll()) {
      await this.store.saveItem(crdtToDB(crdtItem));
    }

    // Remove items that are no longer in the CRDT set
    const allStoredItems = await this.store.getAllItems();
    const currentItemIds = new Set(this.items.getAll().map(item => item.id));
    
    for (const storedItem of allStoredItems) {
      if (!currentItemIds.has(storedItem.id)) {
        await this.store.deleteItem(storedItem.id);
      }
    }
  }

  // Helper to convert JSON data to CRDTShoppingListItem
  private jsonToCRDTItem(data: any): CRDTShoppingListItem | null {
    if (!data || !data.id || !data.listId) return null;
    
    return {
      id: data.id,
      listId: data.listId,
      name: new LWWRegister(data.name || '', this.nodeId),
      quantity: (() => {
        const counter = new PNCounter(this.nodeId);
        if (data.quantity !== undefined) {
          counter.increment(data.quantity);
        }
        return counter;
      })(),
      acquired: (() => {
        const counter = new PNCounter(this.nodeId);
        if (data.acquired !== undefined) {
          counter.increment(data.acquired);
        }
        return counter;
      })(),
      createdAt: data.createdAt || Date.now(),
      lastUpdated: data.lastUpdated || Date.now(),
      vectorClock: data.vectorClock || { [this.nodeId]: 1 }  // New item starts at 1
    };
  }

  async close(): Promise<void> {
    this.store.close();
  }

  getStats(): { lists: number; items: number; nodeId: string } {
    return {
      lists: this.lists.size,
      items: this.items.getAll().length,
      nodeId: this.nodeId
    };
  }

  // Helper method to get the AWORSet state for debugging
  getItemsState(): any {
    return this.items.getState();
  }
}