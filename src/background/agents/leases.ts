// Avatar ↔ tab leases.
//
// The user assigns an avatar to a tab; from then on that avatar is an agent
// with its own scope (conversation, stop button, approvals, task tracker) and
// may act only in that tab plus the tabs it opens from it. One avatar holds at
// most one tab and one tab has at most one avatar. Leases live in session
// storage, the same lifetime as tab ids, and a synchronous in-memory copy lets
// tools check ownership on every call.

import { CHARACTERS, REACTOR } from '../../characters';

/** The scope of the classic, unassigned ECHO. */
export const DEFAULT_SCOPE = 'default';

export interface Lease {
  /** Avatar id: a character id from src/characters, or 'reactor'. */
  agent: string;
  tabId: number;
  /** Tabs this avatar opened from its tab; they belong to it too. */
  children: number[];
  /** Stable id for this assignment (a new one each time it is assigned). */
  leaseId: string;
  since: number;
}

const KEY = 'echo_agent_leases';

export const AGENT_IDS: string[] = [...CHARACTERS.map(c => c.id), REACTOR];

let leases: Record<string, Lease> = {};
let writes: Promise<unknown> = Promise.resolve();

function valid(value: any): value is Lease {
  return value && typeof value.agent === 'string' && Number.isInteger(value.tabId)
    && Array.isArray(value.children) && typeof value.leaseId === 'string';
}

function adopt(raw: unknown) {
  const next: Record<string, Lease> = {};
  if (raw && typeof raw === 'object') {
    for (const [agent, lease] of Object.entries(raw as Record<string, unknown>)) {
      if (AGENT_IDS.includes(agent) && valid(lease)) next[agent] = lease;
    }
  }
  leases = next;
}

/** Resolves once the in-memory copy matches session storage. */
export const leasesReady: Promise<void> = chrome.storage.session.get([KEY])
  .then(r => adopt(r[KEY]))
  .catch(() => {});

// Another context (a test, or a second worker instance) may write leases too.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && KEY in changes) adopt(changes[KEY].newValue);
});

function persist(): Promise<void> {
  const snapshot = { ...leases };
  const write = writes.then(() => chrome.storage.session.set({ [KEY]: snapshot }));
  writes = write.catch(() => {});
  return write;
}

// --- lookups (synchronous) ----------------------------------------------------

export function listLeases(): Lease[] { return Object.values(leases); }
export function leaseFor(agent: string): Lease | null { return leases[agent] || null; }

/** The lease that owns this tab, directly or as a tab the avatar opened. */
export function leaseForTab(tabId?: number | null): Lease | null {
  if (tabId == null) return null;
  return Object.values(leases).find(l => l.tabId === tabId || l.children.includes(tabId)) || null;
}

/** Which scope acts in this tab: its avatar, or the classic ECHO. */
export function scopeForTab(tabId?: number | null): string {
  return leaseForTab(tabId)?.agent || DEFAULT_SCOPE;
}

/** Every tab a scope may touch; the default scope may touch any tab no avatar owns. */
export function tabAccessible(scope: string, tabId: number): boolean {
  const owner = leaseForTab(tabId);
  return scope === DEFAULT_SCOPE ? !owner : owner?.agent === scope;
}

export function isAgentId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_IDS.includes(value);
}

// --- changes ------------------------------------------------------------------

export type LeaseListener = (change: { agent: string; lease: Lease | null; previous: Lease | null }) => void;
const listeners: LeaseListener[] = [];
export function onLeaseChange(listener: LeaseListener): void { listeners.push(listener); }
function notify(agent: string, lease: Lease | null, previous: Lease | null) {
  for (const listener of listeners) {
    try { listener({ agent, lease, previous }); } catch (e) { console.error('[ECHO] lease listener', e); }
  }
}

/**
 * Give `agent` the tab. The tab must be a normal web page that no other avatar
 * holds. If the avatar held another tab, that assignment ends first.
 */
export async function assignLease(agent: string, tabId: number): Promise<Lease> {
  await leasesReady;
  if (!isAgentId(agent)) throw new Error('Unknown avatar.');
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error('That tab is closed.');
  if (tab.incognito) throw new Error('Avatars can\'t be assigned to private windows.');
  if (!/^https?:\/\//i.test(tab.url || '')) throw new Error('Open a regular web page in the tab first.');
  const owner = leaseForTab(tabId);
  if (owner && owner.agent !== agent) throw new Error(`This tab already belongs to another avatar (${owner.agent}). Release it first.`);
  if (owner?.agent === agent && owner.tabId === tabId) return owner;

  const previous = leases[agent] || null;
  const lease: Lease = { agent, tabId, children: [], leaseId: crypto.randomUUID(), since: Date.now() };
  leases = { ...leases, [agent]: lease };
  await persist();
  // A working agent must not lose its tab to Chrome's memory saver.
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  if (previous) restoreDiscardable(previous);
  notify(agent, lease, previous);
  return lease;
}

export async function releaseLease(agent: string): Promise<Lease | null> {
  await leasesReady;
  const previous = leases[agent] || null;
  if (!previous) return null;
  const { [agent]: _removed, ...rest } = leases;
  leases = rest;
  await persist();
  restoreDiscardable(previous);
  notify(agent, null, previous);
  return previous;
}

/** A tab the avatar opened becomes part of its lease. */
export async function adoptChildTab(agent: string, tabId: number): Promise<void> {
  const lease = leases[agent];
  if (!lease || lease.tabId === tabId || lease.children.includes(tabId)) return;
  leases = { ...leases, [agent]: { ...lease, children: [...lease.children, tabId] } };
  await persist();
}

/** Closing an avatar's own tab ends its lease; closing a child just drops it. */
export async function forgetTab(tabId: number): Promise<Lease | null> {
  await leasesReady;
  const lease = leaseForTab(tabId);
  if (!lease) return null;
  if (lease.tabId === tabId) return releaseLease(lease.agent);
  leases = { ...leases, [lease.agent]: { ...lease, children: lease.children.filter(id => id !== tabId) } };
  await persist();
  return null;
}

export async function releaseAllLeases(): Promise<void> {
  for (const agent of Object.keys(leases)) await releaseLease(agent);
}

function restoreDiscardable(lease: Lease) {
  chrome.tabs.update(lease.tabId, { autoDiscardable: true }).catch(() => {});
}
