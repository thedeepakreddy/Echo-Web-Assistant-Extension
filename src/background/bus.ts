// Single choke point for every UI update ECHO emits.
//
// Both the cloud brain (brain.ts) and the whole local stack (smart-router,
// local-brain, watchers…) talk to the user through here, so the orb, the side
// panel and the persistent transcript can never drift out of sync.

import { appendEntry, newChat, isTemporaryChat, ChatEntry, Source } from './chats';

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
 */
export function safeSendMessage(tabId: number | undefined | null, msg: any) {
  if (tabId !== undefined && tabId !== null) {
    chrome.tabs.sendMessage(tabId, msg).catch(() => { /* no content script on this tab */ });
  }
  if (msg.type === 'ECHO_SAY' || msg.type === 'ECHO_STATE' || msg.type === 'ECHO_USAGE' || msg.type === 'ECHO_SUGGEST') {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch { /* no page open */ }
  }
  if (msg.type === 'ECHO_SAY' && typeof msg.text === 'string') {
    pushTranscript({ role: 'echo', text: msg.text, tier: msg.tier, sources: msg.sources, searchHtml: msg.searchHtml });
  }
}

/**
 * Speak/print a reply. `tier` tags which brain answered (0-3) for the UI badge;
 * `extra` carries web-search citations.
 */
export function say(tabId: number | undefined, text: string, tier?: number,
  extra: { sources?: Source[]; searchHtml?: string } = {}) {
  const sources = extra.sources?.length ? extra.sources : undefined;
  safeSendMessage(tabId, { type: 'ECHO_SAY', text, tier, sources, searchHtml: extra.searchHtml });
}

/** Update the orb / panel status line. */
export function setState(tabId: number | undefined, state: string) {
  safeSendMessage(tabId, { type: 'ECHO_STATE', state });
}

/** Echo the user's own message into the transcript + panel. */
export function echoUser(text: string) {
  pushTranscript({ role: 'user', text });
  try { chrome.runtime.sendMessage({ type: 'ECHO_USER_ECHO', text }).catch(() => {}); } catch { /* ignore */ }
}

/** Push a proactive, dismissible suggestion (Tier 2 passive observer). */
export function suggest(tabId: number | undefined, text: string, action: string) {
  safeSendMessage(tabId, { type: 'ECHO_SUGGEST', text, action });
}

/** Resolve a usable tab id when the request came from the side panel/popup. */
export async function resolveActiveTab(tabId?: number | null): Promise<number | undefined> {
  if (tabId !== undefined && tabId !== null) return tabId;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
  } catch {
    return undefined;
  }
}
