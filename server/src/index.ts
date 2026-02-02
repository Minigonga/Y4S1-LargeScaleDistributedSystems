import { ShoppingListServer } from './api/server';

// Start the server
async function main() {
  const server = new ShoppingListServer(3000);
  await server.start(); 
}

main().catch(console.error);