import { ShoppingListCloud } from './cloud';

const cloud = new ShoppingListCloud();
cloud.startCloud().then(() => {
  console.log('Cloud started with all nodes.');
});