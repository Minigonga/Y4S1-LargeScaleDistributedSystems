export interface ShoppingListItem {
  id: string;
  listId: string;
  name: string;
  quantity: number;
  acquired: number;
  createdAt: number;
  lastUpdated: number;
  vectorClock: { [nodeId: string]: number };
}

export interface ShoppingList {
  id: string;
  name: string;
  createdAt: number;
  lastUpdated: number;
  vectorClock: { [nodeId: string]: number };
}

export interface Operation {
  type: 'CREATE_LIST' | 'DELETE_LIST' | 'ADD_ITEM' | 'UPDATE_ITEM' | 'REMOVE_ITEM' | 'TOGGLE_CHECK' | 'UPDATE_QUANTITY';
  listId: string;
  itemId?: string;
  data?: Partial<ShoppingList> | Partial<ShoppingListItem>;
  timestamp: number;
  nodeId: string;
  vectorClock: { [nodeId: string]: number };
}

export interface SyncMessage {
  nodeId: string;
  operations: Operation[];
  vectorClock: { [nodeId: string]: number };
}