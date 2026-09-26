// Single choke point for every UI update ECHO emits.
//
// Both the cloud brain (brain.ts) and the whole local stack (smart-router,
// local-brain, watchers…) talk to the user through here, so the orb, the side
// panel and the persistent transcript can never drift out of sync.

import { appendEntry, newChat, isTemporaryChat, ChatEntry, Source } from './chats';
import { DEFAULT_SCOPE, scopeForTab } from './agents/leases';

export type TranscriptEntry = ChatEntry;

/** Append to the active chat (saved history, or the temporary chat). */
export function pushTranscript(entry: TranscriptEntry) {
  appendEntry(entry);
}

/** Start a fresh chat, keeping the current temporary/saved mode. */
export async function clearTranscript(): Promise<void> {
  await newChat(await isTemporaryChat());
}

/**
 * Deliver a message to the content-script orb on `tabId` AND mirror
 * conversational traffic to extension pages (side panel / popup).
 * Every send is failure-tolerant: a missing receiver is normal and must never
 * reject into the caller's control flow.
 *
 * Each message is tagged with the scope that owns the tab — an avatar id, or
 * 'default' for the classic ECHO — so the panel keeps each avatar's thread
 * apart and the transcript lands in the right chat.
 */
export function safeSendMessage(tabId: number | undefined | null, msg: any, agent?: string) {
  msg = { ...msg, agent: agent ?? scopeForTab(tabId) };
  if (tabId !== undefined && tabId !== null) {
    chrome.tabs.sendMessage(tabId, msg).catch(() => { /* no content script on this tab */ });
  }
  if (['ECHO_SAY', 'ECHO_STATE', 'ECHO_USAGE', 'ECHO_SUGGEST', 'ECHO_DRAFT'].includes(msg.type)) {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch { /* no page open */ }
  }
  if (msg.type === 'ECHO_SAY' && typeof msg.text === 'string') {
    pushTranscript({ role: 'echo', text: msg.text, tier: msg.tier, sources: msg.sources, searchHtml: msg.searchHtml, agent: msg.agent,
      ...(msg.unverified?.length ? { unverified: msg.unverified } : {}) });
  }
}

/** Extra details a reply can carry: citations, and facts ECHO could not find in what it read. */
export interface SayExtra { sources?: Source[]; searchHtml?: string; unverified?: string[] }

/**
 * Speak/print a reply. `tier` tags which brain answered (0-3) for the UI badge;
 * `extra` carries web-search citations.
 */
export function say(tabId: number | undefined, text: string, tier?: number, extra: SayExtra = {}) {
  const sources = extra.sources?.length ? extra.sources : undefined;
  const unverified = extra.unverified?.length ? extra.unverified : undefined;
  safeSendMessage(tabId, { type: 'ECHO_SAY', text, tier, sources, searchHtml: extra.searchHtml, unverified });
}

/** Update the orb / panel status line. */
export function setState(tabId: number | undefined, state: string) {
  safeSendMessage(tabId, { type: 'ECHO_STATE', state });
}

/**
 * Reply in a named avatar's thread (and on `tabId`'s orb). For work that
 * outlives a tab lookup: an agent's run keeps its thread even if its tab
 * was released or closed before the reply arrived.
 */
export function sayAs(agent: string, tabId: number | undefined, text: string, tier?: number, extra: SayExtra = {}) {
  const unverified = extra.unverified?.length ? extra.unverified : undefined;
  safeSendMessage(tabId, { type: 'ECHO_SAY', text, tier, unverified }, agent);
}

/** A reply still being written: shown live in the avatar's thread, replaced by the final ECHO_SAY. */
export function draftAs(agent: string, text: string) {
  try { chrome.runtime.sendMessage({ type: 'ECHO_DRAFT', agent, text }).catch(() => {}); } catch { /* no page open */ }
}
export function setStateAs(agent: string, tabId: number | undefined, state: string) {
  safeSendMessage(tabId, { type: 'ECHO_STATE', state }, agent);
}

/** Echo the user's own message into the transcript + panel of the scope that owns `tabId`. */
export function echoUser(text: string, tabId?: number | null) {
  const agent = scopeForTab(tabId);
  pushTranscript({ role: 'user', text, agent });
  try { chrome.runtime.sendMessage({ type: 'ECHO_USER_ECHO', text, agent }).catch(() => {}); } catch { /* ignore */ }
}

/** Push a proactive, dismissible suggestion (Tier 2 passive observer). */
export function suggest(tabId: number | undefined, text: string, action: string) {
  safeSendMessage(tabId, { type: 'ECHO_SUGGEST', text, action });
}

/**
 * Resolve a usable tab id when the request came from the side panel/popup.
 * A tab that belongs to an avatar is never picked up this way: requests
 * without a tab are the classic ECHO's, and it leaves avatars' tabs alone.
 */
export async function resolveActiveTab(tabId?: number | null): Promise<number | undefined> {
  if (tabId !== undefined && tabId !== null) return tabId;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id != null && scopeForTab(tab.id) === DEFAULT_SCOPE ? tab.id : undefined;
  } catch {
    return undefined;
  }
}
