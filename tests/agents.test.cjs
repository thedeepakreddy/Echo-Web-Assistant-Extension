const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { webcrypto } = require('node:crypto');

// Loads a TypeScript module with its imports resolved from `modules` by path
// suffix (e.g. 'agents/leases'), so real modules can be wired together.
function loadTs(file, globals = {}, modules = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const require = spec => {
    const key = Object.keys(modules).find(k => spec.endsWith(k));
    return key ? modules[key] : {};
  };
  vm.runInNewContext(js, { exports, require, console, URL, Date, Map, Set, JSON, Promise, Math, Number, String,
    Array, Object, Error, setTimeout, clearTimeout, setInterval, clearInterval, crypto: webcrypto, ...globals },
    { filename: file });
  return exports;
}

// Values made inside the vm sandbox have its own Array/Object prototypes.
const plain = v => JSON.parse(JSON.stringify(v));

/** A fake chrome: storage areas, tabs with ids/urls, and recorded tab updates. */
function fakeChrome(tabs = {}) {
  const area = map => ({
    get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => map.has(k)).map(k => [k, map.get(k)])),
    set: async data => Object.entries(data).forEach(([k, v]) => map.set(k, JSON.parse(JSON.stringify(v)))),
    remove: async keys => (Array.isArray(keys) ? keys : [keys]).forEach(k => map.delete(k)),
  });
  const session = new Map();
  const local = new Map();
  const updates = [];
  const sent = [];
  return {
    session, local, updates, sent,
    storage: { session: area(session), local: area(local), onChanged: { addListener: () => {} } },
    tabs: {
      get: (id, cb) => {
        const tab = tabs[id] ? { id, status: 'complete', ...tabs[id] } : null;
        if (cb) { cb(tab); return undefined; }
        return tab ? Promise.resolve(tab) : Promise.reject(new Error('No tab'));
      },
      update: async (id, props) => { updates.push([id, props]); return { id }; },
      query: (q, cb) => { const list = Object.entries(tabs).map(([id, t]) => ({ id: Number(id), ...t })); if (cb) cb(list); return Promise.resolve(list); },
      create: (props, cb) => { const id = 900 + Object.keys(tabs).length; tabs[id] = { url: props.url }; cb({ id, url: props.url }); },
      sendMessage: async () => ({}),
    },
    runtime: { sendMessage: async msg => { sent.push(msg); }, getPlatformInfo: async () => ({}), lastError: null },
  };
}

const characters = { CHARACTERS: [{ id: 'echo' }, { id: 'echo-analyst' }, { id: 'echo-style' }], REACTOR: 'reactor' };
const loadLeases = chrome => loadTs('src/background/agents/leases.ts', { chrome }, { characters });

const WEB = { url: 'https://example.com/', incognito: false };

test('leases: one avatar per tab, one tab per avatar, reassignment moves the avatar', async () => {
  const chrome = fakeChrome({ 1: WEB, 2: WEB, 3: { url: 'chrome://settings' }, 4: { ...WEB, incognito: true } });
  const leases = loadLeases(chrome);
  await leases.leasesReady;
  const changes = [];
  leases.onLeaseChange(c => changes.push([c.agent, c.lease?.tabId ?? null, c.previous?.tabId ?? null]));

  const a = await leases.assignLease('echo-analyst', 1);
  assert.equal(a.tabId, 1);
  assert.equal(leases.scopeForTab(1), 'echo-analyst');
  assert.equal(leases.scopeForTab(2), 'default');
  await assert.rejects(leases.assignLease('echo-style', 1), /already belongs/);
  await assert.rejects(leases.assignLease('echo-style', 3), /regular web page/);
  await assert.rejects(leases.assignLease('echo-style', 4), /private windows/);
  await assert.rejects(leases.assignLease('nobody', 2), /Unknown avatar/);

  // Reassigning the analyst to tab 2 frees tab 1.
  await leases.assignLease('echo-analyst', 2);
  assert.equal(leases.scopeForTab(1), 'default');
  assert.equal(leases.scopeForTab(2), 'echo-analyst');
  assert.deepEqual(changes, [['echo-analyst', 1, null], ['echo-analyst', 2, 1]]);
  // The held tab is protected from Chrome's memory saver, the freed one is not.
  assert.deepEqual(plain(chrome.updates.slice(-2)), [[2, { autoDiscardable: false }], [1, { autoDiscardable: true }]]);
  // Leases persist in session storage.
  assert.equal(chrome.session.get('echo_agent_leases')['echo-analyst'].tabId, 2);
});

test('leases: tabs an avatar opens are its own; closing its tab ends the lease', async () => {
  const chrome = fakeChrome({ 1: WEB, 2: WEB, 3: WEB });
  const leases = loadLeases(chrome);
  await leases.assignLease('echo-style', 1);
  await leases.adoptChildTab('echo-style', 3);
  assert.equal(leases.scopeForTab(3), 'echo-style');
  assert.equal(leases.tabAccessible('echo-style', 3), true);
  assert.equal(leases.tabAccessible('echo-style', 2), false, 'an avatar cannot reach an unassigned tab');
  assert.equal(leases.tabAccessible('default', 3), false, 'classic ECHO leaves avatar tabs alone');
  assert.equal(leases.tabAccessible('default', 2), true);

  await leases.forgetTab(3);                      // a child closes: lease stays
  assert.equal(leases.leaseFor('echo-style').children.length, 0);
  assert.notEqual(leases.leaseFor('echo-style'), null);
  const released = await leases.forgetTab(1);     // its own tab closes: lease ends
  assert.equal(released.agent, 'echo-style');
  assert.equal(leases.leaseFor('echo-style'), null);
});

test('safety: stopping one scope leaves the other scope\'s actions and approvals alone', async () => {
  const chrome = fakeChrome({ 1: WEB, 2: WEB });
  const leases = loadLeases(chrome);
  await leases.assignLease('echo-analyst', 1);
  await leases.assignLease('echo-style', 2);
  const safety = loadTs('src/background/safety.ts', { chrome }, { 'agents/leases': leases });

  const analystBefore = safety.currentTaskEpoch(1);
  const styleBefore = safety.currentTaskEpoch(2);
  const analystApproval = safety.requestApproval('click_element', 'Send: reply', 1);
  const styleApproval = safety.requestApproval('click_element', 'Payment: buy', 2);
  safety.cancelTask('echo-analyst');
  assert.notEqual(safety.currentTaskEpoch(1), analystBefore);
  assert.equal(safety.currentTaskEpoch(2), styleBefore);
  assert.equal(await analystApproval, false, 'the stopped avatar\'s approval is denied');
  assert.ok(safety.pendingApproval(2), 'the other avatar is still waiting for the user');
  safety.settleApproval(safety.pendingApproval(2).id, true);
  assert.equal(await styleApproval, true);
});

test('tools: an avatar cannot switch to, close or list another avatar\'s tab; opened tabs join its lease', async () => {
  const chrome = fakeChrome({ 1: WEB, 2: WEB, 5: WEB });
  const leases = loadLeases(chrome);
  await leases.assignLease('echo-analyst', 1);
  await leases.assignLease('echo-style', 2);
  const safety = { currentTaskEpoch: () => 0, logAction: async () => {}, safeNavigationUrl: u => u, requestApproval: async () => true,
    sensitiveAction: () => null };
  const isolation = { agentScope: () => null, assertInScope: async () => {}, assertIsolatedUrl: () => {} };
  const tools = loadTs('src/background/tools.ts', { chrome }, { 'agents/leases': leases, './safety': safety, './isolation': isolation,
    './response-cache': {} });

  await assert.rejects(tools.executeTool('switch_tab', { tabId: 2 }, 1), /your own tab/);
  await assert.rejects(tools.executeTool('close_tab', { tabId: 2 }, 1), /your own tab/);
  await assert.rejects(tools.executeTool('switch_tab', { tabId: 1 }, 5), /assigned to an ECHO avatar/);
  const listed = await tools.executeTool('list_tabs', {}, 1);
  assert.deepEqual(plain(listed.tabs.map(t => t.id)), [1]);
  const byDefault = await tools.executeTool('list_tabs', {}, 5);
  assert.deepEqual(plain(byDefault.tabs.map(t => t.id)), [5]);

  const opened = await tools.executeTool('open_url', { url: 'https://news.example/' }, 1);
  assert.equal(leases.scopeForTab(opened.newTabId), 'echo-analyst');
});

test('tasks: avatars run side by side and stop independently', async () => {
  const chrome = fakeChrome();
  const tasks = loadTs('src/background/task-state.ts', { chrome }, { 'agents/leases': { DEFAULT_SCOPE: 'default' } });
  const a = await tasks.beginTask(1, 'echo-analyst');
  await tasks.beginTask(2, 'echo-style');
  assert.deepEqual(plain(tasks.runningScopes().sort()), ['echo-analyst', 'echo-style']);
  await tasks.cancelActiveTask('echo-style');
  assert.deepEqual(plain(tasks.runningScopes()), ['echo-analyst']);
  assert.equal((await tasks.taskStatus('echo-style')).active, false);
  assert.equal((await tasks.taskStatus('echo-analyst')).active, true);
  assert.equal(await tasks.finishTask(a), true);
  assert.equal(await tasks.finishTask(a), false, 'a task finishes once');
  assert.equal((await tasks.taskStatus()).active, false);
  // Status messages name the scope, so the panel updates the right thread.
  assert.ok(chrome.sent.some(m => m.type === 'ECHO_TASK_STATUS' && m.agent === 'echo-style' && m.active === false));
});

test('tasks: a restarted worker reports every interrupted task', async () => {
  const chrome = fakeChrome();
  const tasks = loadTs('src/background/task-state.ts', { chrome }, { 'agents/leases': { DEFAULT_SCOPE: 'default' } });
  await tasks.beginTask(1, 'echo-analyst');
  await tasks.beginTask(undefined, 'default');
  const fresh = loadTs('src/background/task-state.ts', { chrome }, { 'agents/leases': { DEFAULT_SCOPE: 'default' } });
  const interrupted = await fresh.recoverInterruptedTasks();
  assert.deepEqual(plain(interrupted.map(t => t.scope).sort()), ['default', 'echo-analyst']);
  assert.deepEqual(plain(await fresh.recoverInterruptedTasks()), [], 'reported once');
  await tasks.cancelActiveTask();   // ends the first worker's keepalive timer
});

test('chats: an avatar\'s messages go to its own thread, not the saved chat', async () => {
  const chrome = fakeChrome();
  const chats = loadTs('src/background/chats.ts', { chrome }, { 'agents/leases': { DEFAULT_SCOPE: 'default' } });
  chats.appendEntry({ role: 'user', text: 'compare laptops', agent: 'echo-analyst' });
  chats.appendEntry({ role: 'echo', text: 'Here is the comparison', agent: 'echo-analyst' });
  chats.appendEntry({ role: 'user', text: 'hello', agent: 'default' });
  assert.deepEqual(plain((await chats.agentThread('echo-analyst')).map(m => m.text)), ['compare laptops', 'Here is the comparison']);
  assert.deepEqual(plain((await chats.chatState()).messages.map(m => m.text)), ['hello']);
  await chats.clearAgentThread('echo-analyst');
  assert.deepEqual(plain(await chats.agentThread('echo-analyst')), []);
});

test('approvals: a denied payment is not asked again in the same task, and the agent is told why', async () => {
  const chrome = fakeChrome({ 1: { url: 'https://shop.example/checkout' } });
  const clicks = [];
  chrome.tabs.sendMessage = (tabId, msg, cb) => {
    const reply = msg.action === 'inspect_action' ? { success: true, result: { label: '<button> "Place order"', sensitive: false } }
      : msg.type !== 'DOM_ACTION' ? {} : (clicks.push(msg.action), { success: true, result: 'Clicked' });
    if (cb) { cb(reply); return undefined; }
    return Promise.resolve(reply);
  };
  const leases = loadLeases(chrome);
  await leases.assignLease('echo-analyst', 1);
  // Approval prompts time out at once here.
  const fastTimers = { setTimeout: fn => setTimeout(fn, 5), clearTimeout };
  const safety = loadTs('src/background/safety.ts', { chrome, ...fastTimers }, { 'agents/leases': leases });
  const isolation = { agentScope: () => null, assertInScope: async () => {}, assertIsolatedUrl: () => {} };
  const tools = loadTs('src/background/tools.ts', { chrome }, { 'agents/leases': leases, './safety': safety, './isolation': isolation, './response-cache': {} });
  const click = () => tools.executeTool('click_element', { ref: 'e1' }, 1, { deadline: Date.now() + 30_000 });
  const answer = async approved => { for (let i = 0; i < 50 && !safety.pendingApproval(1); i++) await new Promise(r => setTimeout(r, 1)); safety.settleApproval(safety.pendingApproval(1).id, approved); };

  // Without an answer the prompt times out: ask in chat first.
  const unanswered = click();
  await assert.rejects(unanswered, /did not answer the approval in time/);
  // Denied: say so, and do not ask again for the same action in this task.
  const denied = click();
  await answer(false);
  await assert.rejects(denied, /The user denied this action/);
  await assert.rejects(click(), /already denied this action in this task/);
  assert.equal(safety.pendingApproval(1), null, 'no second prompt');
  assert.deepEqual(clicks, [], 'nothing was clicked');
  // A new task (after a stop) may ask again; allowed, the click happens.
  safety.cancelTask('echo-analyst');
  const allowed = click();
  await answer(true);
  assert.equal(await allowed, 'Clicked');
  assert.deepEqual(clicks, ['click_element']);
});

test('approvals: going to the checkout page does not ask; paying there does', () => {
  const chrome = fakeChrome();
  const safety = loadTs('src/background/safety.ts', { chrome }, { 'agents/leases': { DEFAULT_SCOPE: 'default', scopeForTab: () => 'default' } });
  const click = (label, url = 'https://shop.example/cart') => safety.sensitiveAction({ tool: 'click_element', label, url });
  assert.equal(click('<a> "Checkout"'), null);
  assert.equal(click('<button> "Proceed to checkout"'), null);
  assert.equal(click('<button> "Place order"'), 'payment');
  assert.equal(click('<button> "Buy now"'), 'payment');
  assert.equal(click('<button> "Checkout"', 'https://shop.example/checkout'), 'payment', 'on the checkout page itself, it pays');
  assert.equal(click('<button> "Continue"', 'https://shop.example/checkout/review'), 'payment');
});
