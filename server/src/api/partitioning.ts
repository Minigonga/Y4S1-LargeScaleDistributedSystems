import crypto from 'crypto';

/** 
 * Hashes a key (e.g., listId) into the consistent hash ring using SHA-1. 
 */
export function hashKey(key: string): bigint {
  return BigInt(
    '0x' + crypto.createHash('sha1').update(key).digest('hex')
  );
}

/** 
 * Hashes a node's port number for placement on the consistent hash ring. 
 */
export function hashNode(port: number): bigint {
  return hashKey(port.toString());
}