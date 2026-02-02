import { ShoppingListItem } from '../shared/types';
import { CRDTShoppingListItem } from './CRDTShoppingListItem';
import { LWWRegister } from './LWWRegister';
import { PNCounter } from './PNCounter';

/** 
 * Converts a plain database item to its CRDT representation. 
 */
export function dbToCRDT(item: ShoppingListItem, nodeId: string): CRDTShoppingListItem {
  const vectorClock = typeof item.vectorClock === 'string'
    ? JSON.parse(item.vectorClock)
    : item.vectorClock || {};
  return {
    id: item.id,
    listId: item.listId,
    name: new LWWRegister(item.name, nodeId),
    quantity: new PNCounter(nodeId, item.quantity),
    acquired: new PNCounter(nodeId, item.acquired),
    createdAt: item.createdAt,
    lastUpdated: item.lastUpdated,
    vectorClock: vectorClock,
  };
}

/** 
 * Converts a CRDT item to its plain database representation for storage. 
 */
export function crdtToDB(item: CRDTShoppingListItem): ShoppingListItem {
  return {
    id: item.id,
    listId: item.listId,
    name: item.name.getValue(),
    quantity: item.quantity.value(),
    acquired: item.acquired.value(),
    createdAt: item.createdAt,
    lastUpdated: item.lastUpdated,
    vectorClock: item.vectorClock || {},
  };
}