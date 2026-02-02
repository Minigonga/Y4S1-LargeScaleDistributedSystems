import sqlite3 from 'sqlite3';
import { ShoppingList, ShoppingListItem } from '../shared/types';
import { readFileSync } from 'fs';
import { join } from 'path';

/** 
 * SQLite-based persistence layer for shopping lists and items. 
 */
export class SQLiteStore {
  private db: sqlite3.Database;

  constructor(dbPath: string = '../database/shopping.db') {
    this.db = new sqlite3.Database(dbPath);
    this.initDatabase();
  }

  private initDatabase(): void {
    // Enforce referential integrity
    this.db.exec('PRAGMA foreign_keys = ON;');

    // Read schema from external file
    const schemaPath = join(__dirname, '../../database/schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    
    this.db.exec(schema, (err) => {
      if (err) {
        console.error('Error initializing database:', err);
      } else {
        console.log('Database initialized successfully');
      }
    });
  }

  async saveList(list: ShoppingList): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT OR REPLACE INTO lists (id, name, created_at, last_updated, vector_clock) 
         VALUES (?, ?, ?, ?, ?)`,
        [
          list.id,
          list.name,
          list.createdAt,
          list.lastUpdated,
          JSON.stringify(list.vectorClock)
        ],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async getList(listId: string): Promise<ShoppingList | null> {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM lists WHERE id = ?',
        [listId],
        (err, listRow: any) => {
          if (err) return reject(err);
          if (!listRow) return resolve(null);

          const list: ShoppingList = {
            id: listRow.id,
            name: listRow.name,
            createdAt: listRow.created_at,
            lastUpdated: listRow.last_updated,
            vectorClock: JSON.parse(listRow.vector_clock || '{}')
          };
          resolve(list);
        }
      );
    });
  }

  async deleteList(listId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run('DELETE FROM lists WHERE id = ?', [listId], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async saveItem(item: ShoppingListItem): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT OR REPLACE INTO items 
         (id, list_id, name, quantity, acquired, created_at, last_updated, vector_clock) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          item.listId,
          item.name,
          item.quantity,
          item.acquired,
          item.createdAt,
          item.lastUpdated,
          JSON.stringify(item.vectorClock)
        ],
        function(err) {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async getItem(itemId: string): Promise<ShoppingListItem | null> {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM items WHERE id = ?',
        [itemId],
        (err, row: any) => {
          if (err) return reject(err);
          if (!row) return resolve(null);

          const item: ShoppingListItem = {
            id: row.id,
            listId: row.list_id,
            name: row.name,
            quantity: row.quantity,
            acquired: row.acquired,
            createdAt: row.created_at,
            lastUpdated: row.last_updated,
            vectorClock: JSON.parse(row.vector_clock || '{}')
          };
          resolve(item);
        }
      );
    });
  }

  async getItemsByList(listId: string): Promise<ShoppingListItem[]> {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM items WHERE list_id = ? ORDER BY created_at DESC',
        [listId],
        (err, rows: any[]) => {
          if (err) return reject(err);

          const items: ShoppingListItem[] = rows.map(row => ({
            id: row.id,
            listId: row.list_id,
            name: row.name,
            quantity: row.quantity,
            acquired: row.acquired,
            createdAt: row.created_at,
            lastUpdated: row.last_updated,
            vectorClock: JSON.parse(row.vector_clock || '{}')
          }));
          resolve(items);
        }
      );
    });
  }

  async deleteItem(itemId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run('DELETE FROM items WHERE id = ?', [itemId], function(err) {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async getAllLists(): Promise<(ShoppingList & { items: ShoppingListItem[] })[]> {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM lists ORDER BY last_updated DESC',
        async (err, listRows: any[]) => {
          if (err) return reject(err);

          const listsWithItems = [];
          for (const listRow of listRows) {
            const items = await this.getItemsByList(listRow.id);
            
            listsWithItems.push({
              id: listRow.id,
              name: listRow.name,
              createdAt: listRow.created_at,
              lastUpdated: listRow.last_updated,
              vectorClock: JSON.parse(listRow.vector_clock || '{}'),
              items
            });
          }
          resolve(listsWithItems);
        }
      );
    });
  }

  async getAllItems(): Promise<ShoppingListItem[]> {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM items ORDER BY name',
        (err, rows: any[]) => {
          if (err) return reject(err);

          const items: ShoppingListItem[] = rows.map(row => ({
            id: row.id,
            listId: row.list_id,
            name: row.name,
            quantity: row.quantity,
            acquired: row.acquired,
            createdAt: row.created_at,
            lastUpdated: row.last_updated,
            vectorClock: JSON.parse(row.vector_clock || '{}')
          }));
          resolve(items);
        }
      );
    });
  }

  close(): void {
    this.db.close();
  }
}