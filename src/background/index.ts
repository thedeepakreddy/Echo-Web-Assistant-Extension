import { executeTool } from './tools';
import {
  processUserInput, abortCurrentWork, clearCloudConversation, clearAllConversations, seedCloudConversation,
  forgetCloudConversationAfterReply,
} from './brain';
import { routeUserInput, ingestPage, getSettings, setSettings, routerReport, domainAllowed, sameSite, cloudReady, answerFromTabsOnDevice } from './smart-router';
import { saveHighlight, highlightsForUrl, allHighlights, clearHighlights, forgetHighlightsForHost } from './highlights';
import { runWatcherCheck, rehydrateWatchers, WATCH_ALARM_PREFIX, listWatchers, onWatcherFired } from './page-watcher';
import { OWN_WATCHERS } from './openclaw/browser-tools';
import { cachePrune } from './response-cache';
import { say, sayAs, setState, clearTranscript, echoUser } from './bus';
import { settleApproval, cancelTask, pendingApproval, approvalById } from './safety';
import { isIndexable, forgetSite, clearKB, kbSize, recentPages } from './knowledge-base';
import { cacheClear } from './response-cache';
import { runDoctor } from './doctor';
import { idbGetAll, STORE_CACHE } from './db';
import { appendRecordedStep, resumeRecordingForTab, recordNavigation, cancelRecording } from './workflow-engine';
import { beginTask, finishTask, recoverInterruptedTasks, cancelActiveTask, taskStatus, runningScopes } from './task-state';
import {
  chatState, newChat, openChat, listChats, deleteChat, deleteAllChats, exportChats, isTemporaryChat,
  agentThread, clearAgentThread,
} from './chats';
import { listSkills, saveSkill, deleteSkill, resetSkills, expandSkill } from './skills';
import { setMemory, deleteMemory, clearMemories, getProfile } from './personalization';
import {
  isolationAllowed, openIsolatedWindow, closeIsolatedWindow, isolatedWindowId, forgetIsolatedWindow, setAgentScope,
} from './isolation';
import { createWriterMenus, runWriter, WRITER_MENU_PREFIX } from './writer';
import { readMentionedTabs, withTabContext } from './tab-context';
import { resolveAppearance } from '../characters';
import {
  startOpenClaw, openClawReadyFor, runOnOpenClaw, abortOpenClaw, openClawRunPending, openClawStatus, saveOpenClawSettings,
} from './openclaw';
import { setupScript } from './openclaw/setup-script';
import { handleLocally } from './local-brain';
import {
  DEFAULT_SCOPE, leasesReady, leaseFor, leaseForTab, listLeases, scopeForTab, isAgentId,
  assignLease, releaseLease, releaseAllLeases, forgetTab, onLeaseChange,
} from './agents/leases';

console.log('ECHO Background Service Worker initialized.');

// Agents on ECHO's OpenClaw gateway (off unless enabled in settings).
startOpenClaw();

// API keys and private history live in local storage. Content scripts only get
// an explicitly filtered settings relay; pages cannot read the storage area.
// Nothing waits on this: if Chrome refuses, content scripts still only use the
// message relay, so features keep working.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  .catch(error => console.error('[ECHO] Could not protect local storage:', error));
const trustedPage = (sender: chrome.runtime.MessageSender) =>
  [chrome.runtime.getURL('options.html'), chrome.runtime.getURL('sidepanel.html')]
    .includes(String(sender.url || ''));
// Requests that read or change private data: only ECHO's own pages may send them.
const TRUSTED_ONLY = [
  'ECHO_MEMORY_SAVE', 'ECHO_MEMORY_CLEAR', 'ECHO_CHAT_STATE_REQUEST', 'ECHO_CHAT_LIST', 'ECHO_CHAT_NEW',
  'ECHO_CHAT_OPEN', 'ECHO_CHAT_DELETE', 'ECHO_CHAT_DELETE_ALL', 'ECHO_SKILLS_LIST', 'ECHO_SKILL_SAVE',
  'ECHO_SKILL_DELETE', 'ECHO_SKILLS_RESET', 'ECHO_ISOLATION_STATUS', 'ECHO_ISOLATION_CLOSE',
  'ECHO_OPEN_EXTENSION_DETAILS', 'ECHO_CLEAR_CONVERSATION',
  'ECHO_AGENT_LIST', 'ECHO_AGENT_ASSIGN', 'ECHO_AGENT_RELEASE', 'ECHO_AGENT_THREAD',
  'ECHO_OPENCLAW_STATUS', 'ECHO_OPENCLAW_SAVE', 'ECHO_OPENCLAW_SETUP_SCRIPT',
];
const fromApprovalFrame = (sender: chrome.runtime.MessageSender) =>
  String(sender.url || '').startsWith(chrome.runtime.getURL('approval.html'));
const samePage = (url: unknown, sender: chrome.runtime.MessageSender) => {
  if (typeof url !== 'string' || !sender.tab?.url) return false;
  try {
    const a = new URL(url), b = new URL(sender.tab.url);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch { return false; }
};

let isEchoAwake = false;
const wakeStateReady = chrome.storage.session.get(['isEchoAwake'])
  .then(r => { isEchoAwake = r.isEchoAwake === true; })
  .catch(() => {});

// Each task a stopped worker left behind is reported in its own tab's thread,
// except an avatar's OpenClaw run: the gateway kept working, and the reply is
// delivered once ECHO reconnects.
const recoveryReady = Promise.all([recoverInterruptedTasks(), leasesReady]).then(async ([interrupted]) => {
  const text = 'The previous task was interrupted when the browser background restarted. Please retry it.';
  for (const task of interrupted) {
    if (task.scope !== DEFAULT_SCOPE && await openClawRunPending(task.scope)) continue;
    say(task.tabId, text, 0);
    setState(task.tabId, 'Idle');
  }
}).catch(() => {});
const speechTabs = new Map<string, number>();

/** How ECHO appears on pages: a character id (see src/characters) or the reactor orb. */
const avatarStyle = resolveAppearance;

/** The avatar a tab shows: the one assigned to it, else the user's chosen look. */
const avatarForTab = (tabId: number | undefined, saved: unknown) =>
  leaseForTab(tabId)?.agent ?? avatarStyle(saved);

async function sendPrefs(tabIds?: number[]) {
  const prefs = await chrome.storage.local.get(['echo_handsfree', 'echo_speech_language', 'echo_avatar']);
  const ids = tabIds ?? (await chrome.tabs.query({})).map(t => t.id).filter((id): id is number => id != null);
  for (const id of ids) {
    chrome.tabs.sendMessage(id, { type: 'ECHO_PREFS_UPDATED',
      handsfree: !!prefs.echo_handsfree, language: String(prefs.echo_speech_language || 'en-US'),
      avatar: avatarForTab(id, prefs.echo_avatar) }).catch(() => {});
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !['echo_handsfree', 'echo_speech_language', 'echo_avatar'].some(k => k in changes)) return;
  sendPrefs().catch(() => {});
});

// --- avatars on tabs -----------------------------------------------------------

/** Stop everything one scope is doing: model calls, tool actions, approvals, task markers, gateway runs. */
function stopScope(scope: string) {
  abortCurrentWork(scope);
  cancelTask(scope);
  cancelActiveTask(scope).catch(() => {});
  if (scope !== DEFAULT_SCOPE) abortOpenClaw(scope);
}

async function agentList() {
  const scopes = runningScopes();
  return Promise.all(listLeases().map(async lease => {
    const tab = await chrome.tabs.get(lease.tabId).catch(() => null);
    return { agent: lease.agent, tabId: lease.tabId, children: lease.children, since: lease.since,
      title: tab?.title || '', url: tab?.url || '', working: scopes.includes(lease.agent) };
  }));
}

onLeaseChange(({ agent, lease, previous }) => {
  // An avatar that loses its tab (released, reassigned, or the tab closed) stops working there.
  if (previous && previous.tabId !== lease?.tabId) stopScope(agent);
  const tabs = [lease?.tabId, previous?.tabId].filter((id): id is number => id != null);
  sendPrefs(tabs).catch(() => {});
  if (previous?.tabId != null && previous.tabId !== lease?.tabId) setState(previous.tabId, 'Idle');
  agentList().then(agents => chrome.runtime.sendMessage({ type: 'ECHO_AGENTS_CHANGED', agents }).catch(() => {}))
    .catch(() => {});
});

chrome.tabs.onRemoved.addListener(tabId => { forgetTab(tabId).catch(() => {}); });

/** Which site a privacy request is about: a typed host, a URL, or the active tab. */
async function targetSite(message: any): Promise<{ host: string; url: string }> {
  let url = '';
  if (typeof message.host === 'string' && message.host.trim()) {
    const host = message.host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#:].*$/, '');
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) throw new Error('Enter a domain like example.com.');
    url = `https://${host}/`;
  } else if (typeof message.url === 'string') {
    url = message.url;
  } else {
    url = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url || '';
  }
  let host = '';
  try { if (/^https?:/i.test(url)) host = new URL(url).hostname.toLowerCase(); } catch { /* not a web page */ }
  if (!host) throw new Error('Open a regular web page first.');
  return { host, url };
}

interface RequestOptions {
  cloudOnly?: boolean;
  /** Open tabs attached with @ in the side panel. */
  tabs?: number[];
  /** The user asked for a web search for this message. */
  webSearch?: boolean;
  /** Run the task in the private ECHO window. */
  isolated?: boolean;
  /** An avatar the side panel addressed; it works in the tab assigned to it. */
  agent?: string;
}

/** Which scope handles a request: the avatar addressed, else the owner of the sender tab. */
function requestScope(senderTabId: number | undefined, agent?: string): string {
  return agent && agent !== DEFAULT_SCOPE ? agent : scopeForTab(senderTabId);
}

const INCOGNITO_HELP = 'Private agent browsing needs ECHO to be allowed in Incognito. '
  + 'I opened ECHO\'s details page: turn on "Allow in Incognito", then try again.';

async function runRequest(text: string, tabId?: number, opts: RequestOptions = {}) {
  await recoveryReady;
  // An avatar addressed from the side panel works in its own tab.
  if (opts.agent && opts.agent !== DEFAULT_SCOPE) {
    const lease = leaseFor(opts.agent);
    if (!lease) { say(tabId, 'That avatar has no tab yet. Assign it to a tab first.', 0); return; }
    tabId = lease.tabId;
  }
  const scope = scopeForTab(tabId);
  if (opts.isolated && scope !== DEFAULT_SCOPE) {
    say(tabId, 'Private-window tasks run in the main ECHO thread, not in an avatar\'s tab.', 0);
    return;
  }
  const id = await beginTask(tabId, scope);
  try {
    // "/shortcut extra" runs a saved skill; the chat shows what was typed.
    let prompt = text;
    const skill = await expandSkill(text);
    if (skill?.kind === 'unknown') { echoUser(text, tabId); say(tabId, skill.message, 0); return; }
    if (skill?.kind === 'skill') prompt = skill.prompt;

    // An avatar runs as its OpenClaw agent when the gateway is connected.
    // Local skills (stop, workflows, extractors…) still answer first: instant
    // and free. Without the gateway, the built-in brain answers below.
    if (scope !== DEFAULT_SCOPE && openClawReadyFor(scope)) {
      echoUser(opts.tabs?.length ? `${text}\n(with ${opts.tabs.length} attached tab${opts.tabs.length === 1 ? '' : 's'})` : text, tabId);
      if (await handleLocally(prompt, tabId)) return;
      const attached = opts.tabs?.length ? await readMentionedTabs(opts.tabs) : [];
      await runOnOpenClaw(scope, attached.length ? withTabContext(prompt, attached) : prompt);
      return;
    }

    if (opts.isolated) {
      echoUser(`Private window · ${text}`, tabId);
      if (!await isolationAllowed()) {
        say(tabId, INCOGNITO_HELP, 0);
        chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }).catch(() => {});
        return;
      }
      const iso = await openIsolatedWindow();
      setAgentScope({ windowId: iso.windowId });
      try {
        await processUserInput(prompt, iso.tabId, { skipEcho: true, isolated: true, webSearch: opts.webSearch });
      } finally {
        setAgentScope(null);
      }
      return;
    }

    if (opts.tabs?.length) {
      const tabs = await readMentionedTabs(opts.tabs);
      echoUser(tabs.length ? `${text}\nAttached: ${tabs.map(t => t.title).join(' · ')}` : text, tabId);
      // Every request reaches every brain: without a cloud model, attached
      // tabs are answered on-device rather than failing.
      if (tabs.length && !await cloudReady()) { await answerFromTabsOnDevice(prompt, tabs, tabId); return; }
      await processUserInput(withTabContext(prompt, tabs), tabId, { skipEcho: true, webSearch: opts.webSearch });
      return;
    }

    if (opts.cloudOnly) {
      echoUser(text, tabId);
      await processUserInput(prompt, tabId, { skipEcho: true, webSearch: opts.webSearch });
    } else {
      await routeUserInput(prompt, tabId, { display: text, webSearch: opts.webSearch });
    }
  } catch (error: any) {
    console.error('[ECHO] Request failed:', error);
    say(tabId, `I couldn't complete that request: ${error?.message || 'unknown error'}`);
  } finally {
    if (await finishTask(id)) setState(tabId, 'Idle');
  }
}

// An avatar's own watcher wakes it in its tab, to carry on with what it set
// the watcher up for. An avatar busy with another task is only told: starting
// a run would stop the one in progress. The user's notification goes out either way.
onWatcherFired(async (watcher, detail) => {
  const owners = ((await chrome.storage.local.get([OWN_WATCHERS]))[OWN_WATCHERS] || {}) as Record<string, string[]>;
  const agent = Object.keys(owners).find(a => owners[a].includes(watcher.id));
  if (!agent) return;
  await leasesReady;
  const lease = leaseFor(agent);
  if (!lease) return;
  const news = `⏰ Watcher "${watcher.label}" fired: ${detail}.`;
  if (runningScopes().includes(agent) || await openClawRunPending(agent)) {
    sayAs(agent, lease.tabId, `${news} I'll look at it after the current task.`, 0);
    return;
  }
  runRequest(`${news} Carry on with what you set it up for; if there was nothing, tell me what changed.`, undefined, { agent })
    .catch(error => console.warn('[ECHO] Waking an avatar failed:', error));
});

/** Tell the side panel which chat is showing now. */
async function broadcastChatState(state: Awaited<ReturnType<typeof chatState>>) {
  chrome.runtime.sendMessage({ type: 'ECHO_CHAT_STATE', state }).catch(() => {});
}

/** Memories feed prompts and cached answers; forget both when they change. */
async function memoryChanged() {
  await cacheClear();
  // Every avatar's conversation may hold the old memory; replies in progress finish first.
  forgetCloudConversationAfterReply();
}

const broadcastWakeState = async () => {
  const tabs = await chrome.tabs.query({});
  tabs.forEach(t => {
    if (t.id) {
      chrome.tabs.sendMessage(t.id, { type: 'ECHO_GLOBAL_WAKE', state: isEchoAwake }).catch(() => {});
    }
  });
};

chrome.action.onClicked.addListener(async () => {
  await wakeStateReady;
  isEchoAwake = !isEchoAwake;
  await chrome.storage.session.set({ isEchoAwake });
  await broadcastWakeState();
});

// Open the side panel for the window that holds the given tab (or the active
// window). Must run in a user gesture (command / context-menu / action click).
async function openSidePanel(windowId?: number) {
  if (!chrome.sidePanel) return;
  try {
    if (windowId == null) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      windowId = tab?.windowId;
    }
    if (windowId != null) await chrome.sidePanel.open({ windowId });
  } catch (e) {
    console.warn('[ECHO] Could not open side panel:', e);
  }
}

// Wake the orb and pop the in-page command input on the active tab.
async function openCommandPalette() {
  await wakeStateReady;
  isEchoAwake = true;
  await chrome.storage.session.set({ isEchoAwake });
  await broadcastWakeState();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'ECHO_OPEN_PALETTE' }).catch(() => {});
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'wake-echo') {
    await wakeStateReady;
    isEchoAwake = !isEchoAwake;
    await chrome.storage.session.set({ isEchoAwake });
    await broadcastWakeState();
  } else if (command === 'open-panel') {
    await openSidePanel();
  } else if (command === 'command-palette') {
    await openCommandPalette();
  }
});

// Right-click context menus.
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({ id: 'echo-open-panel', title: 'Open ECHO chat panel', contexts: ['all'] });
    chrome.contextMenus.create({ id: 'echo-ask-selection', title: 'Ask ECHO about "%s"', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'echo-save-highlight', title: 'Save "%s" to ECHO highlights', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'echo-fill-form', title: 'Fill this form with ECHO', contexts: ['editable', 'page'] });
    chrome.contextMenus.create({ id: 'echo-summarize', title: 'Summarize this page (no API)', contexts: ['page'] });
  } catch { /* ignore duplicate-id on reload */ }
  createWriterMenus();
  // Housekeeping on install/update.
  cachePrune().catch(() => {});
  rehydrateWatchers().catch(() => {});
});

// Alarms and watchers survive restarts; re-arm them when the worker wakes.
chrome.runtime.onStartup?.addListener(() => {
  rehydrateWatchers().catch(() => {});
  cachePrune().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) recordNavigation(tabId, changeInfo.url).catch(() => {});
});

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  const menuId = String(info.menuItemId);
  if (menuId.startsWith(WRITER_MENU_PREFIX)) {
    runWriter(menuId.slice(WRITER_MENU_PREFIX.length), tab, info.frameId, info.selectionText || '')
      .catch(error => console.error('[ECHO] Writer failed:', error));
    return;
  }
  if (info.menuItemId === 'echo-open-panel') {
    await openSidePanel(tab?.windowId);
  } else if (info.menuItemId === 'echo-ask-selection' && info.selectionText) {
    await openSidePanel(tab?.windowId);
    runRequest(`About this selected text: "${info.selectionText}"`, tab?.id).catch(() => {});
  } else if (info.menuItemId === 'echo-save-highlight' && info.selectionText) {
    if (tab?.incognito) { say(tab.id, "Highlights aren't saved from private windows.", 0); return; }
    const h = await saveHighlight(info.pageUrl || tab?.url || '', tab?.title || '', info.selectionText);
    say(tab?.id, `Saved that highlight.`, 0);
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'ECHO_APPLY_HIGHLIGHTS', texts: [h.text] }).catch(() => {});
    }
  } else if (info.menuItemId === 'echo-fill-form') {
    runRequest('fill this form', tab?.id).catch(() => {});
  } else if (info.menuItemId === 'echo-summarize') {
    runRequest('summarize this page', tab?.id).catch(() => {});
  }
});

// The private agent window was closed by the user.
chrome.windows.onRemoved.addListener(windowId => { forgetIsolatedWindow(windowId).catch(() => {}); });

// Address bar: type "echo", then Space, then a question or /skill.
const xmlEscape = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

chrome.omnibox?.setDefaultSuggestion({ description: 'Ask ECHO: %s' });

chrome.omnibox?.onInputChanged.addListener((text, suggest) => {
  const typed = text.trim();
  if (!typed.startsWith('/')) { suggest([]); return; }
  const want = typed.slice(1).split(/\s/)[0].toLowerCase();
  listSkills().then(skills => suggest(skills
    .filter(s => s.shortcut.startsWith(want)).slice(0, 6)
    .map(s => ({ content: `/${s.shortcut} `, description: `<match>/${xmlEscape(s.shortcut)}</match> <dim>${xmlEscape(s.name)}</dim>` }))))
    .catch(() => suggest([]));
});

chrome.omnibox?.onInputEntered.addListener(text => {
  const query = text.trim();
  if (!query) return;
  // Open the panel first, while Chrome still treats this as a user action.
  let opened: Promise<unknown>;
  try { opened = chrome.sidePanel ? chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }) : Promise.reject(); }
  catch (error) { opened = Promise.reject(error); }
  opened.catch(async () => {
    // No panel: wake the orb so the answer shows on the page instead.
    await wakeStateReady;
    isEchoAwake = true;
    await chrome.storage.session.set({ isEchoAwake });
    await broadcastWakeState();
  });
  (async () => {
    await leasesReady;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    // A new request replaces the previous one in the same scope only.
    const scope = scopeForTab(tab?.id);
    abortCurrentWork(scope);
    cancelTask(scope);
    await runRequest(query, tab?.id);
  })().catch(error => console.error('[ECHO] Address bar request failed:', error));
});

// 1x1 PNG data URI so chrome.notifications (type 'basic' requires an icon)
// never fails for lack of a packaged icon file.
const NOTIF_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Alarms: scheduled reminders AND page watchers land here.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith(WATCH_ALARM_PREFIX)) {
    await runWatcherCheck(alarm.name).catch(() => {});
    return;
  }
  if (!alarm.name.startsWith('echo_reminder_')) return;
  const { echo_reminders } = await chrome.storage.local.get(['echo_reminders']);
  const reminders = (echo_reminders || {}) as Record<string, any>;
  const reminder = reminders[alarm.name];
  if (!reminder) return;
  chrome.notifications.create(alarm.name, {
    type: 'basic',
    iconUrl: NOTIF_ICON,
    title: 'ECHO Reminder',
    message: reminder.taskName ? `${reminder.message}\n(Click to run: ${reminder.taskName})` : reminder.message,
    priority: 2
  });
});

// Clicking a notification: reminders run their task, watchers open their page.
chrome.notifications.onClicked.addListener(async (notificationId) => {
  chrome.notifications.clear(notificationId);

  if (notificationId.startsWith(WATCH_ALARM_PREFIX)) {
    const watchers = await listWatchers();
    const w = watchers[notificationId];
    if (w?.url) chrome.tabs.create({ url: w.url });
    return;
  }

  const { echo_reminders, echo_tasks } = await chrome.storage.local.get(['echo_reminders', 'echo_tasks']);
  const reminder = ((echo_reminders || {}) as Record<string, any>)[notificationId];
  if (reminder?.taskName) {
    const instructions = ((echo_tasks || {}) as Record<string, string>)[reminder.taskName];
    if (instructions) {
      await openSidePanel();
      runRequest(`Now carry out this saved task step by step:\n${instructions}`).catch(() => {});
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (['ECHO_PRIVACY_STATUS', 'ECHO_DOCTOR', 'ECHO_ALLOW_SITE', 'ECHO_FORGET_SITE',
    'ECHO_CLEAR_KB', 'ECHO_CLEAR_CACHE', 'ECHO_DELETE_MEMORY', 'ECHO_EXPORT_DATA',
    'EXECUTE_TOOL', 'ECHO_SET_SETTINGS', 'ECHO_CLEAR_ALL_DATA', ...TRUSTED_ONLY].includes(message.type) && !trustedPage(sender)) {
    sendResponse({ success: false, error: 'Extension page required.' });
    return false;
  }

  if (message.type === 'ECHO_CONTENT_PREFS') {
    (async () => {
      const [settings, saved] = await Promise.all([
        getSettings(), chrome.storage.local.get(['echo_handsfree', 'echo_speech_language', 'echo_position', 'echo_avatar']),
      ]);
      await leasesReady;   // the tab's avatar, if one is assigned
      let siteAllowed = false;
      try { siteAllowed = domainAllowed(new URL(sender.tab?.url || '').hostname, settings.allowedDomains); }
      catch { /* no page context */ }
      return { success: true, autoIndex: settings.autoIndex, siteAllowed,
        passiveSuggest: settings.passiveSuggest, handsfree: !!saved.echo_handsfree,
        language: String(saved.echo_speech_language || 'en-US'), position: saved.echo_position,
        avatar: avatarForTab(sender.tab?.id, saved.echo_avatar) };
    })().then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_SET_POSITION') {
    const p = message.position;
    if (!sender.tab || !Number.isFinite(p?.x) || !Number.isFinite(p?.y)) {
      sendResponse({ success: false }); return false;
    }
    const position = { x: Math.max(0, Math.min(10000, p.x)), y: Math.max(0, Math.min(10000, p.y)) };
    chrome.storage.local.set({ echo_position: position })
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_SUGGESTION_COOLDOWN') {
    (async () => {
      const { echo_suggest_shown } = await chrome.storage.local.get(['echo_suggest_shown']);
      if (message.mark === true && Date.now() - Number(echo_suggest_shown || 0) >= 600000) {
        await chrome.storage.local.set({ echo_suggest_shown: Date.now() });
        return { recentlyShown: false };
      }
      return { recentlyShown: Date.now() - Number(echo_suggest_shown || 0) < 600000 };
    })().then(sendResponse).catch(() => sendResponse({ recentlyShown: true }));
    return true;
  }

  if (message.type === 'CHECK_AWAKE_STATE') {
    wakeStateReady.then(() => sendResponse({ isAwake: isEchoAwake }));
    return true;
  }

  if (message.type === 'WAKE_ECHO_REQUEST') {
    wakeStateReady.then(async () => {
      isEchoAwake = true;
      await chrome.storage.session.set({ isEchoAwake });
      await broadcastWakeState();
      sendResponse({ success: true });
    }).catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'EXECUTE_TOOL') {
    executeTool(message.toolName, message.args, sender.tab?.id)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // Every user request now enters through the router, which spends the
  // cheapest tier that can answer it and only reaches the cloud when needed.
  if (message.type === 'USER_INPUT') {
    // Attachments, private browsing, forced search and addressing an avatar only
    // come from ECHO's own pages; the in-page box (which a web page can see)
    // only sends text, and speaks for whoever owns its tab.
    const opts: RequestOptions = trustedPage(sender) ? {
      tabs: Array.isArray(message.tabs) ? message.tabs.map(Number).filter(Number.isInteger) : undefined,
      webSearch: message.webSearch === true,
      isolated: message.isolated === true,
      agent: isAgentId(message.agent) ? message.agent : undefined,
    } : {};
    (async () => {
      await leasesReady;
      // A new request replaces the previous one in the same scope only.
      const scope = requestScope(sender.tab?.id, opts.agent);
      abortCurrentWork(scope);
      cancelTask(scope);
      await runRequest(String(message.text || ''), sender.tab?.id, opts);
    })().catch(error => {
      say(sender.tab?.id, `Request could not start: ${error?.message || 'unknown error'}`);
    });
    sendResponse({ success: true });
    return false;
  }

  // Escape hatch: force the cloud brain, bypassing tiers 0-2.
  if (message.type === 'USER_INPUT_CLOUD') {
    (async () => {
      await leasesReady;
      const scope = scopeForTab(sender.tab?.id);
      abortCurrentWork(scope);
      cancelTask(scope);
      await runRequest(String(message.text || ''), sender.tab?.id, { cloudOnly: true });
    })().catch(error => {
      say(sender.tab?.id, `Request could not start: ${error?.message || 'unknown error'}`);
    });
    sendResponse({ success: true });
    return false;
  }

  // Stop: the page's orb stops whoever owns its tab; the side panel names a scope.
  if (message.type === 'ECHO_ABORT') {
    const agent = trustedPage(sender) && (isAgentId(message.agent) || message.agent === DEFAULT_SCOPE) ? message.agent : undefined;
    leasesReady.then(() => {
      const scope = requestScope(sender.tab?.id, agent);
      stopScope(scope);
      setState(scope === DEFAULT_SCOPE ? sender.tab?.id : leaseFor(scope)?.tabId, 'Idle');
    }).catch(() => {});
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'ECHO_CLEAR_CONVERSATION') {
    cancelTask(DEFAULT_SCOPE);
    clearCloudConversation(DEFAULT_SCOPE);
    cancelActiveTask(DEFAULT_SCOPE).catch(() => {});
    Promise.all([clearTranscript(), cacheClear()])
      .then(async () => {
        chrome.runtime.sendMessage({ type: 'ECHO_CONVERSATION_CLEARED' }).catch(() => {});
        await broadcastChatState(await chatState());
        sendResponse({ success: true });
      })
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // Answers never come from a content script: the in-page UI lives in the
  // page's DOM, where page scripts could click it. Only the extension-origin
  // approval frame (in the prompt's own tab) or the side panel may answer.
  if (message.type === 'ECHO_APPROVAL_RESPONSE') {
    const id = String(message.id || '');
    if (trustedPage(sender)) {
      sendResponse({ success: settleApproval(id, message.approved === true) });
    } else if (fromApprovalFrame(sender) && sender.tab?.id != null) {
      sendResponse({ success: settleApproval(id, message.approved === true, sender.tab.id) });
    } else {
      sendResponse({ success: false, error: 'Approvals must come from ECHO\'s own prompt.' });
    }
    return false;
  }

  if (message.type === 'ECHO_APPROVAL_DETAILS') {
    const prompt = approvalById(String(message.id || ''));
    const ok = !!prompt && fromApprovalFrame(sender) && sender.tab?.id != null && sender.tab.id === prompt.tabId;
    sendResponse(ok ? { success: true, approval: prompt } : { success: false });
    return false;
  }

  if (message.type === 'ECHO_PENDING_APPROVAL') {
    sendResponse({ success: true, approval: pendingApproval(sender.tab?.id) });
    return false;
  }

  if (message.type === 'ECHO_TASK_STATUS_REQUEST') {
    const scope = typeof message.agent === 'string' ? message.agent : undefined;
    taskStatus(scope).then(status => sendResponse({ success: true, ...status }))
      .catch(() => sendResponse({ success: false, active: false }));
    return true;
  }

  // --- OpenClaw gateway settings ----------------------------------------------------

  if (message.type === 'ECHO_OPENCLAW_STATUS') {
    openClawStatus().then(status => sendResponse({ success: true, status }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_OPENCLAW_SAVE') {
    const patch: Record<string, unknown> = {};
    if (typeof message.enabled === 'boolean') patch.enabled = message.enabled;
    if (typeof message.url === 'string') patch.url = message.url.trim();
    if (typeof message.sharedToken === 'string') patch.sharedToken = message.sharedToken.trim();
    saveOpenClawSettings(patch).then(openClawStatus).then(status => sendResponse({ success: true, status }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_OPENCLAW_SETUP_SCRIPT') {
    sendResponse({ success: true, script: setupScript(chrome.runtime.id, chrome.runtime.getManifest().version) });
    return false;
  }

  // --- avatars on tabs ----------------------------------------------------------

  if (message.type === 'ECHO_AGENT_LIST') {
    leasesReady.then(agentList).then(agents => sendResponse({ success: true, agents }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_AGENT_ASSIGN') {
    (async () => {
      if (!isAgentId(message.agent)) throw new Error('Unknown avatar.');
      let tabId = Number(message.tabId);
      if (!Number.isInteger(tabId)) {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.id == null) throw new Error('No tab to assign.');
        tabId = tab.id;
      }
      // A fresh assignment starts a fresh conversation and thread.
      clearCloudConversation(message.agent);
      await clearAgentThread(message.agent);
      const lease = await assignLease(message.agent, tabId);
      return { success: true, lease, agents: await agentList() };
    })().then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_AGENT_RELEASE') {
    (async () => {
      if (!isAgentId(message.agent)) throw new Error('Unknown avatar.');
      await releaseLease(message.agent);
      return { success: true, agents: await agentList() };
    })().then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_AGENT_THREAD') {
    if (!isAgentId(message.agent)) { sendResponse({ success: false, error: 'Unknown avatar.' }); return false; }
    agentThread(message.agent).then(messages => sendResponse({ success: true, messages }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_SPEECH_CONTROL' && sender.tab?.id) {
    const channel = String(message.channel || '');
    if (!/^[a-f0-9-]{36}$/.test(channel)) { sendResponse({ success: false }); return false; }
    speechTabs.set(channel, sender.tab.id);
    chrome.runtime.sendMessage({ type: 'ECHO_SPEECH_CONTROL_DELIVER', channel,
      command: message.command === 'stop' ? 'stop' : 'start', language: String(message.language || 'en-US') })
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_SPEECH_EVENT' && sender.url?.startsWith(chrome.runtime.getURL('speech.html'))) {
    const tabId = speechTabs.get(String(message.channel || ''));
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, { type: 'ECHO_SPEECH_EVENT_DELIVER', event: message.event,
        text: message.text, error: message.error }).catch(() => {});
      sendResponse({ success: true });
    } else sendResponse({ success: false });
    return false;
  }

  if (message.type === 'ECHO_RECORD_STATUS') {
    resumeRecordingForTab(sender.tab?.id || -1)
      .then(active => sendResponse({ success: true, active }))
      .catch(() => sendResponse({ success: false, active: false }));
    return true;
  }

  if (message.type === 'ECHO_RECORD_STEP') {
    appendRecordedStep(sender.tab?.id || -1, message.step)
      .then(saved => sendResponse({ success: saved }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (message.type === 'ECHO_PRIVACY_STATUS') {
    (async () => {
      const settings = await getSettings();
      let url = typeof message.url === 'string' ? message.url : '';
      if (!url) url = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url || '';
      let host = '';
      try { if (/^https?:/i.test(url)) host = new URL(url).hostname.toLowerCase(); } catch { /* restricted tab */ }
      const { echo_memory } = await chrome.storage.local.get(['echo_memory']);
      return { success: true, host, allowedDomains: settings.allowedDomains, siteAllowed: !!host && domainAllowed(host, settings.allowedDomains), autoIndex: settings.autoIndex,
        siteEligible: isIndexable(url), pages: await kbSize(),
        memory: (echo_memory || {}) as Record<string, string> };
    })().then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_DOCTOR') {
    runDoctor().then(report => sendResponse({ success: true, report }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_ALLOW_SITE') {
    (async () => {
      const { host, url } = await targetSite(message);
      if (!isIndexable(url)) throw new Error('This site is excluded to protect private data.');
      const settings = await getSettings();
      await setSettings({ autoIndex: true, allowedDomains: [...settings.allowedDomains, host] });
      return { success: true, host };
    })().then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_FORGET_SITE') {
    (async () => {
      const { host } = await targetSite(message);
      const settings = await getSettings();
      await setSettings({ allowedDomains: settings.allowedDomains.filter(d => !sameSite(d, host)) });
      const removed = await forgetSite(host);
      const highlights = await forgetHighlightsForHost(host);
      await cacheClear();
      return { success: true, host, removed, highlights };
    })().then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_CLEAR_KB') {
    clearKB().then(() => sendResponse({ success: true })).catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_CLEAR_CACHE') {
    cacheClear().then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_DELETE_MEMORY') {
    (async () => {
      if (!await deleteMemory(String(message.key || ''))) return { success: false, error: 'Memory not found.' };
      await memoryChanged();
      return { success: true };
    })().then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_MEMORY_SAVE') {
    (async () => {
      const key = await setMemory(String(message.key || ''), String(message.value || ''));
      if (message.previousKey && message.previousKey !== key) await deleteMemory(String(message.previousKey));
      await memoryChanged();
      return { success: true, key };
    })().then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_MEMORY_CLEAR') {
    clearMemories().then(memoryChanged).then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // --- chat history ----------------------------------------------------------

  if (message.type === 'ECHO_CHAT_STATE_REQUEST') {
    chatState().then(state => sendResponse({ success: true, state }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_CHAT_LIST') {
    listChats().then(chats => sendResponse({ success: true, chats }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_CHAT_NEW') {
    cancelTask(DEFAULT_SCOPE);
    clearCloudConversation(DEFAULT_SCOPE);
    cancelActiveTask(DEFAULT_SCOPE).catch(() => {});
    newChat(message.temporary === true)
      .then(async state => { await broadcastChatState(state); sendResponse({ success: true, state }); })
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_CHAT_OPEN') {
    cancelTask(DEFAULT_SCOPE);
    clearCloudConversation(DEFAULT_SCOPE);
    cancelActiveTask(DEFAULT_SCOPE).catch(() => {});
    openChat(String(message.id || ''))
      .then(async state => {
        seedCloudConversation(state.messages);
        await broadcastChatState(state);
        sendResponse({ success: true, state });
      })
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_CHAT_DELETE') {
    (async () => {
      if (await deleteChat(String(message.id || ''))) {
        clearCloudConversation(DEFAULT_SCOPE);
        await broadcastChatState(await chatState());
      }
      return { success: true, chats: await listChats() };
    })().then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_CHAT_DELETE_ALL') {
    (async () => {
      cancelTask(DEFAULT_SCOPE);
      clearCloudConversation(DEFAULT_SCOPE);
      await deleteAllChats();
      await broadcastChatState(await newChat(await isTemporaryChat()));
      return { success: true };
    })().then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // --- skills ------------------------------------------------------------------

  if (message.type === 'ECHO_SKILLS_LIST') {
    listSkills().then(skills => sendResponse({ success: true, skills }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_SKILL_SAVE') {
    saveSkill(message.skill).then(skill => sendResponse({ success: true, skill }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_SKILL_DELETE') {
    deleteSkill(String(message.id || '')).then(removed => sendResponse({ success: removed }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_SKILLS_RESET') {
    resetSkills().then(skills => sendResponse({ success: true, skills }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // --- isolated agent browsing ----------------------------------------------

  if (message.type === 'ECHO_ISOLATION_STATUS') {
    Promise.all([isolationAllowed(), isolatedWindowId()])
      .then(([allowed, windowId]) => sendResponse({ success: true, allowed, open: windowId != null }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_ISOLATION_CLOSE') {
    closeIsolatedWindow().then(closed => sendResponse({ success: true, closed }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_OPEN_EXTENSION_DETAILS') {
    chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_EXPORT_DATA') {
    (async () => {
      const local = await chrome.storage.local.get(['echo_memory', 'echo_memory_enabled', 'echo_profile', 'echo_skills',
        'echo_workflows', 'echo_watchers', 'echo_tasks', 'echo_reminders', 'echo_action_log', 'echo_local_settings',
        'echo_handsfree', 'echo_speech_language', 'echo_position', 'echo_avatar', 'provider', 'anthropicModel',
        'geminiModel', 'groqModel', 'togetherModel', 'openrouterModel']);
      return { success: true, data: { exportedAt: new Date().toISOString(), ...local, chats: await exportChats(),
        pages: await recentPages(600), highlights: await allHighlights(), cachedAnswers: await idbGetAll(STORE_CACHE, 400) } };
    })().then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_CLEAR_ALL_DATA') {
    (async () => {
      cancelTask();
      clearAllConversations();
      await cancelActiveTask();
      await releaseAllLeases();
      await cancelRecording();
      await closeIsolatedWindow();
      await Promise.all([clearKB(), cacheClear(), clearHighlights()]);
      await chrome.alarms.clearAll();
      const notifications = await chrome.notifications.getAll();
      await Promise.all(Object.keys(notifications).map(id => chrome.notifications.clear(id)));
      await chrome.storage.session.clear();
      await chrome.storage.local.clear();
      speechTabs.clear();
      isEchoAwake = false;
      await broadcastWakeState();
      chrome.runtime.sendMessage({ type: 'ECHO_CONVERSATION_CLEARED' }).catch(() => {});
      await broadcastChatState(await chatState());
      return { success: true };
    })().then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // --- local stack plumbing ------------------------------------------------

  if (message.type === 'ECHO_INDEX_PAGE') {
    if (!samePage(message.url, sender) || sender.tab?.incognito) { sendResponse({ success: false }); return false; }
    ingestPage(message.url, message.title, message.text).catch(() => {});
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'ECHO_SAVE_HIGHLIGHT') {
    if (sender.tab && (!samePage(message.url, sender) || sender.tab.incognito)) { sendResponse({ success: false }); return false; }
    saveHighlight(message.url, message.title, message.text)
      .then(h => sendResponse({ success: true, id: h.id }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (message.type === 'ECHO_GET_HIGHLIGHTS') {
    if (!samePage(message.url, sender)) { sendResponse({ success: false, texts: [] }); return false; }
    highlightsForUrl(message.url)
      .then(list => sendResponse({ success: true, texts: list.map(h => h.text) }))
      .catch(() => sendResponse({ success: true, texts: [] }));
    return true;
  }

  if (message.type === 'ECHO_GET_SETTINGS') {
    getSettings().then(s => sendResponse({ success: true, settings: s }));
    return true;
  }

  if (message.type === 'ECHO_SET_SETTINGS') {
    setSettings(message.patch || {}).then(s => sendResponse({ success: true, settings: s }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.type === 'ECHO_ROUTER_REPORT') {
    routerReport().then(text => sendResponse({ success: true, text }));
    return true;
  }

  if (message.type === 'ECHO_SYNC_POSITION') {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        if (tab.id && tab.id !== sender.tab?.id) {
          chrome.tabs.sendMessage(tab.id, { type: 'ECHO_SYNC_POSITION', position: message.position }).catch(() => {});
        }
      });
    });
    sendResponse({ success: true });
    return false;
  }
});
