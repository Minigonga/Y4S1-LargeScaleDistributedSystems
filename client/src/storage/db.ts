/**
 * IndexedDB wrapper providing offline-capable persistent storage.
 * Stores shopping lists, items, pending operations, and metadata.
 */

const DB_NAME = 'shopping-lists-db';
const DB_VERSION = 3;

export interface StoredList {
  id: string;
  name: string;
  createdAt: number;
  lastUpdated: number;
  vectorClock: { [nodeId: string]: number };
}

export interface StoredItem {
  id: string;
  listId: string;
  name: string;
  quantity: number;
  acquired: number;
  createdAt: number;
  lastUpdated: number;
  vectorClock: { [nodeId: string]: number };
}

export interface PendingOperation {
  id: string;
  type: 'CREATE_LIST' | 'DELETE_LIST' | 'ADD_ITEM' | 'UPDATE_ITEM' | 'REMOVE_ITEM' | 'TOGGLE_CHECK' | 'UPDATE_QUANTITY' | 'UPDATE_NAME';
  data: any;
  timestamp: number;
  synced: number; // 0 = not synced, 1 = synced
}

let dbInstance: IDBDatabase | null = null;

export async function openDatabase(): Promise<IDBDatabase> {
  if (dbInstance) return dbInstance;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('❌ Failed to open IndexedDB:', request.error);
      reject(request.error);
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      console.log('✅ IndexedDB opened successfully');
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      console.log('📦 Creating IndexedDB stores...');

      if (!db.objectStoreNames.contains('lists')) {
        const listsStore = db.createObjectStore('lists', { keyPath: 'id' });
        listsStore.createIndex('lastUpdated', 'lastUpdated', { unique: false });
      }

      if (!db.objectStoreNames.contains('items')) {
        const itemsStore = db.createObjectStore('items', { keyPath: 'id' });
        itemsStore.createIndex('listId', 'listId', { unique: false });
        itemsStore.createIndex('lastUpdated', 'lastUpdated', { unique: false });
      }

      if (!db.objectStoreNames.contains('pendingOperations')) {
        const pendingStore = db.createObjectStore('pendingOperations', { keyPath: 'id' });
        pendingStore.createIndex('timestamp', 'timestamp', { unique: false });
        pendingStore.createIndex('synced', 'synced', { unique: false });
      }

      if (!db.objectStoreNames.contains('metadata')) {
        db.createObjectStore('metadata', { keyPath: 'key' });
      }
    };
  });
}

/**
 * Returns the client's unique node ID, creating one if it doesn't exist.
 * Used to identify this client in vector clocks and CRDT operations.
 */
export async function getNodeId(): Promise<string> {
  const db = await openDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['metadata'], 'readwrite');
    const store = transaction.objectStore('metadata');
    const request = store.get('nodeId');

    request.onsuccess = () => {
      if (request.result) {
        resolve(request.result.value);
      } else {
        const newNodeId = `client-${crypto.randomUUID()}`;
        store.put({ key: 'nodeId', value: newNodeId });
        console.log('🆔 Generated new client nodeId:', newNodeId);
        resolve(newNodeId);
      }
    };

    request.onerror = () => reject(request.error);
  });
}

// ==================== LISTS ====================

export async function saveList(list: StoredList): Promise<void> {
  const db = await openDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['lists'], 'readwrite');
    const store = transaction.objectStore('lists');
    const request = store.put(list);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getList(listId: string): Promise<StoredList | null> {
  const db = await openDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['lists'], 'readonly');
    const store = transaction.objectStore('lists');
    const request = store.get(listId);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllLists(): Promise<StoredList[]> {
  const db = await openDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['lists'], 'readonly');
    const store = transaction.objectStore('lists');
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteList(listId: string): Promise<void> {
  const db = await openDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['lists', 'items'], 'readwrite');
    
    const listsStore = transaction.objectStore('lists');
    listsStore.delete(listId);

    // Also delete all items belonging to this list
    const itemsStore = transaction.objectStore('items');
    const index = itemsStore.index('listId');
    const request = index.openCursor(IDBKeyRange.only(listId));

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

// ==================== ITEMS ====================

export async function saveItem(item: StoredItem): Promise<void> {
  const db = await openDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['items'], 'readwrite');
    const store = transaction.objectStore('items');
    const request = store.put(item);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getItem(itemId: string): Promise<StoredItem | null> {
  const db = await openDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['items'], 'readonly');
    const store = transaction.objectStore('items');
    const request = store.get(itemId);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function getItemsByList(listId: string): Promise<StoredItem[]> {
  const db = await openDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['items'], 'readonly');
    const store = transaction.objectStore('items');
    const index = store.index('listId');
    const request = index.getAll(IDBKeyRange.only(listId));

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteItem(itemId: string): Promise<void> {
  const db = await openDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['items'], 'readwrite');
    const store = transaction.objectStore('items');
    const request = store.delete(itemId);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// ==================== PENDING OPERATIONS ====================

export async function getAllItems(): Promise<StoredItem[]> {
  const db = await openDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['items'], 'readonly');
    const store = transaction.objectStore('items');
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Queues an operation for sync when the server becomes available.
 * Operations are processed in timestamp order during sync.
 */
export async function addPendingOperation(operation: Omit<PendingOperation, 'id' | 'synced'>): Promise<void> {
  const db = await openDatabase();
  
  const fullOperation: PendingOperation = {
    ...operation,
    id: crypto.randomUUID(),
    synced: 0,
  };

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['pendingOperations'], 'readwrite');
    const store = transaction.objectStore('pendingOperations');
    const request = store.add(fullOperation);

    request.onsuccess = () => {
      console.log('📝 Added pending operation:', operation.type);
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getPendingOperations(): Promise<PendingOperation[]> {
  const db = await openDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['pendingOperations'], 'readonly');
    const store = transaction.objectStore('pendingOperations');
    const index = store.index('synced');
    const request = index.getAll(IDBKeyRange.only(0));

    request.onsuccess = () => {
      const operations = request.result || [];
      operations.sort((a, b) => a.timestamp - b.timestamp);
      resolve(operations);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function markOperationSynced(operationId: string): Promise<void> {
  const db = await openDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['pendingOperations'], 'readwrite');
    const store = transaction.objectStore('pendingOperations');
    const request = store.get(operationId);

    request.onsuccess = () => {
      if (request.result) {
        const operation = request.result;
        operation.synced = 1;
        store.put(operation);
      }
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

export async function clearSyncedOperations(): Promise<void> {
  const db = await openDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['pendingOperations'], 'readwrite');
    const store = transaction.objectStore('pendingOperations');
    const index = store.index('synced');
    const request = index.openCursor(IDBKeyRange.only(1));

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };

    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

// ==================== METADATA ====================

export async function setLastSyncTime(timestamp: number): Promise<void> {
  const db = await openDatabase();
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['metadata'], 'readwrite');
    const store = transaction.objectStore('metadata');
    const request = store.put({ key: 'lastSync', value: timestamp });

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
