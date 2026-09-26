// ECHO's device identity for its OpenClaw gateway.
//
// The gateway pairs devices, not passwords: every connect signs the server's
// challenge with an Ed25519 key, and the device id is the SHA-256 of that key.
// The private key is created non-extractable inside WebCrypto, so no page,
// storage export or extension message can ever read it — only sign with it.

import type { GatewayBrowserDeviceIdentity } from '@openclaw/gateway-client/browser';

export interface StoredKeyPair { publicKey: CryptoKey; privateKey: CryptoKey }

/** Where the key pair lives between worker restarts. */
export interface KeyPairStore {
  load(): Promise<StoredKeyPair | null>;
  save(pair: StoredKeyPair): Promise<void>;
}

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

// The node and operator connections start together; both must get the same
// key pair rather than racing to create two.
const pending = new WeakMap<KeyPairStore, Promise<GatewayBrowserDeviceIdentity>>();

export function deviceIdentity(store: KeyPairStore): Promise<GatewayBrowserDeviceIdentity> {
  let identity = pending.get(store);
  if (!identity) {
    identity = createIdentity(store);
    pending.set(store, identity);
    identity.catch(() => pending.delete(store));
  }
  return identity;
}

async function createIdentity(store: KeyPairStore): Promise<GatewayBrowserDeviceIdentity> {
  let pair = await store.load();
  if (!pair) {
    pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']) as CryptoKeyPair;
    await store.save(pair);
  }
  // Public keys stay exportable even when the pair is not.
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
  const { privateKey } = pair;
  return {
    deviceId: hex(digest),
    publicKey: base64Url(raw),
    sign: async payload => base64Url(new Uint8Array(
      await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(payload)))),
  };
}

// --- IndexedDB store (extension) ---------------------------------------------
// A separate database from echo_db so the key never shares an upgrade path
// with caches that are routinely cleared.

const DB_NAME = 'echo_openclaw';
const STORE = 'keys';
const KEY = 'device';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const indexedDbKeyStore: KeyPairStore = {
  async load() {
    const db = await openDb();
    try {
      return await new Promise<StoredKeyPair | null>((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
        req.onsuccess = () => resolve((req.result as StoredKeyPair | undefined) || null);
        req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  },
  async save(pair) {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(pair, KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
};
