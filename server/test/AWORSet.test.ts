import { AWORSet } from '../src/crdt/AWORSet';
import { CRDTShoppingListItem } from '../src/crdt/CRDTShoppingListItem';
import { LWWRegister } from '../src/crdt/LWWRegister';
import { PNCounter } from '../src/crdt/PNCounter';

describe('AWORSet', () => {
  let aworset: AWORSet;

  beforeEach(() => {
    aworset = new AWORSet('node1');
  });

  describe('constructor', () => {
    it('should initialize with empty collections', () => {
      expect(aworset.getAll()).toEqual([]);
    });

    it('should use the provided node ID', () => {
      const setWithNodeId = new AWORSet('test-node');
      // We can't directly access nodeId, but we can verify through operations
      const item: CRDTShoppingListItem = createTestItem('item1', 'list1');
      setWithNodeId.add(item);
      // The operation should use the correct node ID
    });
  });

  describe('add', () => {
    it('should add an item to the set', () => {
      const item = createTestItem('item1', 'list1');
      const itemId = aworset.add(item);
      
      expect(itemId).toBe('item1');
      expect(aworset.get('item1')).toBeDefined();
      expect(aworset.getAll()).toHaveLength(1);
    });

    it('should clear remove set and local removal when adding', () => {
      const item = createTestItem('item1', 'list1');
      aworset.add(item);
      aworset.remove('item1');
      
      // Item should be locally removed
      expect(aworset.get('item1')).toBeUndefined();
      
      // Re-add the item
      aworset.add(item);
      
      // Item should be visible again
      expect(aworset.get('item1')).toBeDefined();
    });

    it('should generate unique tags for adds', () => {
      const item1 = createTestItem('item1', 'list1');
      const item2 = createTestItem('item2', 'list1');
      
      aworset.add(item1);
      aworset.add(item2);
      
      // Both items should exist
      expect(aworset.get('item1')).toBeDefined();
      expect(aworset.get('item2')).toBeDefined();
    });
  });

  describe('remove', () => {
    it('should remove an existing item', () => {
      const item = createTestItem('item1', 'list1');
      aworset.add(item);
      
      expect(aworset.remove('item1')).toBe(true);
      expect(aworset.get('item1')).toBeUndefined();
    });

    it('should return false when removing non-existent item', () => {
      expect(aworset.remove('non-existent')).toBe(false);
    });

    it('should mark item as locally removed', () => {
      const item = createTestItem('item1', 'list1');
      aworset.add(item);
      aworset.remove('item1');
      
      // Item should not be visible locally
      expect(aworset.get('item1')).toBeUndefined();
    });
  });

  describe('updateField', () => {
    it('should update LWWRegister fields', () => {
      const item = createTestItem('item1', 'list1');
      aworset.add(item);
      
      aworset.updateField('item1', 'name', 'Updated Name');
      
      const updatedItem = aworset.get('item1');
      expect(updatedItem?.name.getValue()).toBe('Updated Name');
    });

    it('should update PNCounter fields by delta', () => {
      const item = createTestItem('item1', 'list1');
      aworset.add(item);
      
      // Increment quantity
      aworset.updateField('item1', 'quantity', 5);
      expect(aworset.get('item1')?.quantity.value()).toBe(5);
      
      // Update quantity again
      aworset.updateField('item1', 'quantity', 3);
      expect(aworset.get('item1')?.quantity.value()).toBe(3);
    });

    it('should return false for non-existent item', () => {
      const result = aworset.updateField('non-existent', 'name', 'Updated');
      expect(result).toBe(false);
    });

    it('should return false for locally removed item', () => {
      const item = createTestItem('item1', 'list1');
      aworset.add(item);
      aworset.remove('item1');
      
      const result = aworset.updateField('item1', 'name', 'Updated');
      expect(result).toBe(false);
    });

    it('should update lastUpdated and vectorClock', () => {
      const item = createTestItem('item1', 'list1');
      aworset.add(item);
      
      const originalLastUpdated = aworset.get('item1')?.lastUpdated;
      const originalVectorClock = { ...aworset.get('item1')?.vectorClock };
      
      jest.useFakeTimers();
      jest.advanceTimersByTime(1);
      
      aworset.updateField('item1', 'name', 'Updated Name');
      
      const updatedItem = aworset.get('item1')!;
      expect(updatedItem.lastUpdated).toBeGreaterThanOrEqual(originalLastUpdated!);
      expect(updatedItem.vectorClock['node1']).toBeGreaterThan(
        originalVectorClock['node1'] || 0
      );
      
      jest.useRealTimers();
    });
  });

  describe('get and getAll', () => {
    it('should return undefined for non-existent item', () => {
      expect(aworset.get('non-existent')).toBeUndefined();
    });

    it('should return undefined for locally removed item', () => {
      const item = createTestItem('item1', 'list1');
      aworset.add(item);
      aworset.remove('item1');
      
      expect(aworset.get('item1')).toBeUndefined();
    });

    it('should return all non-removed items', () => {
      const item1 = createTestItem('item1', 'list1');
      const item2 = createTestItem('item2', 'list1');
      const item3 = createTestItem('item3', 'list2');
      
      aworset.add(item1);
      aworset.add(item2);
      aworset.add(item3);
      aworset.remove('item2');
      
      const allItems = aworset.getAll();
      expect(allItems).toHaveLength(2);
      expect(allItems.map(i => i.id)).toEqual(['item1', 'item3']);
    });

    it('should filter items by list ID', () => {
      const item1 = createTestItem('item1', 'list1');
      const item2 = createTestItem('item2', 'list1');
      const item3 = createTestItem('item3', 'list2');
      
      aworset.add(item1);
      aworset.add(item2);
      aworset.add(item3);
      
      const list1Items = aworset.getByList('list1');
      expect(list1Items).toHaveLength(2);
      expect(list1Items.map(i => i.id)).toEqual(['item1', 'item2']);
      
      const list2Items = aworset.getByList('list2');
      expect(list2Items).toHaveLength(1);
      expect(list2Items[0].id).toBe('item3');
    });
  });

  describe('merge', () => {
    let aworset1: AWORSet;
    let aworset2: AWORSet;

    beforeEach(() => {
      aworset1 = new AWORSet('node1');
      aworset2 = new AWORSet('node2');
    });

    it('should merge add sets', () => {
      const item1 = createTestItem('item1', 'list1');
      const item2 = createTestItem('item2', 'list1');
      
      aworset1.add(item1);
      aworset2.add(item2);
      
      aworset1.merge(aworset2);
      
      expect(aworset1.get('item1')).toBeDefined();
      expect(aworset1.get('item2')).toBeDefined();
    });

    it('should handle add-wins semantics', () => {
      const item = createTestItem('item1', 'list1');
      
      // Both nodes add the same item
      aworset1.add(item);
      aworset2.add(item);
      
      // Node1 removes it locally
      aworset1.remove('item1');
      
      // Merge node2 into node1
      aworset1.merge(aworset2);
      
      // Add should win - item should exist
      expect(aworset1.get('item1')).toBeDefined();
    });

    it('should merge CRDT field updates', () => {
      const item = createTestItem('item1', 'list1');
      
      aworset1.add(item);
      aworset2.add(item);
      
      // Make different updates on each node
      aworset1.updateField('item1', 'name', 'Name from Node1');
      aworset2.updateField('item1', 'name', 'Name from Node2');
      
      // Merge in both directions
      aworset1.merge(aworset2);
      aworset2.merge(aworset1);
      
      // Both should converge to the same value (LWW)
      const name1 = aworset1.get('item1')?.name.getValue();
      const name2 = aworset2.get('item1')?.name.getValue();
      
      // Note: LWWRegister uses timestamps, so the last write should win
      // This test verifies they converge, not the specific value
      expect(name1).toBe(name2);
    });

    it('should merge PNCounter updates', () => {
      const item = createTestItem('item1', 'list1');
      
      aworset1.add(item);
      aworset2.add(item);
      
      // Both nodes increment quantity
      aworset1.updateField('item1', 'quantity', 3);
      aworset2.updateField('item1', 'quantity', 5);
      
      // Merge
      aworset1.merge(aworset2);
      
      // Quantity should be 5 (max of increments)
      expect(aworset1.get('item1')?.quantity.value()).toBe(5);
    });

    it('should clear local removals on merge', () => {
      const item = createTestItem('item1', 'list1');

      aworset1.add(item);
      aworset1.remove('item1');
      
      // Item should not be visible locally
      expect(aworset1.get('item1')).toBeUndefined();

      aworset2.add(item);

      aworset1.merge(aworset2);

      expect(aworset1.get('item1')).toBeDefined();
    });
  });

  describe('getState and setState', () => {
    it('should serialize and deserialize state correctly', () => {
      const item1 = createTestItem('item1', 'list1');
      const item2 = createTestItem('item2', 'list2');
      
      aworset.add(item1);
      aworset.add(item2);
      aworset.updateField('item1', 'name', 'Updated Name');
      aworset.updateField('item1', 'quantity', 5);
      aworset.remove('item2');
      
      const state = aworset.getState();

      const restoredSet = new AWORSet('node2');
      restoredSet.setState(state);

      expect(restoredSet.get('item1')).toBeDefined();
      expect(restoredSet.get('item1')?.name.getValue()).toBe('Updated Name');
      expect(restoredSet.get('item1')?.quantity.value()).toBe(5);
      
      const restoredState = restoredSet.getState();
      const sortStateEntries = (entries: any[]) => 
        entries.map(([k, v]: [string, any]) => [k, Array.isArray(v) ? v.sort() : v]);
      
      expect(sortStateEntries(restoredState.addSet)).toEqual(sortStateEntries(state.addSet));
      expect(sortStateEntries(restoredState.removeSet)).toEqual(sortStateEntries(state.removeSet));
    });
  });

  describe('edge cases', () => {
    it('should handle concurrent add and remove', () => {
      const item = createTestItem('item1', 'list1');
      
      // Simulate concurrent operations
      const set1 = new AWORSet('node1');
      const set2 = new AWORSet('node2');
      
      set1.add(item);
      set2.add(item);
      set1.remove('item1');
      
      // Merge in both directions
      set1.merge(set2);
      set2.merge(set1);
      
      // Both should have the same state
      const state1 = set1.getState();
      const state2 = set2.getState();
      
      // Sort arrays to ensure consistent comparison
      const normalizeState = (state: any) => ({
        ...state,
        addSet: state.addSet.map(([k, v]: [string, string[]]) => [k, v.sort()]),
        removeSet: state.removeSet.map(([k, v]: [string, string[]]) => [k, v.sort()])
      });
      
      expect(normalizeState(state1).addSet).toEqual(normalizeState(state2).addSet);
      expect(normalizeState(state1).removeSet).toEqual(normalizeState(state2).removeSet);
      
      // Item should exist (add-wins)
      expect(set1.get('item1')).toBeDefined();
      expect(set2.get('item1')).toBeDefined();
    });

    it('should handle multiple merges correctly', () => {
      const item = createTestItem('item1', 'list1');
      
      const sets = [
        new AWORSet('node1'),
        new AWORSet('node2'),
        new AWORSet('node3')
      ];
      
      // Each node makes different updates
      sets[0].add(item);
      sets[1].add(item);
      sets[2].add(item);
      
      sets[0].updateField('item1', 'name', 'Node1 Name');
      sets[1].updateField('item1', 'name', 'Node2 Name');
      sets[2].updateField('item1', 'name', 'Node3 Name');
      
      sets[0].updateField('item1', 'quantity', 2);
      sets[1].updateField('item1', 'quantity', 4);
      sets[2].updateField('item1', 'quantity', 6);
      
      // Merge in a star topology
      sets[0].merge(sets[1]);
      sets[0].merge(sets[2]);
      sets[1].merge(sets[0]);
      sets[2].merge(sets[0]);
      
      // All should converge to the same state
      const name0 = sets[0].get('item1')?.name.getValue();
      const name1 = sets[1].get('item1')?.name.getValue();
      const name2 = sets[2].get('item1')?.name.getValue();
      
      const quantity0 = sets[0].get('item1')?.quantity.value();
      const quantity1 = sets[1].get('item1')?.quantity.value();
      const quantity2 = sets[2].get('item1')?.quantity.value();
      
      expect(name0).toBe(name1);
      expect(name1).toBe(name2);
      
      expect(quantity0).toBe(quantity1);
      expect(quantity1).toBe(quantity2);
    });
  });
});

// Helper function to create test items
function createTestItem(id: string, listId: string): CRDTShoppingListItem {
  const now = Date.now();
  return {
    id,
    listId,
    name: new LWWRegister('Item ' + id, 'test-node'),
    quantity: new PNCounter('test-node'),
    acquired: new PNCounter('test-node'),
    createdAt: now,
    lastUpdated: now,
    vectorClock: {}
  };
}