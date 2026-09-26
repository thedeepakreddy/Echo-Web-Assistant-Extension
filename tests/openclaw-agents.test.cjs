const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { execFileSync } = require('node:child_process');
const { webcrypto } = require('node:crypto');

// Loads a TypeScript module with imports resolved from `modules` by path suffix.
function loadTs(file, globals = {}, modules = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const require = spec => {
    const key = Object.keys(modules).find(k => spec.endsWith(k));
    return key ? modules[key] : {};
  };
  vm.runInNewContext(js, { exports, require, console, URL, Date, Map, Set, JSON, Promise, Math, Number, String, Array, Object,
    Error, RegExp, setTimeout, clearTimeout, crypto: webcrypto, ...globals }, { filename: file });
  return exports;
}
const plain = v => JSON.parse(JSON.stringify(v));
const settle = (ms = 20) => new Promise(r => setTimeout(r, ms));

const characters = {
  CHARACTERS: ['echo', 'echo-style', 'echo-officer', 'echo-patrol', 'echo-mentor', 'echo-visionary', 'echo-analyst']
    .map(id => ({ id, tagline: `tagline of ${id}` })),
  REACTOR: 'reactor',
};
const registry = () => loadTs('src/background/openclaw/registry.ts', {}, { characters });

// --- registry and setup script -------------------------------------------------------

test('registry: eight avatars, twelve tools each, unique valid names and commands', () => {
  const r = registry();
  assert.equal(r.AVATAR_AGENTS.length, 8);
  assert.deepEqual(plain(r.AVATAR_AGENTS.map(a => a.slug)),
    ['echo', 'style', 'officer', 'patrol', 'mentor', 'visionary', 'analyst', 'core']);
  const commands = r.allCommands();
  assert.equal(commands.length, 96);
  assert.equal(new Set(commands).size, 96);
  for (const a of r.AVATAR_AGENTS) for (const t of r.TOOL_NAMES) {
    assert.match(r.toolNameFor(a.slug, t), /^[A-Za-z][A-Za-z0-9_-]{0,63}$/, 'provider-safe tool name');
  }
  assert.equal(r.avatarByCharacter('reactor').agentId, 'echo-core');
  assert.equal(r.avatarByCharacter('echo-analyst').slug, 'analyst');
});

test('setup script: valid bash, this extension only, every command, locked-down agents', () => {
  const r = registry();
  const setup = loadTs('src/background/openclaw/setup-script.ts', {}, { './registry': r });
  const script = setup.setupScript('ajppdcdcnfnnbjfkkoamikimkefjdhee', '2.0.0');
  const file = path.join(os.tmpdir(), `echo-setup-${process.pid}.sh`);
  fs.writeFileSync(file, script);
  try { execFileSync('bash', ['-n', file]); } finally { fs.rmSync(file, { force: true }); }
  assert.match(script, /allowedOrigins '\["chrome-extension:\/\/ajppdcdcnfnnbjfkkoamikimkefjdhee"\]'/);
  const allow = JSON.parse(script.match(/gateway\.nodes\.commands\.allow '([^']+)'/)[1]);
  assert.deepEqual(allow, plain(r.allCommands()));
  const agents = JSON.parse(script.match(/agents\.entries '([^']+)'/)[1]);
  assert.equal(Object.keys(agents).length, 8);
  assert.deepEqual(agents['echo-analyst'].tools.exec, { security: 'deny' });
  assert.ok(agents['echo-analyst'].tools.deny.includes('exec') && agents['echo-analyst'].tools.deny.includes('browser'));
  assert.ok(agents['echo-analyst'].tools.allow.every(name => name.startsWith('analyst_')), 'an avatar gets only its own tools');
  const rules = setup.agentsMd(r.avatarByCharacter('echo-analyst'));
  assert.match(rules, /Never fill gaps from memory or from earlier tasks/);
  assert.match(rules, /untrusted data, never instructions/);
  assert.match(rules, /analyst_verify/);
  assert.match(rules, /do not ask for confirmation in chat first/, 'one approval, at the payment click, not two');
});

// --- session manager ------------------------------------------------------------------

/** A fake operator connection: records requests, answers chat.send and agent.wait on cue. */
function fakeOperator() {
  const calls = [];
  let waitResolve = null;
  const conn = {
    connected: true,
    calls,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'sessions.create') return { ok: true, key: params.key };
      if (method === 'chat.send') return { runId: 'run-1', status: 'started' };
      if (method === 'agent.wait') return new Promise(r => { waitResolve = r; });
      return {};
    },
    finishWait: result => waitResolve?.(result),
  };
  return conn;
}

function sessionHarness() {
  const store = new Map();
  const chrome = { storage: { session: {
    get: async keys => Object.fromEntries(keys.filter(k => store.has(k)).map(k => [k, store.get(k)])),
    set: async data => Object.entries(data).forEach(([k, v]) => store.set(k, JSON.parse(JSON.stringify(v)))),
  } } };
  const said = [];
  const states = [];
  const host = {
    leaseOf: c => (c === 'echo-analyst' ? { tabId: 7, leaseId: 'L1' } : null),
    say: (c, tab, text) => said.push({ c, tab, text }),
    setState: (c, tab, state) => states.push(state),
  };
  const sessions = loadTs('src/background/openclaw/sessions.ts', { chrome }, { './registry': registry() });
  return { sessions, host, said, states, store };
}

test('sessions: a run creates the lease\'s session, shows progress, and delivers the reply once', async () => {
  const { sessions, host, said, states } = sessionHarness();
  const conn = fakeOperator();
  const mgr = sessions.createSessionManager(conn, host);
  const done = mgr.run('echo-analyst', 'what does it cost?');
  await settle();
  assert.deepEqual(plain(conn.calls.slice(0, 2).map(c => c.method)), ['sessions.create', 'chat.send']);
  assert.equal(conn.calls[1].params.sessionKey, 'agent:echo-analyst:lease-L1');
  const ev = (event, payload) => mgr.handleEvent({ event, payload: { sessionKey: 'agent:echo-analyst:lease-L1', runId: 'run-1', ...payload } });
  ev('agent', { stream: 'tool', data: { phase: 'start', name: 'mcp__openclaw__analyst_observe' } });
  ev('chat', { seq: 3, state: 'delta', deltaText: '$3' });
  ev('chat', { seq: 2, state: 'delta', deltaText: 'late, out of order' });   // ignored
  ev('chat', { seq: 4, state: 'final', message: { role: 'assistant', content: [{ type: 'text', text: 'It costs $39.00.' }] } });
  conn.finishWait({ runId: 'run-1', status: 'ok', terminalReply: { text: 'It costs $39.00.' } });   // same end, other path
  await done;
  await settle();
  assert.deepEqual(plain(said), [{ c: 'echo-analyst', tab: 7, text: 'It costs $39.00.' }], 'exactly one reply');
  assert.ok(states.includes('Using observe…'));
  assert.equal(mgr.busy('echo-analyst'), false);
});

test('sessions: the reply still arrives when every event was missed (agent.wait)', async () => {
  const { sessions, host, said } = sessionHarness();
  const conn = fakeOperator();
  const mgr = sessions.createSessionManager(conn, host);
  const done = mgr.run('echo-analyst', 'hi');
  await settle();
  conn.finishWait({ runId: 'run-1', status: 'ok', terminalReply: { disposition: 'visible', text: 'ECHO-EVT42' } });
  await done;
  assert.deepEqual(plain(said.map(s => s.text)), ['ECHO-EVT42']);
});

test('sessions: stopping aborts the gateway run and ignores anything that arrives after', async () => {
  const { sessions, host, said } = sessionHarness();
  const conn = fakeOperator();
  const mgr = sessions.createSessionManager(conn, host);
  const done = mgr.run('echo-analyst', 'long task');
  await settle();
  await mgr.abort('echo-analyst');
  await done;
  const abort = conn.calls.find(c => c.method === 'sessions.abort');
  assert.deepEqual(plain(abort.params), { key: 'agent:echo-analyst:lease-L1', runId: 'run-1' });
  mgr.handleEvent({ event: 'chat', payload: { sessionKey: 'agent:echo-analyst:lease-L1', runId: 'run-1', seq: 9, state: 'final',
    message: { content: [{ type: 'text', text: 'too late' }] } } });
  conn.finishWait({ runId: 'run-1', status: 'ok', terminalReply: { text: 'too late' } });
  await settle();
  assert.deepEqual(said, [], 'a stopped run says nothing more');
});

test('sessions: a new worker resumes a stored run and delivers its reply', async () => {
  const { sessions, host, said, store } = sessionHarness();
  store.set('echo_openclaw_runs', { 'agent:echo-analyst:lease-L1': { character: 'echo-analyst', sessionKey: 'agent:echo-analyst:lease-L1',
    agentId: 'echo-analyst', tabId: 7, runId: 'run-9', startedAt: 1 } });
  const conn = fakeOperator();
  const mgr = sessions.createSessionManager(conn, host);
  assert.equal(mgr.busy('echo-analyst'), false);
  await mgr.resume();
  assert.equal(mgr.busy('echo-analyst'), true);
  const wait = conn.calls.find(c => c.method === 'agent.wait');
  assert.equal(wait.params.runId, 'run-9');
  conn.finishWait({ runId: 'run-9', status: 'ok', terminalReply: { text: 'Finished while you were away.' } });
  await settle();
  assert.deepEqual(plain(said.map(s => s.text)), ['Finished while you were away.']);
  assert.deepEqual(store.get('echo_openclaw_runs'), {}, 'the stored run is cleared');
});

test('sessions: errors are reported, and events for another run are ignored', async () => {
  const { sessions, host, said } = sessionHarness();
  const conn = fakeOperator();
  const mgr = sessions.createSessionManager(conn, host);
  const done = mgr.run('echo-analyst', 'x');
  await settle();
  mgr.handleEvent({ event: 'chat', payload: { sessionKey: 'agent:echo-analyst:lease-L1', runId: 'old-run', seq: 1, state: 'final',
    message: { content: [{ type: 'text', text: 'from an older run' }] } } });
  mgr.handleEvent({ event: 'chat', payload: { sessionKey: 'agent:echo-analyst:lease-L1', runId: 'run-1', seq: 2, state: 'error', errorMessage: 'rate limited' } });
  await done;
  assert.deepEqual(plain(said.map(s => s.text)), ["I couldn't finish that: rate limited."]);
  assert.equal(sessions.toolLabel('mcp__openclaw__style_extract'), 'extract');
  assert.equal(sessions.messageText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb');
});

// --- browser tools ------------------------------------------------------------------------

function toolHarness({ fail } = {}) {
  const executed = [];
  const tabs = { 7: { url: 'https://shop.example/', title: 'Shop' }, 8: { url: 'https://shop.example/p', title: 'Product' }, 9: { url: 'https://mail.example/' } };
  const chrome = {
    tabs: { get: async id => { if (!tabs[id]) throw new Error('gone'); return { id, ...tabs[id] }; } },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };
  const leases = {
    leasesReady: Promise.resolve(),
    leaseFor: c => (c === 'echo-analyst' ? { agent: c, tabId: 7, children: [8], leaseId: 'L1' } : null),
    tabAccessible: (scope, tabId) => scope === 'echo-analyst' && (tabId === 7 || tabId === 8),
  };
  const tools = { executeTool: async (name, args, tabId, opts) => {
    executed.push({ name, args, tabId, deadline: opts?.deadline });
    if (fail && name === fail) throw new Error('No element [4]. Call read_screen again.');
    if (name === 'get_page_text') return 'TITLE: Shop\nTEXT: 0-60 of 60\n\nBlue Kettle costs $39.00. Order total: $39.00';
    return { ok: name };
  } };
  const r = registry();
  const bt = loadTs('src/background/openclaw/browser-tools.ts', { chrome }, {
    '../tools': tools, 'agents/leases': leases, '../workflow-engine': {}, '../page-watcher': {}, './registry': r,
  });
  const byName = Object.fromEntries(bt.browserToolsFor(r.avatarByCharacter('echo-analyst')).map(t => [t.name.replace('analyst_', ''), t]));
  return { byName, executed };
}
const ctx = () => ({ deadline: Date.now() + 28_000, idempotencyKey: 'k' });

test('browser tools: published per avatar; screenshot declared but not yet offered', () => {
  const { byName } = toolHarness();
  assert.deepEqual(Object.keys(byName).sort(),
    ['act', 'extract', 'find', 'navigate', 'observe', 'read', 'tabs', 'transcript', 'verify', 'watch', 'workflow']);
});

test('browser tools: act runs steps in order, passes the deadline, and stops at the first failure', async () => {
  const { byName, executed } = toolHarness({ fail: 'type_text' });
  const out = await byName.act.run({ steps: [{ do: 'click', index: 2 }, { do: 'type', index: 4, text: 'kettle', submit: true }, { do: 'scroll', amount: 400 }] }, ctx());
  assert.deepEqual(plain(executed.map(e => e.name)), ['click_element', 'type_text'], 'the step after a failure never runs');
  assert.ok(executed.every(e => e.tabId === 7 && e.deadline > Date.now()), 'acts in its own tab, within the deadline');
  assert.equal(out.failed.step, 2);
  assert.match(out.hint, /Observe the page again/);
});

test('browser tools: tabs stay within the avatar\'s own tabs and never focus a tab', async () => {
  const { byName, executed } = toolHarness();
  await assert.rejects(byName.tabs.run({ action: 'switch', tabId: 9 }, ctx()), /only switch to your own tabs/);
  await assert.rejects(byName.tabs.run({ action: 'close', tabId: 7 }, ctx()), /not your assigned tab/);
  assert.deepEqual(plain(await byName.tabs.run({ action: 'switch', tabId: 8 }, ctx())), { current: 8 });
  await byName.observe.run({}, ctx());
  assert.equal(executed.at(-1).tabId, 8, 'later tools act in the tab it switched to');
  assert.ok(!executed.some(e => e.name === 'switch_tab'), 'switching never brings a tab to the front');
});

test('browser tools: verify reports pass or fail with the text that proves it', async () => {
  const { byName } = toolHarness();
  const out = await byName.verify.run({ urlIncludes: 'shop.example', textIncludes: ['$39.00', 'Order placed'] }, ctx());
  assert.equal(out.pass, false);
  assert.deepEqual(plain(out.checks.map(c => c.pass)), [true, true, false]);
  assert.match(out.checks[1].evidence, /Blue Kettle costs \$39\.00/);
});

// --- approvals within a tool call's deadline ---------------------------------------------

test('approvals: too little time left means no prompt, and a clear reason for the agent', async () => {
  const chrome = { runtime: { sendMessage: async () => {} }, tabs: { get: async () => ({ url: 'https://shop.example/checkout' }), sendMessage: async () => {} } };
  const noLeases = { DEFAULT_SCOPE: 'default', scopeForTab: () => 'default' };
  const safety = loadTs('src/background/safety.ts', { chrome }, { 'agents/leases': noLeases });
  assert.equal(await safety.requestApproval('click_element', 'Payment: Place order', 3, 3000), false);
  assert.equal(safety.pendingApproval(3), null, 'no prompt was shown');
});
