// Documentation-only Chrome API shim. The production React components run
// unchanged; this file supplies deterministic, non-sensitive sample data so
// screenshots never depend on a developer's browser profile or API keys.

type Listener = (message: any, sender?: any, sendResponse?: (value: any) => void) => any;
const messageListeners = new Set<Listener>();
const storageListeners = new Set<Listener>();
const noopEvent = { addListener: () => {}, removeListener: () => {} };

const localData: Record<string, any> = {
  provider: 'groq',
  groqModel: 'llama-3.3-70b-versatile',
  echo_avatar: 'echo',
  echo_speech_language: 'en-US',
  echo_memory_enabled: true,
  echo_profile: {
    name: 'Alex',
    about: 'Product designer learning practical AI tools',
    tone: 'concise',
    instructions: 'Use clear language and practical examples.',
  },
  echo_local_settings: {
    localFirst: true,
    useCache: true,
    useLocalLlm: true,
    autoIndex: true,
    passiveSuggest: true,
    webSearch: 'auto',
    allowedDomains: ['example.com', 'developer.chrome.com'],
  },
};
const sessionData: Record<string, any> = {};

const select = (source: Record<string, any>, keys: any) => {
  if (keys == null) return { ...source };
  if (typeof keys === 'string') return { [keys]: source[keys] };
  if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, source[key]]));
  return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, source[key] ?? fallback]));
};

const area = (source: Record<string, any>) => ({
  get(keys: any, callback?: (value: any) => void) {
    const value = select(source, keys);
    callback?.(value);
    return Promise.resolve(value);
  },
  set(values: Record<string, any>, callback?: () => void) {
    const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { oldValue: source[key], newValue: value }]));
    Object.assign(source, values);
    storageListeners.forEach(listener => listener(changes, source === localData ? 'local' : 'session'));
    callback?.();
    return Promise.resolve();
  },
  remove(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete source[key];
    return Promise.resolve();
  },
  clear() { for (const key of Object.keys(source)) delete source[key]; return Promise.resolve(); },
});

const skills = [
  { id: 'summary', shortcut: 'tldr', name: 'TL;DR', prompt: 'Summarize this page in three bullets.' },
  { id: 'explain', shortcut: 'explain', name: 'Explain simply', prompt: 'Explain the selected text in plain language.' },
  { id: 'email', shortcut: 'email', name: 'Polish email', prompt: 'Rewrite this email to be clear, warm and concise.' },
];
const chats = [
  { id: 'one', title: 'Planning a focused workday', updated: Date.now() - 3_600_000, count: 8 },
  { id: 'two', title: 'Research notes from Chrome AI', updated: Date.now() - 86_400_000, count: 12 },
  { id: 'three', title: 'Weekly reading summary', updated: Date.now() - 172_800_000, count: 5 },
];

const responseFor = (message: any) => {
  switch (message?.type) {
    case 'CHECK_AWAKE_STATE': return { isAwake: false };
    case 'ECHO_CONTENT_PREFS': return { success: true, position: { x: 1190, y: 640 }, avatar: 'echo', passiveSuggest: true, siteAllowed: true };
    case 'ECHO_PENDING_APPROVAL': return { approval: null };
    case 'ECHO_RECORD_STATUS': return { active: false };
    case 'ECHO_GET_HIGHLIGHTS': return { texts: [] };
    case 'ECHO_ROUTER_REPORT': return { text: '85% answered locally\nFast, private, and API-quota friendly' };
    case 'ECHO_SKILLS_LIST': return { success: true, skills };
    case 'ECHO_CHAT_LIST': return { success: true, chats };
    case 'ECHO_CHAT_STATE_REQUEST': return { success: true, activeId: null, temporary: false, title: 'New chat', messages: [] };
    case 'ECHO_ISOLATION_STATUS': return { success: true, allowed: true, open: false };
    case 'ECHO_PRIVACY_STATUS': return {
      success: true, pages: 24, memory: { preferred_output: 'Clear steps with examples', role: 'Product designer' },
      allowedDomains: ['example.com', 'developer.chrome.com'], autoIndex: true,
      host: 'example.com', url: 'https://example.com/guide', siteAllowed: true, siteEligible: true,
    };
    case 'ECHO_TABS_LIST': return { success: true, tabs: [
      { id: 1, title: 'Browser workflow guide', url: 'https://example.com/guide' },
      { id: 2, title: 'Chrome AI documentation', url: 'https://developer.chrome.com/docs/ai' },
    ] };
    case 'ECHO_CHAT_NEW': return { success: true, activeId: null, temporary: !!message.temporary, title: 'New chat', messages: [] };
    default: return { success: true };
  }
};

const runtime = {
  getURL: (asset: string) => asset,
  onMessage: {
    addListener(listener: Listener) { messageListeners.add(listener); },
    removeListener(listener: Listener) { messageListeners.delete(listener); },
  },
  sendMessage(message: any, callback?: (value: any) => void) {
    const response = responseFor(message);
    callback?.(response);
    return Promise.resolve(response);
  },
};

(globalThis as any).chrome = {
  runtime,
  storage: {
    local: area(localData),
    session: area(sessionData),
    onChanged: {
      addListener(listener: Listener) { storageListeners.add(listener); },
      removeListener(listener: Listener) { storageListeners.delete(listener); },
    },
  },
  tabs: {
    query: () => Promise.resolve([{ id: 1, active: true, title: 'Browser workflow guide', url: 'https://example.com/guide' }]),
    onActivated: noopEvent,
    onUpdated: noopEvent,
    sendMessage: () => Promise.resolve({ success: true }),
  },
};

(globalThis as any).__echoDocsSend = (message: any) => {
  for (const listener of messageListeners) listener(message, {}, () => {});
};
