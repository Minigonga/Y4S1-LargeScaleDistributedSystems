DROP TABLE IF EXISTS items;
DROP TABLE IF EXISTS lists;

CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_updated INTEGER NOT NULL,
    vector_clock TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    list_id TEXT NOT NULL,
    name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    acquired INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_updated INTEGER NOT NULL,
    vector_clock TEXT NOT NULL,
    FOREIGN KEY (list_id) REFERENCES lists (id) ON DELETE CASCADE
);

-- Indexes for better performance
CREATE INDEX IF NOT EXISTS idx_items_list_id ON items (list_id);
CREATE INDEX IF NOT EXISTS idx_items_name ON items (name);
CREATE INDEX IF NOT EXISTS idx_lists_name ON lists (name);