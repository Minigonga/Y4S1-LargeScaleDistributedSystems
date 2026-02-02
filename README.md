# SDLE Assignment

SDLE Assignment of group T03G06.

## Group Members

1. Gonçalo Pinto (<up202204943@up.pt>)
2. José Granja (<up202205143@up.pt>)
3. Leonardo Ribeiro (<up202205144@up.pt>)
4. Manuel Mo (<up202205000@up.pt>)

## Installation

### Prerequisites

- Node.js (v18 or higher)
- npm (v9 or higher)

### Server

```bash
cd server
npm install
```

### Client

```bash
cd client
npm install
```

## How to Run

### 1. Start the Server (Cloud Infrastructure)

The server runs a Dynamo-style distributed system with 5 storage nodes and 1 coordinator.

```bash
cd server
npm run cloud
```

This starts:

- **Coordinator** on port `7000` - Routes requests using consistent hashing
- **Storage nodes** on ports `5000`, `5001`, `5002`, `5003`, `5004` - Store data with replication

### 2. Start the Client

In a new terminal:

```bash
cd client
npm run dev
```

This starts the React client on `http://localhost:5173`.

### 3. (Optional) Run a Second Client

To test multi-client synchronization, open another terminal:

```bash
cd client
npm run dev:client2
```

This starts a second client on `http://localhost:5174`.

### Summary

| Component | Command | URL/Port |
|-----------|---------|----------|
| Server (Cloud) | `npm run cloud` | Coordinator: 7000, Nodes: 5000-5004 |
| Client 1 | `npm run dev` | `http://localhost:5173` |
| Client 2 | `npm run dev:client2` | `http://localhost:5174` |

## How to Test

### Run All Tests

```bash
cd server
npm test
```

### Run Tests in Watch Mode

```bash
cd server
npm run test:watch

# Test lazy pirate integration test
npx ts-node test/LazyPirate.integration.ts
```

### Run Tests with Coverage

```bash
cd server
npm run test:coverage
```

### Test Files

| Test File | Description |
|-----------|-------------|
| `VectorClock.test.ts` | Vector clock operations (increment, merge, compare) |
| `AWORSet.test.ts` | Add-Wins Observed-Remove Set CRDT operations |
| `ConsistentHash.test.ts` | Consistent hashing ring and key distribution |
| `Quorum.test.ts` | Quorum calculations (R+W>N) and fault tolerance |
| `DynamoIntegration.test.ts` | Dynamo architecture compliance and failure scenarios |

## Architecture

This project implements a **local-first** shopping list application with:

- **CRDTs** (Conflict-free Replicated Data Types): AWORSet, LWWRegister, PNCounter
- **Dynamo-style distribution**: Consistent hashing, quorum reads/writes (N=3, R=2, W=2)
- **Offline support**: IndexedDB for local storage, pending operations queue
- **Real-time sync**: Server-Sent Events (SSE) for live updates
- **Fault tolerance**: Hinted handoff for temporary node failures
