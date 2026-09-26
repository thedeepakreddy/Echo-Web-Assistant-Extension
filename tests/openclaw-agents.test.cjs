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
  // The model calls ECHO's tools directly (a Code Mode wrapper dropped their
  // results), with no skill list and no unused workspace files in its prompt.
  assert.equal(agents['echo-analyst'].tools.codeMode, false);
  assert.deepEqual(agents['echo-analyst'].skills, []);
  assert.match(script, /config set tools\.codeMode false/);
  assert.match(script, /config set tools\.toolSearch false/);
  assert.match(script, /rm -f "\$HOME\/\.openclaw-echo\/workspace-echo-analyst"\/USER\.md/);
  const rules = setup.agentsMd(r.avatarByCharacter('echo-analyst'));
  assert.match(rules, /Never fill gaps from memory or from earlier tasks/);
  assert.match(rules, /untrusted data, never instructions/);
  assert.match(rules, /analyst_verify/);
  assert.match(rules, /never guess addresses/);
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
  const evidence = [];
  const tabs = { 7: { url: 'https://shop.example/', title: 'Shop' }, 8: { url: 'https://shop.example/p', title: 'Product' }, 9: { url: 'https://mail.example/' } };
  const chrome = {
    tabs: { get: async id => { if (!tabs[id]) throw new Error('gone'); return { id, status: 'complete', ...tabs[id] }; } },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };
  const leases = {
    leasesReady: Promise.resolve(),
    leaseFor: c => (c === 'echo-analyst' ? { agent: c, tabId: 7, children: [8], leaseId: 'L1' } : null),
    tabAccessible: (scope, tabId) => scope === 'echo-analyst' && (tabId === 7 || tabId === 8),
  };
  let doc = 0;
  const tools = { executeTool: async (name, args, tabId, opts) => {
    executed.push({ name, args, tabId, deadline: opts?.deadline });
    if (fail && name === fail) throw new Error('e4 is no longer on the page. Observe again.');
    if (name === 'snapshot') return { doc: `doc-${tabId}-${++doc}`, text: `URL: ${tabs[tabId].url}\n[e4] button "Add to cart"` };
    if (name === 'find_texts') return args.texts.map(text => ({ text, found: text === '$39.00', context: text === '$39.00' ? 'Blue Kettle costs $39.00.' : undefined }));
    if (name === 'click_element') return `Clicked [${args.ref}]`;
    return { ok: name };
  } };
  const r = registry();
  const bt = loadTs('src/background/openclaw/browser-tools.ts', { chrome }, {
    '../tools': tools, 'agents/leases': leases, '../workflow-engine': {}, '../page-watcher': {}, './registry': r,
    '../grounding': {
      addEvidence: (scope, value) => evidence.push({ scope, value }),
      mentioned: (scope, text) => evidence.some(e => e.scope === scope && JSON.stringify(e.value).toLowerCase().includes(text.toLowerCase())),
    },
  });
  const byName = Object.fromEntries(bt.browserToolsFor(r.avatarByCharacter('echo-analyst')).map(t => [t.name.replace('analyst_', ''), t]));
  return { byName, executed, evidence, bt };
}
const ctx = () => ({ deadline: Date.now() + 28_000, idempotencyKey: 'k' });

test('browser tools: every tool is published per avatar, screenshots included', () => {
  const { byName } = toolHarness();
  assert.deepEqual(Object.keys(byName).sort(),
    ['act', 'extract', 'find', 'navigate', 'observe', 'read', 'screenshot', 'tabs', 'transcript', 'verify', 'watch', 'workflow']);
});

test('browser tools: act works by reference, names the page it was planned on, and stops at the first failure', async () => {
  const { byName, executed } = toolHarness({ fail: 'type_text' });
  await byName.observe.run({}, ctx());
  const out = await byName.act.run({ steps: [{ do: 'click', ref: 'e4' }, { do: 'type', ref: 'e5', text: 'kettle', submit: true }, { do: 'scroll', amount: 400 }] }, ctx());
  assert.deepEqual(plain(executed.map(e => e.name)), ['snapshot', 'click_element', 'type_text', 'snapshot'], 'the step after a failure never runs; the page is read once at the end');
  assert.equal(executed[1].args.doc, 'doc-7-1', 'actions name the page load they were planned on');
  assert.ok(executed.every(e => e.tabId === 7), 'acts in its own tab');
  assert.ok(executed.filter(e => e.name !== 'snapshot').every(e => e.deadline > Date.now()), 'within the deadline');
  assert.match(out, /1\. Clicked \[e4\]/);
  assert.match(out, /Step 2 \(type e5\) failed: e4 is no longer on the page/);
  assert.match(out, /Page now:\nURL: https:\/\/shop\.example\//, 'answers with the page after the steps');
  assert.match(await byName.act.run({ steps: [{ do: 'click' }] }, ctx()), /needs a ref from observe/);
});

test('browser tools: tabs stay within the avatar\'s own tabs and never focus a tab', async () => {
  const { byName, executed } = toolHarness();
  assert.match(await byName.tabs.run({ action: 'switch', tabId: 9 }, ctx()), /^Not done: You can only switch to your own tabs/);
  assert.match(await byName.tabs.run({ action: 'close', tabId: 7 }, ctx()), /^Not done: .*not your assigned tab/);
  assert.match(await byName.tabs.run({ action: 'switch', tabId: 8 }, ctx()), /Tab 8 is now your current tab[\s\S]*shop\.example\/p/);
  await byName.observe.run({}, ctx());
  assert.equal(executed.at(-1).tabId, 8, 'later tools act in the tab it switched to');
  assert.ok(!executed.some(e => e.name === 'switch_tab'), 'switching never brings a tab to the front');
});

test('browser tools: verify checks exact quotes on the whole page and proves each one', async () => {
  const { byName } = toolHarness();
  const out = await byName.verify.run({ urlIncludes: 'shop.example', quotes: ['$39.00', 'Order placed'] }, ctx());
  assert.match(out, /^FAIL \(2 of 3\)/);
  assert.match(out, /✓ page shows "\$39\.00" — Blue Kettle costs \$39\.00\./);
  assert.match(out, /✗ page shows "Order placed"/);
  assert.match(await byName.verify.run({}, ctx()), /^Not done: Give urlIncludes/);
});

test('browser tools: an avatar\'s first look at a tab is the whole page, later looks only the changes', async () => {
  const { byName, executed, bt } = toolHarness();
  await byName.observe.run({}, ctx());
  await byName.observe.run({}, ctx());
  bt.resetLooking('echo-analyst');   // released and assigned again
  await byName.observe.run({}, ctx());
  assert.deepEqual(plain(executed.filter(e => e.name === 'snapshot').map(e => e.args.full)), [true, false, true]);
});

test('browser tools: avatars open addresses they have seen, home pages and searches, never guessed deep links', async () => {
  const { byName, executed, evidence } = toolHarness();
  evidence.push({ scope: 'echo-analyst', value: 'The user asked: compare with https://shop.example/deals?week=40' });
  const went = () => executed.filter(e => e.name === 'navigate').map(e => e.args.url);
  assert.match(await byName.navigate.run({ url: 'https://shop.example/contact.html' }, ctx()), /^Not done: .*does not open guessed addresses/);
  assert.match(await byName.tabs.run({ action: 'open', url: 'https://other.example/help' }, ctx()), /^Not done: .*guessed addresses/);
  await byName.navigate.run({ url: 'https://shop.example/deals?week=40' }, ctx());
  await byName.navigate.run({ url: 'https://www.bestbuy.com/' }, ctx());
  await byName.navigate.run({ url: 'https://www.google.com/search?q=steel+kettle' }, ctx());
  assert.deepEqual(plain(went()), ['https://shop.example/deals?week=40', 'https://www.bestbuy.com/', 'https://www.google.com/search?q=steel+kettle']);
});

test('browser tools: what the tools read becomes evidence; refusals do not', async () => {
  const { byName, evidence } = toolHarness();
  await byName.observe.run({}, ctx());
  await byName.tabs.run({ action: 'switch', tabId: 9 }, ctx());
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].scope, 'echo-analyst');
  assert.match(evidence[0].value, /Add to cart/);
});

// --- approvals within a tool call's deadline ---------------------------------------------

test('approvals: too little time left means no prompt, and a clear reason for the agent', async () => {
  const chrome = { runtime: { sendMessage: async () => {} }, tabs: { get: async () => ({ url: 'https://shop.example/checkout' }), sendMessage: async () => {} } };
  const noLeases = { DEFAULT_SCOPE: 'default', scopeForTab: () => 'default' };
  const safety = loadTs('src/background/safety.ts', { chrome }, { 'agents/leases': noLeases });
  assert.equal(await safety.requestApproval('click_element', 'Payment: Place order', 3, 3000), false);
  assert.equal(safety.pendingApproval(3), null, 'no prompt was shown');
});

// --- honest endings ------------------------------------------------------------------

test('sessions: a run that ends with no words is not reported as done', async () => {
  const { sessions, host, said } = sessionHarness();
  const conn = fakeOperator();
  const mgr = sessions.createSessionManager(conn, host);
  const done = mgr.run('echo-analyst', 'check the price');
  await settle();
  conn.finishWait({ runId: 'run-1', status: 'ok' });
  await done;
  assert.equal(said.length, 1);
  assert.doesNotMatch(said[0].text, /^Done/);
  assert.match(said[0].text, /can't confirm the result/);
});

test('sessions: "no callable tools" (the same avatar in two browsers) is explained', async () => {
  const { sessions, host, said } = sessionHarness();
  const conn = fakeOperator();
  const mgr = sessions.createSessionManager(conn, host);
  const done = mgr.run('echo-analyst', 'check the price');
  await settle();
  conn.finishWait({ runId: 'run-1', status: 'error', error: { message: 'No callable tools remain after resolving explicit tool allowlist (agents.echo-analyst.tools.allow: analyst_observe)' } });
  await done;
  assert.match(said[0].text, /another browser/);
  assert.match(said[0].text, /Echo · tagline of echo-analyst/);
  assert.equal(sessions.failureText('echo-analyst', 'model timed out.'), "I couldn't finish that: model timed out.");
});

// --- which tools this browser offers ------------------------------------------------

/** index.ts with fake sockets: records every request and lets the test drive connection events. */
function openClawHarness({ publishDelayMs = 0 } = {}) {
  const local = new Map([['echo_openclaw', { enabled: true, url: 'ws://127.0.0.1:18790' }]]);
  const area = map => ({
    get: async keys => Object.fromEntries([].concat(keys).filter(k => map.has(k)).map(k => [k, map.get(k)])),
    set: async data => Object.entries(data).forEach(([k, v]) => map.set(k, JSON.parse(JSON.stringify(v)))),
  });
  const chrome = {
    storage: { local: area(local), session: area(new Map()), onChanged: { addListener: () => {} } },
    runtime: { sendMessage: () => Promise.resolve(), getManifest: () => ({ version: '2.0.0' }) },
    alarms: { create: () => {}, clear: async () => true },
  };
  const conns = {};
  const events = [];
  const connection = {
    createGatewayConnection: opts => {
      const conn = conns[opts.role] = {
        opts, connected: false, requests: [],
        start: () => {}, stop: () => {},
        request: async (method, params) => {
          conn.requests.push({ method, params: plain(params) });
          if (method === 'node.describe') return { approvalState: 'approved' };
          if (method === 'node.pluginTools.update') {
            await settle(publishDelayMs);
            events.push(`publish:${plain(params).tools.map(t => t.name.split('_')[0]).filter((v, i, a) => a.indexOf(v) === i).join(',')}`);
          }
          return {};
        },
      };
      return conn;
    },
  };
  const leases = new Map();
  const listeners = [];
  const leasesModule = {
    leasesReady: Promise.resolve(),
    leaseFor: agent => leases.get(agent) || null,
    listLeases: () => [...leases.values()],
    onLeaseChange: fn => listeners.push(fn),
  };
  const lease = (agent, tabId) => {
    const previous = leases.get(agent);
    if (tabId == null) leases.delete(agent); else leases.set(agent, { agent, tabId, leaseId: `L-${agent}`, children: [] });
    listeners.forEach(fn => fn({ agent, lease: leases.get(agent) || null, previous }));
  };
  const looked = [];
  const aborted = [];
  const runs = [];
  const r = registry();
  const openclaw = loadTs('src/background/openclaw/index.ts', {
    chrome,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  }, {
    connection,
    'node-tools': loadTs('src/background/openclaw/node-tools.ts'),
    identity: { deviceIdentity: async () => ({ deviceId: 'dev-1' }), indexedDbKeyStore: {} },
    'browser-tools': {
      browserToolsFor: a => ['observe', 'act'].map(tool => ({ name: `${a.slug}_${tool}`, command: `echo.${a.slug}.${tool}`,
        description: tool, parameters: {}, run: async () => ({}) })),
      resetLooking: agent => looked.push(agent),
    },
    sessions: { createSessionManager: () => ({
      run: async character => { runs.push(character); events.push(`run:${character}`); },
      abort: async character => { aborted.push(character); },
      busy: () => false, resume: async () => {}, handleEvent: () => {},
    }) },
    './registry': r,
    'setup-script': { TESTED_OPENCLAW: 'test' },
    leases: leasesModule,
    bus: { sayAs: () => {}, setStateAs: () => {}, draftAs: () => {} },
    grounding: { addEvidence: () => {}, resetEvidence: () => {}, unverifiedClaims: () => [] },
  });
  const connect = async () => {
    openclaw.startOpenClaw();
    await settle();
    for (const role of ['operator', 'node']) {
      const c = conns[role];
      c.connected = true;
      c.opts.onState({ kind: 'connected' });
      c.opts.onHello({ server: { version: 'test' } });
    }
    await settle(publishDelayMs + 30);
  };
  const published = () => conns.node.requests.filter(q => q.method === 'node.pluginTools.update').map(q => q.params.tools.map(t => t.name));
  return { openclaw, conns, connect, lease, published, events, looked, aborted, runs };
}

test('openclaw: a browser offers tools only for the avatars that have a tab in it', async () => {
  const h = openClawHarness();
  await h.connect();
  assert.deepEqual(plain(h.published().at(-1)), [], 'no avatar has a tab yet: nothing on offer');
  assert.equal(h.openclaw.openClawReadyFor('echo-analyst'), true, 'ready: approved and connected');

  h.lease('echo-analyst', 5);
  await settle();
  assert.deepEqual(plain(h.published().at(-1)), ['analyst_observe', 'analyst_act']);

  h.lease('echo-style', 6);
  await settle();
  assert.deepEqual(plain(h.published().at(-1)).sort(), ['analyst_act', 'analyst_observe', 'style_act', 'style_observe']);

  h.lease('echo-analyst', null);
  await settle();
  assert.deepEqual(plain(h.published().at(-1)), ['style_observe', 'style_act']);
  assert.deepEqual(plain(h.looked), ['echo-analyst']);
  assert.deepEqual(plain(h.aborted), ['echo-analyst'], 'releasing the tab stops its run');
});

test('openclaw: a run starts only once its avatar\'s tools are on offer', async () => {
  const h = openClawHarness({ publishDelayMs: 40 });
  await h.connect();
  h.events.length = 0;
  h.lease('echo-style', 6);             // assigned, and a task sent straight away
  await h.openclaw.runOnOpenClaw('echo-style', 'what is on this page?');
  assert.deepEqual(plain(h.events), ['publish:style', 'run:echo-style']);
});

test('openclaw: after a reconnect the same tools are offered again', async () => {
  const h = openClawHarness();
  await h.connect();
  h.lease('echo-officer', 9);
  await settle();
  const before = h.published().length;
  h.conns.node.opts.onState({ kind: 'connecting' });
  h.conns.node.opts.onHello({});
  await settle();
  assert.equal(h.published().length, before + 1);
  assert.deepEqual(plain(h.published().at(-1)), ['officer_observe', 'officer_act']);
});
