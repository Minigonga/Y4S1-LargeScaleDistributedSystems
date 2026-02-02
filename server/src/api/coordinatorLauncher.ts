import { CoordinatorServer } from './coordinator';
import cloudConfig from './cloudConfig.json';

const coordinator = new CoordinatorServer(cloudConfig.coordinator.httpPort);

coordinator.start().then(() => {
  console.log(`✅ Coordinator ready for SSE connections on port ${cloudConfig.coordinator.httpPort}`);
  console.log(`📨 Listening for gossip from storage nodes on port ${cloudConfig.coordinator.zmqPort}`);
}).catch(err => {
  console.error('Failed to start coordinator:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nReceived SIGINT, shutting down coordinator...');
  await coordinator.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nReceived SIGTERM, shutting down coordinator...');
  await coordinator.stop();
  process.exit(0);
});
