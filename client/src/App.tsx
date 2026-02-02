import React, { useState, useCallback, useEffect } from 'react';
import { syncService } from './storage/SyncService';
import { sseService } from './storage/SSEService';
import type { SyncStatus, ShoppingList } from './storage/SyncService';

const exportAsJSON = (list: ShoppingList) => {
  const exportData = {
    list: {
      id: list.id,
      name: list.name,
      createdAt: new Date(list.createdAt).toISOString(),
      lastUpdated: new Date(list.lastUpdated).toISOString(),
      items: list.items.map(item => ({
        id: item.id,
        name: item.name,
        quantity: item.quantity,
        acquired: item.acquired,
        checked: item.quantity > 0 && item.acquired >= item.quantity,
      })),
    },
    exportedAt: new Date().toISOString(),
    version: '1.0',
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `${sanitizeFilename(list.name)}.json`);
};

const exportAsTXT = (list: ShoppingList) => {
  const lines: string[] = [];
  
  lines.push(`📋 ${list.name}`);
  lines.push('='.repeat(list.name.length + 3));
  lines.push('');

  if (list.items.length === 0) {
    lines.push('(No items)');
  } else {
    const unchecked = list.items.filter(i => i.acquired < i.quantity);
    const checked = list.items.filter(i => i.quantity > 0 && i.acquired >= i.quantity);

    if (unchecked.length > 0) {
      lines.push('📝 To Get:');
      unchecked.forEach(item => {
        const qty = item.quantity > 1 ? ` (×${item.quantity})` : '';
        lines.push(`  [ ] ${item.name}${qty}`);
      });
      lines.push('');
    }

    if (checked.length > 0) {
      lines.push('✅ Got:');
      checked.forEach(item => {
        const qty = item.quantity > 1 ? ` (×${item.quantity})` : '';
        lines.push(`  [✓] ${item.name}${qty}`);
      });
      lines.push('');
    }
  }

  lines.push('—'.repeat(30));
  lines.push(`Exported: ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`);
  lines.push(`List ID: ${list.id}`);

  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  downloadBlob(blob, `${sanitizeFilename(list.name)}.txt`);
};

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const sanitizeFilename = (name: string): string => {
  return name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
};

const SyncStatusBadge: React.FC<{ status: SyncStatus; pendingCount: number }> = ({ status, pendingCount }) => {
  const statusConfig = {
    synced: { color: 'bg-green-500', text: '✓ Synced', pulse: false },
    syncing: { color: 'bg-blue-500', text: '↻ Syncing...', pulse: true },
    queue: { color: 'bg-blue-500', text: 'Queue', pulse: false },
    error: { color: 'bg-red-500', text: '✗ Sync Error', pulse: false },
  };

  const config = statusConfig[status];

  return (
    <div className="flex items-center gap-2">
      <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-white text-sm ${config.color} ${config.pulse ? 'animate-pulse' : ''}`}>
        <span>{config.text}</span>
        {pendingCount > 0 && (
          <span className="bg-white text-gray-800 px-2 py-0.5 rounded-full text-xs font-bold">
            {pendingCount}
          </span>
        )}
      </div>
      {status === 'queue' && (
        <span className="text-xs text-gray-500">
          Saved locally
        </span>
      )}
    </div>
  );
};

const App: React.FC = () => {
  const [currentList, setCurrentList] = useState<ShoppingList | null>(null);
  const [listName, setListName] = useState('');
  const [listIdInput, setListIdInput] = useState('');
  const [itemName, setItemName] = useState('');
  const [copySuccess, setCopySuccess] = useState(false);
  const [itemQuantity, setItemQuantity] = useState(1);
  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('synced');
  const [pendingCount, setPendingCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [sseConnected, setSSEConnected] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingItemName, setEditingItemName] = useState('');

  const loadAllLists = useCallback(async () => {
    try {
      const localLists = await syncService.getAllLists();
      localLists.sort((a, b) => b.createdAt - a.createdAt);
      setLists(localLists);
    } catch (error) {
      console.error('Error loading lists:', error);
    }
  }, []);

  // Load list from server (for loading shared lists by ID)
  const loadListById = useCallback(async (id: string) => {
    if (!id) return;
    try {
      const list = await syncService.loadListById(id);
      if (!list) {
        alert('List not found');
        return;
      }
      setCurrentList(list);
      setListIdInput(''); // Clear input after successful load
      await loadAllLists(); // Refresh list view
    } catch (error) {
      console.error('Error loading list:', error);
      alert(`Failed to load list: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }, [loadAllLists]);

  // Select list from sidebar (local lookup only)
  const selectList = useCallback(async (id: string) => {
    if (!id) return;
    try {
      const list = await syncService.getList(id);
      if (list) {
        setCurrentList(list);
      }
    } catch (error) {
      console.error('Error selecting list:', error);
    }
  }, []);

  const createList = async () => {
    if (!listName) return alert('Enter a list name');
    try {
      const list = await syncService.createList(listName);
      setListName('');
      setCurrentList(list);
      await loadAllLists();
    } catch (error) {
      console.error('Error creating list:', error);
    }
  };

  const addItem = async () => {
    if (!currentList) return;
    if (!itemName) return alert('Enter item name');
    try {
      await syncService.addItem(currentList.id, { name: itemName, quantity: itemQuantity });
      setItemName('');
      setItemQuantity(1);

      const updatedList = await syncService.getList(currentList.id);
      if (updatedList) setCurrentList(updatedList);
      await loadAllLists();
    } catch (error) {
      console.error('Error adding item:', error);
    }
  };

  const toggleItem = async (itemId: string) => {
    if (!currentList) return;
    try {
      await syncService.toggleItem(itemId);
      const updatedList = await syncService.getList(currentList.id);
      if (updatedList) setCurrentList(updatedList);
    } catch (error) {
      console.error('Error toggling item:', error);
    }
  };

  const updateQuantity = async (itemId: string, newQuantity: number) => {
    if (!currentList) return;
    if (newQuantity < 1) return;
    try {
      const item = currentList.items.find(i => i.id === itemId);
      if (!item) return;
      const newAcquired = Math.min(item.acquired || 0, newQuantity);

      await syncService.updateQuantity(itemId, newQuantity, newAcquired);

      const updatedList = await syncService.getList(currentList.id);
      if (updatedList) setCurrentList(updatedList);
    } catch (error) {
      console.error('Error updating quantity:', error);
    }
  };

  const updateAcquired = async (itemId: string, newAcquired: number) => {
    if (!currentList) return;
    try {
      const item = currentList.items.find(i => i.id === itemId);
      if (!item) return;
      const cappedAcquired = Math.max(0, Math.min(newAcquired, item.quantity));
      
      await syncService.updateQuantity(itemId, item.quantity, cappedAcquired);
      
      const updatedList = await syncService.getList(currentList.id);
      if (updatedList) setCurrentList(updatedList);
    } catch (error) {
      console.error('Error updating acquired:', error);
    }
  };

  const removeItem = async (itemId: string) => {
    if (!currentList) return;
    try {
      await syncService.removeItem(itemId);
      const updatedList = await syncService.getList(currentList.id);
      if (updatedList) setCurrentList(updatedList);
      await loadAllLists();
    } catch (error) {
      console.error('Error removing item:', error);
    }
  };

  const startEditingItem = (itemId: string, currentName: string) => {
    setEditingItemId(itemId);
    setEditingItemName(currentName);
  };

  const cancelEditingItem = () => {
    setEditingItemId(null);
    setEditingItemName('');
  };

  const saveItemName = async () => {
    if (!editingItemId || !editingItemName.trim()) return;
    try {
      await syncService.updateItemName(editingItemId, editingItemName.trim());
      const updatedList = await syncService.getList(currentList!.id);
      if (updatedList) setCurrentList(updatedList);
      cancelEditingItem();
    } catch (error) {
      console.error('Error updating item name:', error);
    }
  };

  const deleteList = async (listId: string) => {
    if (!confirm('Are you sure you want to delete this list?')) return;
    try {
      await syncService.deleteList(listId);
      if (currentList?.id === listId) {
        setCurrentList(null);
      }
      await loadAllLists();
    } catch (error) {
      console.error('Error deleting list:', error);
    }
  };

  const manualSync = async () => {
    await syncService.syncWithServer();
    
    if (!syncService.getIsOnline()) {
      alert('Server is not available. Changes will sync when it reconnects.');
    }
  };

  // Initialize: load from local storage, then try to sync
  useEffect(() => {
    const init = async () => {
      setIsLoading(true);
      await loadAllLists();
      setIsLoading(false);
    };

    init();

    // Subscribe to sync status changes
    const statusListener = (status: SyncStatus, pending: number) => {
      setSyncStatus(status);
      setPendingCount(pending);
    };

    // Subscribe to data changes (from SSE updates)
    const dataChangeListener = async () => {
      await loadAllLists();
      // If viewing a list, refresh it
      if (currentList) {
        const updated = await syncService.getList(currentList.id);
        if (updated) setCurrentList(updated);
      }
    };

    syncService.addStatusListener(statusListener);
    syncService.addDataChangeListener(dataChangeListener);

    return () => {
      syncService.removeStatusListener(statusListener);
      syncService.removeDataChangeListener(dataChangeListener);
    };
  }, [loadAllLists, currentList?.id]);

  // Monitor SSE connection status
  useEffect(() => {
    const checkSSEStatus = setInterval(() => {
      const isConnected = sseService.isConnected();
      setSSEConnected(isConnected);
    }, 1000); // Check every second

    return () => clearInterval(checkSSEStatus);
  }, []);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-100">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading your shopping lists...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col md:flex-row h-screen overflow-hidden">

      {/* LEFT SIDEBAR — responsive: full width on mobile, 1/4 on desktop */}
      <div className={`${currentList ? 'hidden md:flex' : 'flex'} md:w-80 lg:w-96 w-full bg-gray-100 border-r p-4 flex-col shrink-0 md:max-h-screen overflow-y-auto`}>

        {/* Header with sync status */}
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold text-indigo-700">🛒 Lists</h1>
        </div>

        {/* Sync Status Badge */}
        <div className="mb-4">
          <SyncStatusBadge status={syncStatus} pendingCount={pendingCount} />
        </div>

        {/* SSE Connection Status */}
        <div className="mb-4 text-xs">
          {sseConnected ? (
            <div className="flex items-center gap-2 text-green-600">
              <span className="inline-block w-2 h-2 bg-green-600 rounded-full animate-pulse"></span>
              Real-time updates connected
            </div>
          ) : (
            <div className="flex items-center gap-2 text-gray-500">
              <span className="inline-block w-2 h-2 bg-gray-400 rounded-full"></span>
              Real-time updates not available
            </div>
          )}
        </div>

        {/* Manual Sync Button */}
        <button
          onClick={manualSync}
          disabled={syncStatus === 'syncing'}
          className="mb-4 w-full bg-gray-200 hover:bg-gray-300 disabled:bg-gray-100 disabled:cursor-not-allowed text-gray-700 py-2 rounded-md text-sm flex items-center justify-center gap-2"
        >
          <span className={syncStatus === 'syncing' ? 'animate-spin' : ''}>↻</span>
          {syncStatus === 'syncing' ? 'Syncing...' : 'Sync Now'}
        </button>

        {/* Create List */}
        <div className="mb-6">
          <h2 className="text-lg font-semibold mb-2 text-indigo-600">Create List</h2>
          <input
            type="text"
            placeholder="List name"
            value={listName}
            onChange={(e) => setListName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createList()}
            className="w-full p-2 mb-2 border rounded-md"
          />
          <button
            onClick={createList}
            className="w-full bg-indigo-500 hover:bg-indigo-600 text-white py-2 rounded-md"
          >
            Create
          </button>
        </div>

        {/* Load List by ID */}
        <div className="mb-6">
          <h2 className="text-lg font-semibold mb-2 text-indigo-600">Load List by ID</h2>
          <input
            type="text"
            placeholder="List ID"
            value={listIdInput}
            onChange={(e) => setListIdInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loadListById(listIdInput)}
            className="w-full p-2 mb-2 border rounded-md"
          />
          <button
            onClick={() => loadListById(listIdInput)}
            className="w-full bg-green-500 hover:bg-green-600 text-white py-2 rounded-md"
          >
            Load
          </button>
        </div>

        {/* LIST CARDS — SCROLLING SECTION */}
        <h2 className="text-md font-semibold mb-3 text-gray-700">Your Lists ({lists.length})</h2>

        <div className="flex-1 overflow-y-auto pr-2 space-y-2">
          {lists.length === 0 && (
            <p className="text-gray-400 text-sm text-center py-4">
              No lists yet. Create one above!
            </p>
          )}
          {lists.map((list) => (
            <div
              key={list.id}
              className={`cursor-pointer border shadow-sm hover:shadow-md rounded-lg p-3 transition ${
                currentList?.id === list.id 
                  ? 'bg-indigo-50 border-indigo-400' 
                  : 'bg-white hover:border-indigo-400'
              }`}
              onClick={() => selectList(list.id)}
            >
              <div className="flex justify-between items-start">
                <div className="flex-1 min-w-0">
                  <h3 className="text-md font-semibold text-indigo-600 truncate">{list.name}</h3>
                  <p className="text-xs text-gray-500">Items: {list.items?.length || 0}</p>
                  <p className="text-xs text-gray-400 truncate">ID: {list.id.slice(0, 8)}...</p>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteList(list.id);
                  }}
                  className="text-red-400 hover:text-red-600 text-xs p-1"
                  title="Delete list"
                >
                  🗑️
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Bottom Offline Indicator*/}
        {!sseConnected && (
          <div className="mt-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-center">
            <p className="text-sm text-yellow-800">
              You're offline
            </p>
            <p className="text-xs text-yellow-600 mt-1">
              Your changes are saved locally and will sync when you reconnect.
            </p>
          </div>
        )}
      </div>

      {/* RIGHT CONTENT — responsive: full width on mobile when list selected */}
      <div className={`${!currentList ? 'hidden md:flex' : 'flex'} flex-1 flex-col p-4 md:p-6 overflow-y-auto min-w-0`}>

        {!currentList && (
          <div className="text-gray-400 text-center mt-40 text-xl">
            Select or create a shopping list from the left.
          </div>
        )}

        {currentList && (
          <div className="bg-white shadow-lg rounded-lg p-4 md:p-6 border border-indigo-300">
            {/* Mobile back button */}
            <button
              onClick={() => setCurrentList(null)}
              className="md:hidden mb-4 text-indigo-600 hover:text-indigo-800 text-sm flex items-center gap-1"
            >
              ← Back to lists
            </button>

            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 min-w-0 flex-1">
                <h2 className="text-xl md:text-2xl font-semibold text-indigo-600 truncate">
                  {currentList.name}
                </h2>
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-xs sm:text-sm text-gray-500 truncate">
                    ID: <code className="bg-gray-100 p-1 rounded text-xs">{currentList.id.slice(0, 8)}...</code>
                  </p>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(currentList.id);
                      setCopySuccess(true);
                      setTimeout(() => setCopySuccess(false), 2000);
                    }}
                    className="text-indigo-500 hover:text-indigo-700 text-xs p-1 rounded hover:bg-indigo-50 whitespace-nowrap"
                    title="Copy ID"
                  >
                    {copySuccess ? '✓ Copied!' : '📋 Copy'}
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {/* Export Dropdown */}
                <div className="relative group">
                  <button
                    className="bg-indigo-500 hover:bg-indigo-600 text-white px-3 py-1.5 md:px-4 md:py-2 rounded-md text-sm flex items-center gap-1"
                  >
                    Export ▾
                  </button>
                  <div className="absolute right-0 mt-1 w-40 bg-white border border-gray-200 rounded-md shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-150 z-10">
                    <button
                      onClick={() => exportAsJSON(currentList)}
                      className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-t-md"
                    >
                      📄 Export as JSON
                    </button>
                    <button
                      onClick={() => exportAsTXT(currentList)}
                      className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 rounded-b-md"
                    >
                      📝 Export as TXT
                    </button>
                  </div>
                </div>

                <button
                  onClick={() => setCurrentList(null)}
                  className="hidden md:block bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 md:px-4 md:py-2 rounded-md text-sm"
                >
                  ← Close
                </button>
              </div>
            </div>

            {/* Show warning if list was deleted */}
            {lists.find(l => l.id === currentList.id) === undefined && (
              <div className="bg-red-50 border border-red-300 rounded-md p-4 mb-4">
                <p className="text-red-700 font-semibold">⚠️ This list has been deleted</p>
                <p className="text-red-600 text-sm mt-1">
                  The list was deleted by another user. You can view it but cannot make changes.
                </p>
              </div>
            )}

            {/* Add Item */}
            <div className="flex flex-col sm:flex-row gap-2 mb-6 p-4 bg-indigo-50 rounded-md">
              <input
                type="text"
                placeholder="Item name"
                value={itemName}
                onChange={(e) => setItemName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addItem()}
                className="flex-1 p-2 border border-gray-300 rounded-md min-w-0"
              />
              <div className="flex gap-2">
                <input
                  type="number"
                  min="1"
                  value={itemQuantity}
                  onChange={(e) => setItemQuantity(Number(e.target.value))}
                  className="w-20 p-2 border border-gray-300 rounded-md text-center"
                />
                <button
                  onClick={addItem}
                  className="bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded-md whitespace-nowrap"
                >
                  Add
                </button>
              </div>
            </div>

            {/* Items */}
            {currentList.items.length === 0 && (
              <p className="text-gray-400 text-center py-8">
                No items yet. Add some above!
              </p>
            )}

            <ul className="space-y-3">
              {currentList.items.map((item) => {
                const isChecked = item.quantity > 0 && (item.acquired || 0) >= item.quantity;
                return (
                <li
                  key={item.id}
                  className={`flex flex-col sm:flex-row sm:items-center gap-3 p-3 border rounded-md ${
                    isChecked
                      ? 'bg-green-50 border-green-200'
                      : 'bg-white hover:bg-gray-50'
                  }`}
                >
                  {/* Top row: checkbox + name */}
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleItem(item.id)}
                      disabled={lists.find(l => l.id === currentList.id) === undefined}
                      className="w-5 h-5 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 shrink-0"
                    />
                    {editingItemId === item.id ? (
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <input
                          type="text"
                          value={editingItemName}
                          onChange={(e) => setEditingItemName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveItemName();
                            if (e.key === 'Escape') cancelEditingItem();
                          }}
                          autoFocus
                          className="flex-1 px-2 py-1 border border-indigo-300 rounded text-sm min-w-0"
                        />
                        <button
                          onClick={saveItemName}
                          className="bg-green-500 hover:bg-green-600 text-white text-xs py-1 px-2 rounded shrink-0"
                        >
                          ✓
                        </button>
                        <button
                          onClick={cancelEditingItem}
                          className="bg-gray-400 hover:bg-gray-500 text-white text-xs py-1 px-2 rounded shrink-0"
                        >
                          ✗
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className={`flex-1 truncate ${isChecked ? 'line-through text-gray-500' : ''}`}>
                          {item.name}
                        </span>
                        <button
                          onClick={() => startEditingItem(item.id, item.name)}
                          disabled={lists.find(l => l.id === currentList.id) === undefined}
                          className="text-indigo-500 hover:text-indigo-700 text-xs py-1 px-2 rounded hover:bg-indigo-50 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                          title="Edit name"
                        >
                          ✏️
                        </button>
                      </>
                    )}
                    {/* Delete button - visible on mobile in top row */}
                    <button
                      onClick={() => removeItem(item.id)}
                      disabled={lists.find(l => l.id === currentList.id) === undefined}
                      className="sm:hidden bg-red-500 hover:bg-red-600 text-white text-xs py-1 px-3 rounded-full disabled:bg-gray-400 disabled:cursor-not-allowed shrink-0"
                    >
                      🗑️
                    </button>
                  </div>

                  {/* Bottom row: quantity controls */}
                  <div className="flex items-center gap-3 flex-wrap pl-8 sm:pl-0">
                    <div className="flex items-center gap-1">
                      <span className="text-gray-500 text-xs sm:text-sm">Qty:</span>
                      <input
                        key={`qty-${item.id}-${item.quantity}`}
                        type="number"
                        min="1"
                        defaultValue={item.quantity}
                        onBlur={(e) => {
                          let val = Number(e.target.value);
                          if (val < 1 || isNaN(val)) {
                            val = 1;
                            e.target.value = '1';
                          }
                          if (val !== item.quantity) updateQuantity(item.id, val);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.currentTarget.blur();
                          }
                        }}
                        disabled={lists.find(l => l.id === currentList.id) === undefined}
                        className="w-14 px-2 py-1 text-sm border border-gray-300 rounded disabled:bg-gray-100 disabled:cursor-not-allowed"
                      />
                    </div>

                    <div className="flex items-center gap-1">
                      <span className="text-gray-500 text-xs sm:text-sm">Acq:</span>
                      <input
                        key={`acq-${item.id}-${item.acquired}`}
                        type="number"
                        min="0"
                        max={item.quantity}
                        defaultValue={item.acquired || 0}
                        onBlur={(e) => {
                          let val = Number(e.target.value);
                          if (val < 0 || isNaN(val)) {
                            val = 0;
                            e.target.value = '0';
                          }
                          if (val !== item.acquired) updateAcquired(item.id, val);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.currentTarget.blur();
                          }
                        }}
                        disabled={lists.find(l => l.id === currentList.id) === undefined}
                        className="w-14 px-2 py-1 text-sm border border-gray-300 rounded disabled:bg-gray-100 disabled:cursor-not-allowed"
                      />
                    </div>

                    {/* Delete Button - hidden on mobile, shown on desktop */}
                    <button
                      onClick={() => removeItem(item.id)}
                      disabled={lists.find(l => l.id === currentList.id) === undefined}
                      className="hidden sm:block bg-red-500 hover:bg-red-600 text-white text-xs py-1 px-3 rounded-full disabled:bg-gray-400 disabled:cursor-not-allowed shrink-0"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              )
            }
          )
        }
      </ul>
    </div>
      )
    }
    </div>
  </div>
  );
};

export default App;