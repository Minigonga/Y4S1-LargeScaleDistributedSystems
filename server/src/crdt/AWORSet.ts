import { CRDTShoppingListItem } from './CRDTShoppingListItem';
import { PNCounter } from './PNCounter';
import { LWWRegister } from './LWWRegister';

/**
 * Add-Wins Observed-Remove Set (AWORSet) CRDT.
 * Provides conflict-free set semantics where concurrent add and remove of the same
 * element results in the element being present (add-wins semantics).
 */
export class AWORSet {
  private elements: Map<string, CRDTShoppingListItem>;
  private addSet: Map<string, Set<string>>;
  private removeSet: Map<string, Set<string>>;
  private nodeId: string;
  private operationCounter: number;
  private localRemovals: Set<string>;

  constructor(nodeId: string) {
    this.elements = new Map();
    this.addSet = new Map();
    this.removeSet = new Map();
    this.nodeId = nodeId;
    this.operationCounter = 0;
    this.localRemovals = new Set(); // Tracks items removed locally but not yet synchronized
  }

  // Helper to merge two CRDTShoppingListItem objects
  private mergeCRDTItems(itemA: CRDTShoppingListItem, itemB: CRDTShoppingListItem): CRDTShoppingListItem {
    if (itemA.id !== itemB.id || itemA.listId !== itemB.listId) {
      throw new Error('Cannot merge items with different IDs');
    }

    return {
      ...itemA,
      name: this.mergeLWWRegisters(itemA.name, itemB.name),
      quantity: this.mergePNCounters(itemA.quantity, itemB.quantity),
      acquired: this.mergePNCounters(itemA.acquired, itemB.acquired),
      lastUpdated: Math.max(itemA.lastUpdated, itemB.lastUpdated),
      vectorClock: this.mergeVectorClocks(itemA.vectorClock, itemB.vectorClock)
    };
  }

  private mergeLWWRegisters<T>(a: LWWRegister<T>, b: LWWRegister<T>): LWWRegister<T> {
    // Use a.nodeId (public property) instead of a['nodeId'] (private access)
    const merged = new LWWRegister(a.getValue(), a.getNodeId());
    merged.merge(b);
    return merged;
  }

  private mergePNCounters(a: PNCounter, b: PNCounter): PNCounter {
    // Use a.nodeId (public getter) instead of a['nodeId']
    const merged = new PNCounter(a.nodeId);
    merged.merge(a);
    merged.merge(b);
    return merged;
  }

  private mergeVectorClocks(a: { [nodeId: string]: number }, b: { [nodeId: string]: number }) {
    const merged = { ...a };
    for (const [nodeId, time] of Object.entries(b)) {
      merged[nodeId] = Math.max(merged[nodeId] || 0, time);
    }
    return merged;
  }

  add(item: CRDTShoppingListItem): string {
    const itemId = item.id;
    this.operationCounter++;
    const uniqueTag = `${this.nodeId}:${Date.now()}:${this.operationCounter}`;

    this.elements.set(itemId, item);
    
    if (!this.addSet.has(itemId)) {
      this.addSet.set(itemId, new Set());
    }
    this.addSet.get(itemId)!.add(uniqueTag);
    
    // Clear remove set and local removal when adding
    this.removeSet.delete(itemId);
    this.localRemovals.delete(itemId);

    return itemId;
  }

  remove(itemId: string): boolean {
    if (!this.elements.has(itemId)) return false;

    this.operationCounter++;
    const uniqueTag = `${this.nodeId}:${Date.now()}:${this.operationCounter}`;

    if (!this.removeSet.has(itemId)) {
      this.removeSet.set(itemId, new Set());
    }
    this.removeSet.get(itemId)!.add(uniqueTag);

    this.localRemovals.add(itemId);

    return true;
  }

  /**
   * Updates a CRDT field on an item, using the appropriate CRDT merge semantics.
   * PNCounters are updated with delta calculations; LWWRegisters use setValue.
   */
  updateField(
    itemId: string,
    field: keyof CRDTShoppingListItem,
    value: any,
    nodeId?: string
  ): boolean {
    const item = this.elements.get(itemId);
    if (!item || this.localRemovals.has(itemId)) return false;

    const targetNodeId = nodeId || this.nodeId;

    switch (field) {
      case 'name':
        if (item[field] instanceof LWWRegister) {
          (item[field] as LWWRegister<any>).setValue(value, targetNodeId);
        }
        break;

      case 'quantity':
      case 'acquired':
        if (item[field] instanceof PNCounter) {
          const counter = item[field] as PNCounter;
          const current = counter.value();
          const delta = value - current;
          
          if (delta > 0) {
            counter.increment(delta);
          } else if (delta < 0) {
            counter.decrement(-delta);
          }
        }
        break;
    }

    item.lastUpdated = Date.now();
    item.vectorClock[targetNodeId] = (item.vectorClock[targetNodeId] || 0) + 1;

    return true;
  }

  get(itemId: string): CRDTShoppingListItem | undefined {
    if (this.localRemovals.has(itemId) || !this.shouldExist(itemId)) {
      return undefined;
    }
    return this.elements.get(itemId);
  }

  getAll(): CRDTShoppingListItem[] {
    const result: CRDTShoppingListItem[] = [];
    for (const [itemId, item] of this.elements) {
      if (!this.localRemovals.has(itemId) && this.shouldExist(itemId)) {
        result.push(item);
      }
    }
    return result;
  }

  getByList(listId: string): CRDTShoppingListItem[] {
    return this.getAll().filter(item => item.listId === listId);
  }

  merge(other: AWORSet): void {
    // Clear local removals on merge (they're only for local visibility)
    this.localRemovals.clear();

    // Merge add sets
    for (const [itemId, otherAddTags] of other.addSet) {
      if (!this.addSet.has(itemId)) {
        this.addSet.set(itemId, new Set());
      }
      const ourAddTags = this.addSet.get(itemId)!;
      for (const tag of otherAddTags) {
        ourAddTags.add(tag);
      }
    }

    // Merge remove sets
    for (const [itemId, otherRemoveTags] of other.removeSet) {
      if (!this.removeSet.has(itemId)) {
        this.removeSet.set(itemId, new Set());
      }
      const ourRemoveTags = this.removeSet.get(itemId)!;
      for (const tag of otherRemoveTags) {
        ourRemoveTags.add(tag);
      }
    }

    // Determine final state and merge CRDT items
    const allItemIds = new Set([
      ...this.addSet.keys(),
      ...other.addSet.keys()
    ]);

    for (const itemId of allItemIds) {
      const shouldExist = this.shouldExist(itemId);
      
      if (shouldExist) {
        const ourItem = this.elements.get(itemId);
        const theirItem = other.elements.get(itemId);
        
        if (ourItem && theirItem) {
          // Merge the two CRDT items
          const merged = this.mergeCRDTItems(ourItem, theirItem);
          this.elements.set(itemId, merged);
        } else if (theirItem) {
          // Take theirs
          this.elements.set(itemId, theirItem);
        }
      } else {
        // Item should not exist
        this.elements.delete(itemId);
      }
    }
  }

  private shouldExist(itemId: string): boolean {
    const addTags = this.addSet.get(itemId);
    const removeTags = this.removeSet.get(itemId);

    if (!addTags || addTags.size === 0) return false;
    if (!removeTags || removeTags.size === 0) return true;

    // Add-wins semantics
    for (const addTag of addTags) {
      if (!removeTags.has(addTag)) {
        return true;
      }
    }

    return false;
  }

  getState() {
    return {
      elements: Array.from(this.elements.entries()).map(([k, v]) => [k, this.serializeItem(v)]),
      addSet: Array.from(this.addSet.entries()).map(([k, v]) => [k, Array.from(v)]),
      removeSet: Array.from(this.removeSet.entries()).map(([k, v]) => [k, Array.from(v)]),
      nodeId: this.nodeId
    };
  }

  setState(state: any): void {
    // Restore the sets first
    this.addSet = new Map(
      state.addSet.map(([k, v]: [string, string[]]) => [k, new Set(v)])
    );
    this.removeSet = new Map(
      state.removeSet.map(([k, v]: [string, string[]]) => [k, new Set(v)])
    );
    
    // Restore elements, but only those that should exist
    this.elements = new Map();
    for (const [k, v] of state.elements) {
      if (this.shouldExist(k)) {
        this.elements.set(k, this.deserializeItem(v));
      }
    }
    
    this.nodeId = state.nodeId || this.nodeId;
    this.localRemovals.clear();
  }

  private serializeItem(item: CRDTShoppingListItem): any {
    return {
      id: item.id,
      listId: item.listId,
      name: item.name.getState(),
      quantity: item.quantity.getState(),
      acquired: item.acquired.getState(),
      createdAt: item.createdAt,
      lastUpdated: item.lastUpdated,
      vectorClock: item.vectorClock
    };
  }

  private deserializeItem(data: any): CRDTShoppingListItem {
    // Use type assertions to help TypeScript understand the types
    const name = LWWRegister.fromState<string>(data.name);
    
    // For PNCounter
    const quantityNodeId = data.quantity?.nodeId || this.nodeId;
    const quantity = new PNCounter(quantityNodeId);
    quantity.setState(data.quantity);
    
    const acquiredNodeId = data.acquired?.nodeId || this.nodeId;
    const acquired = new PNCounter(acquiredNodeId);
    acquired.setState(data.acquired);

    return {
      id: data.id,
      listId: data.listId,
      name,
      quantity,
      acquired,
      createdAt: data.createdAt,
      lastUpdated: data.lastUpdated,
      vectorClock: data.vectorClock || {}
    };
  }
}