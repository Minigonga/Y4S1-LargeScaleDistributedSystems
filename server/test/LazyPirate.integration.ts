import fetch from 'node-fetch';
import { ShoppingListCloud } from '../src/api/cloud';

interface ListData {
  id: string;
  name: string;
  createdAt: number;
  lastUpdated: number;
  vectorClock: Record<string, number>;
  items?: any[];
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('Starting cloud for Lazy Pirate test...');
  const cloud = new ShoppingListCloud();
  await cloud.startCloud();

  console.log('\n=== PHASE 1: Simulate Node Failure ===');
  
  // Stop Node 5002 to simulate failure
  const node5002 = cloud['nodes'].find(n => n.port === 5002);
  if (!node5002) throw new Error('Node 5002 not found');
  await node5002.server.stop();
  console.log('✅ Node 5002 stopped.');

  // Send an update to the cloud
  console.log('\n=== PHASE 2: Create List While Node is Down ===');
  const response = await fetch('http://localhost:5000/api/lists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'LazyPirateTestTS' })
  });

  const data = await response.json() as ListData;
  console.log('✅ List created:', data.id);

  // Wait a bit for propagation attempts
  await sleep(2000);

  // Check that Node 5002 doesn't have the list
  console.log('\n=== PHASE 3: Verify Node 5002 Missed the Update ===');
  try {
    const checkResponse = await fetch(`http://localhost:5002/api/lists/${data.id}`);
    if (checkResponse.status === 404) {
      console.log('✅ Node 5002 does not have the list (expected)');
    }
  } catch (err) {
    console.log('✅ Node 5002 is unreachable (expected)');
  }

  // Restart Node 5002
  console.log('\n=== PHASE 4: Restart Node 5002 ===');
  await node5002.server.start();
  
  // Reinitialize its messaging (reconnect to ZeroMQ)
  const node5002Index = cloud['nodes'].findIndex(n => n.port === 5002);
  const neighborPorts: number[] = [];
  const total = cloud['nodes'].length;
  const n = 2; // neighbors from cloudConfig
  
  for (let j = 1; j <= n; j++) {
    const httpPort1 = cloud['nodes'][(node5002Index + j) % total].port;
    const httpPort2 = cloud['nodes'][(node5002Index - j + total) % total].port;
    neighborPorts.push(httpPort1 + 1000);
    neighborPorts.push(httpPort2 + 1000);
  }
  
  await node5002.server.initMessaging(6002, neighborPorts);
  console.log('✅ Node 5002 restarted and reconnected');

  // Wait for reconnection
  await sleep(1000);

  // Flush hints (other nodes try to deliver queued updates)
  console.log('\n=== PHASE 5: Flush Hinted Handoff Queue ===');
  for (const node of cloud['nodes']) {
    if (node.port !== 5002) {
      await node.server.flushHints();
    }
  }
  console.log('✅ Hints flushed');

  // Wait for propagation
  await sleep(1000);

  // Verify Node 5002 now has the list
  console.log('\n=== PHASE 6: Verify Node 5002 Received the Update ===');
  try {
    const verifyResponse = await fetch(`http://localhost:5002/api/lists/${data.id}`);
    if (verifyResponse.status === 200) {
      const listData = await verifyResponse.json() as ListData;
      console.log('✅ SUCCESS! Node 5002 now has the list:', listData.name);
      console.log('   List ID:', listData.id);
      console.log('   Vector Clock:', JSON.stringify(listData.vectorClock));
    } else {
      console.log('❌ FAILED: Node 5002 still does not have the list');
    }
  } catch (err) {
    console.log('❌ FAILED: Error checking Node 5002:', err);
  }

  console.log('\n=== Lazy Pirate Test Complete ===');
  
  // Force exit since we can't cleanly stop the cloud
  console.log('Exiting...');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});