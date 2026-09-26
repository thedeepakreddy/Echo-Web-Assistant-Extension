// Chat history. Every message ECHO shows is appended to the active chat (via
// bus.ts). Saved chats live in local storage; a temporary chat lives only in
// session storage, so it disappears when the browser closes and never shows up
// in history.
//
// An avatar working in its own tab keeps its own thread instead, in session
// storage: it lasts as long as the tab assignment it belongs to.

import { DEFAULT_SCOPE } from './agents/leases';

export interface Source { title: string; url: string }

export interface ChatEntry {
  role: 'user' | 'echo';
  text: string;
  ts?: number;
  tier?: number;
  sources?: Source[];
  searchHtml?: string;   // Google Search suggestions widget (Gemini grounding)
  /** The scope that said or received it: an avatar id, or 'default'. */
  agent?: string;
}

export interface Chat { id: string; title: string; created: number; updated: number; messages: ChatEntry[] }
export interface ChatMeta { id: string; title: string; created: number; updated: number; count: number }
export interface ChatState { activeId: string | null; temporary: boolean; title: string; messages: ChatEntry[] }

const CHATS = 'echo_chats';
const ACTIVE = 'echo_active_chat';
const TEMP = 'echo_temp_chat';          // session storage: { messages }
const THREADS = 'echo_agent_threads';   // session storage: { [agent]: ChatEntry[] }
const MAX_CHATS = 100;
const MAX_MESSAGES = 200;

// All writes go through one queue so concurrent appends never lose messages.
let queue: Promise<unknown> = Promise.resolve();
let generation = 0;
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function titleFrom(messages: ChatEntry[]): string {
  const first = messages.find(m => m.role === 'user')?.text || 'New chat';
  const line = first.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

async function loadChats(): Promise<Record<string, Chat>> {
  const r = await chrome.storage.local.get([CHATS, 'echo_transcript']);
  let chats = (r[CHATS] || null) as Record<string, Chat> | null;
  if (!chats) {
    chats = {};
    // One-time migration: the old single transcript becomes the first chat.
    const old = Array.isArray(r.echo_transcript) ? (r.echo_transcript as ChatEntry[]) : [];
    if (old.length) {
      const id = crypto.randomUUID();
      const ts = old[old.length - 1]?.ts || Date.now();
      chats[id] = { id, title: titleFrom(old), created: old[0]?.ts || ts, updated: ts, messages: old.slice(-MAX_MESSAGES) };
      await chrome.storage.local.set({ [CHATS]: chats, [ACTIVE]: id });
    } else {
      await chrome.storage.local.set({ [CHATS]: chats });
    }
    await chrome.storage.local.remove('echo_transcript');
  }
  return chats;
}

async function saveChats(chats: Record<string, Chat>): Promise<void> {
  const ids = Object.keys(chats);
  if (ids.length > MAX_CHATS) {
    ids.sort((a, b) => chats[a].updated - chats[b].updated)
      .slice(0, ids.length - MAX_CHATS).forEach(id => delete chats[id]);
  }
  await chrome.storage.local.set({ [CHATS]: chats });
}

export async function isTemporaryChat(): Promise<boolean> {
  const r = await chrome.storage.session.get([TEMP]);
  return !!r[TEMP];
}

async function activeId(): Promise<string | null> {
  const r = await chrome.storage.local.get([ACTIVE]);
  return (r[ACTIVE] as string) || null;
}

export function chatState(): Promise<ChatState> {
  return serial(async () => {
    const temp = (await chrome.storage.session.get([TEMP]))[TEMP] as { messages: ChatEntry[] } | undefined;
    if (temp) return { activeId: null, temporary: true, title: 'Temporary chat', messages: temp.messages || [] };
    const chats = await loadChats();
    const id = await activeId();
    const chat = id ? chats[id] : undefined;
    return { activeId: chat ? chat.id : null, temporary: false, title: chat?.title || 'New chat', messages: chat?.messages || [] };
  });
}

/** Append a message to whatever chat is active. Never throws into callers. */
export function appendEntry(entry: ChatEntry): void {
  if (entry.agent && entry.agent !== DEFAULT_SCOPE) { appendToThread(entry.agent, entry); return; }
  const gen = generation;
  serial(async () => {
    if (gen !== generation) return;   // a new chat started after this was sent
    const stamped = { ...entry, ts: Date.now() };
    const temp = (await chrome.storage.session.get([TEMP]))[TEMP] as { messages: ChatEntry[] } | undefined;
    if (temp) {
      const messages = [...(temp.messages || []), stamped].slice(-MAX_MESSAGES);
      await chrome.storage.session.set({ [TEMP]: { messages } });
      return;
    }
    const chats = await loadChats();
    let id = await activeId();
    if (!id || !chats[id]) {
      id = crypto.randomUUID();
      chats[id] = { id, title: 'New chat', created: Date.now(), updated: Date.now(), messages: [] };
      await chrome.storage.local.set({ [ACTIVE]: id });
    }
    const chat = chats[id];
    chat.messages = [...chat.messages, stamped].slice(-MAX_MESSAGES);
    chat.updated = Date.now();
    if (chat.title === 'New chat') chat.title = titleFrom(chat.messages);
    await saveChats(chats);
  }).catch(error => console.warn('[ECHO] Chat save failed:', error));
}

/** Start a fresh chat. Empty saved chats are not kept around. */
export function newChat(temporary: boolean): Promise<ChatState> {
  generation++;
  return serial(async () => {
    const chats = await loadChats();
    const id = await activeId();
    if (id && chats[id] && !chats[id].messages.length) { delete chats[id]; await saveChats(chats); }
    await chrome.storage.local.remove(ACTIVE);
    if (temporary) await chrome.storage.session.set({ [TEMP]: { messages: [] } });
    else await chrome.storage.session.remove(TEMP);
    return { activeId: null, temporary, title: temporary ? 'Temporary chat' : 'New chat', messages: [] };
  });
}

export function openChat(id: string): Promise<ChatState> {
  generation++;
  return serial(async () => {
    const chats = await loadChats();
    const chat = chats[id];
    if (!chat) throw new Error('That chat no longer exists.');
    await chrome.storage.session.remove(TEMP);
    await chrome.storage.local.set({ [ACTIVE]: id });
    return { activeId: id, temporary: false, title: chat.title, messages: chat.messages };
  });
}

export function listChats(): Promise<ChatMeta[]> {
  return serial(async () => {
    const chats = await loadChats();
    return Object.values(chats)
      .filter(c => c.messages.length)
      .sort((a, b) => b.updated - a.updated)
      .map(c => ({ id: c.id, title: c.title, created: c.created, updated: c.updated, count: c.messages.length }));
  });
}

/** Returns true when the deleted chat was the active one. */
export function deleteChat(id: string): Promise<boolean> {
  return serial(async () => {
    const chats = await loadChats();
    delete chats[id];
    await saveChats(chats);
    if (await activeId() === id) { generation++; await chrome.storage.local.remove(ACTIVE); return true; }
    return false;
  });
}

export function deleteAllChats(): Promise<void> {
  generation++;
  return serial(async () => {
    await chrome.storage.local.set({ [CHATS]: {} });
    await chrome.storage.local.remove([ACTIVE, 'echo_transcript']);
  });
}

export function exportChats(): Promise<Chat[]> {
  return serial(async () => Object.values(await loadChats()));
}

// --- avatar threads -----------------------------------------------------------

async function loadThreads(): Promise<Record<string, ChatEntry[]>> {
  const r = await chrome.storage.session.get([THREADS]);
  return (r[THREADS] || {}) as Record<string, ChatEntry[]>;
}

function appendToThread(agent: string, entry: ChatEntry): void {
  serial(async () => {
    const threads = await loadThreads();
    threads[agent] = [...(threads[agent] || []), { ...entry, ts: Date.now() }].slice(-MAX_MESSAGES);
    await chrome.storage.session.set({ [THREADS]: threads });
  }).catch(error => console.warn('[ECHO] Avatar thread save failed:', error));
}

export function agentThread(agent: string): Promise<ChatEntry[]> {
  return serial(async () => (await loadThreads())[agent] || []);
}

export function clearAgentThread(agent: string): Promise<void> {
  return serial(async () => {
    const threads = await loadThreads();
    delete threads[agent];
    await chrome.storage.session.set({ [THREADS]: threads });
  });
}
