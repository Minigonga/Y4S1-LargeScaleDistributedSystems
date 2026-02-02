DELETE FROM items;
DELETE FROM lists;

-- Insert shopping lists
INSERT INTO lists (id, name, created_at, last_updated, vector_clock) VALUES 
('list-weekly', 'Weekly Groceries', 1700000000000, 1700000000000, '{}'),
('list-party', 'Party Shopping', 1700000001000, 1700000001000, '{}'),
('list-hardware', 'Hardware Store', 1700000002000, 1700000002000, '{}'),
('list-empty', 'Empty List', 1700000003000, 1700000003000, '{}');

-- Insert items (each item belongs to a specific list)
INSERT INTO items (id, list_id, name, description, category, quantity, acquired, checked, notes, created_at, last_updated, vector_clock) VALUES 
-- Weekly Groceries items
('item-apple-weekly', 'list-weekly', 'Apple', 'Fresh red apples', 'Fruits', 5, 5, 1, 'Get the organic ones', 1700000000000, 1700000000000, '{}'),
('item-milk-weekly', 'list-weekly', 'Milk', 'Whole milk 1L', 'Dairy', 2, 0, 0, '2% fat preferred', 1700000000000, 1700000000000, '{}'),
('item-bread-weekly', 'list-weekly', 'Bread', 'Whole wheat bread', 'Bakery', 1, 1, 1, 'Fresh from bakery', 1700000000000, 1700000000000, '{}'),
('item-eggs-weekly', 'list-weekly', 'Eggs', 'Free-range eggs', 'Dairy', 12, 0, 0, 'Large size', 1700000000000, 1700000000000, '{}'),
('item-cheese-weekly', 'list-weekly', 'Cheese', 'Cheddar cheese', 'Dairy', 1, 0, 0, 'Sharp cheddar', 1700000000000, 1700000000000, '{}'),

-- Party Shopping items
('item-chips-party', 'list-party', 'Potato Chips', 'Salt and vinegar flavor', 'Snacks', 3, 0, 0, 'Get different flavors', 1700000001000, 1700000001000, '{}'),
('item-soda-party', 'list-party', 'Soda', 'Cola 2L', 'Beverages', 6, 0, 0, 'Mix of cola and orange', 1700000001000, 1700000001000, '{}'),
('item-milk-party', 'list-party', 'Milk', 'Whole milk 1L', 'Dairy', 1, 0, 0, 'For coffee', 1700000001000, 1700000001000, '{}'),
('item-dip-party', 'list-party', 'Dip', 'French onion dip', 'Snacks', 2, 0, 0, NULL, 1700000001000, 1700000001000, '{}'),

-- Hardware Store items
('item-paint-hardware', 'list-hardware', 'White Paint', 'Interior wall paint', 'Hardware', 2, 0, 0, 'Matte finish', 1700000002000, 1700000002000, '{}'),
('item-brush-hardware', 'list-hardware', 'Paint Brush', '4-inch brush', 'Tools', 3, 0, 0, 'Synthetic bristles', 1700000002000, 1700000002000, '{}'),
('item-tape-hardware', 'list-hardware', 'Painter''s Tape', '2-inch masking tape', 'Tools', 1, 0, 0, 'Blue tape', 1700000002000, 1700000002000, '{}');