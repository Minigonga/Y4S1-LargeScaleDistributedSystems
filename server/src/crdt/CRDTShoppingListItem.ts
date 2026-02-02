import { LWWRegister } from './LWWRegister';
import { PNCounter } from './PNCounter';

export type CRDTShoppingListItem = {
  id: string;
  listId: string;
  name: LWWRegister<string>;
  quantity: PNCounter;
  acquired: PNCounter;
  createdAt: number;
  lastUpdated: number;
  vectorClock: { [nodeId: string]: number };
};