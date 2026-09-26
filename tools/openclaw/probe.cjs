#!/usr/bin/env node
// Phase 0 probe: drives ECHO's real gateway modules (src/background/openclaw)
// from Node, presenting the same Chrome-extension Origin the extension will,
// and checks the contract ECHO depends on:
//   1. the gateway accepts ECHO's origin and device signature
//   2. pairing works for the node and operator roles
//   3. per-avatar tools are published and each agent sees only its own
//   4. an agent's tool call reaches ECHO and the result comes back
//   5. one avatar cannot call another avatar's tool
//
//   node tools/openclaw/probe.cjs [--url ws://127.0.0.1:18790] [--profile echo] [--wait 180]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const profile = arg('profile', 'echo');
const url = arg('url', 'ws://127.0.0.1:18790');
const waitSeconds = Number(arg('wait', '180'));

// Load ECHO's TypeScript modules directly, the way the tests do.
require.extensions['.ts'] = (module, filename) => {
  const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
  }).outputText;
  module._compile(out, filename);
};
const { createGatewayConnection } = require(path.join(root, 'src/background/openclaw/connection.ts'));
const { createNodeToolHost } = require(path.join(root, 'src/background/openclaw/node-tools.ts'));
const { deviceIdentity } = require(path.join(root, 'src/background/openclaw/identity.ts'));

// Present exactly the origin Chrome sends for ECHO (its id comes from manifest.json's key).
const { extensionId } = require('./extension-id.cjs');
const origin = `chrome-extension://${arg('extension-id', extensionId())}`;

function sharedToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  const file = path.join(os.homedir(), `.openclaw-${profile}`, 'openclaw.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'))?.gateway?.auth?.token;
}

const { keyStore, tokenStore, operatorClient } = require('./probe-identity.cjs');

const identity = () => deviceIdentity(keyStore);
const createWebSocket = u => new WebSocket(u, { headers: { Origin: origin } });
const token = sharedToken();
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const log = (...a) => console.log('     ', ...a);

// Two avatars, one tool each. The command names carry the avatar.
const invoked = [];
const observeTool = avatar => ({
  name: `${avatar}_observe`,
  command: `echo.${avatar}.observe`,
  description: `Read the page in the tab assigned to Echo (${avatar}).`,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  run: async (args, ctx) => {
    invoked.push({ avatar, args, key: ctx.idempotencyKey });
    return { avatar, url: 'https://example.com/', title: 'Probe page', text: `Observed by ${avatar}` };
  },
});

function connect(role, client, extra) {
  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });
  let host = null;
  const conn = createGatewayConnection({
    url, role, client, sharedToken: token, identity, tokenStore, createWebSocket,
    ...extra,
    onState: state => {
      if (state.kind === 'pairing-required') log(`[${role}] pairing required — approve request ${state.requestId || '(see openclaw devices list)'}`);
      else if (state.kind === 'error') log(`[${role}] ${state.code}: ${state.message}${state.willRetry ? ' (retrying)' : ''}`);
      else if (state.kind === 'connected') { log(`[${role}] connected, scopes: ${(state.hello.auth?.scopes || []).join(', ') || '(none)'}`); resolveReady(state.hello); }
    },
    onEvent: event => host?.handleEvent(event),
    onHello: () => host?.publish().then(() => log('[node] tools published')).catch(e => log('[node] publish failed:', e.message)),
  });
  return { conn, ready, setHost: h => { host = h; } };
}

async function main() {
  if (!token) throw new Error(`No gateway token for profile "${profile}".`);
  console.log(`Gateway ${url}, origin ${origin}\n`);

  const tools = [observeTool('analyst'), observeTool('style')];
  const node = connect('node', { id: 'node-host', mode: 'node', version: '2.0.0', platform: 'chrome', displayName: 'ECHO (Chrome)' },
    { scopes: [], commands: tools.map(t => t.command) });
  node.setHost(createNodeToolHost(node.conn, tools));
  const operator = connect('operator', operatorClient,
    { scopes: ['operator.read', 'operator.write'], caps: ['tool-events'] });

  node.conn.start();
  operator.conn.start();
  const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error(`not connected after ${waitSeconds}s`)), waitSeconds * 1000));
  await Promise.race([Promise.all([node.ready, operator.ready]), deadline]);
  check('origin, device signature and pairing accepted for node + operator', true);
  await new Promise(r => setTimeout(r, 500));   // let the tool publish land

  const nodes = await operator.conn.request('node.list', {});
  const me = (nodes.nodes || []).find(n => n.connected !== false && /ECHO/.test(n.displayName || ''));
  check('ECHO appears as a connected node', !!me, me ? `nodeId ${me.nodeId}` : JSON.stringify(nodes).slice(0, 300));

  if (process.argv.includes('--debug') && me) {
    log('node.describe:', JSON.stringify(await operator.conn.request('node.describe', { nodeId: me.nodeId }), null, 1).slice(0, 3000));
  }

  // What assigning an avatar to a tab does: one session per avatar lease.
  for (const agent of ['echo-analyst', 'echo-style']) {
    const created = await operator.conn.request('sessions.create', {
      key: `agent:${agent}:probe`, agentId: agent, label: `ECHO probe (${agent})`, idempotencyKey: `probe-${agent}`,
    });
    log(`session ${created.key} ready`);
  }

  for (const agent of ['echo-analyst', 'echo-style']) {
    const eff = await operator.conn.request('tools.effective', { agentId: agent, sessionKey: `agent:${agent}:probe` });
    const names = JSON.stringify(eff);
    if (process.argv.includes('--debug')) log(`tools.effective ${agent}:`, names.slice(0, 3000));
    const own = agent === 'echo-analyst' ? 'analyst_observe' : 'style_observe';
    const other = agent === 'echo-analyst' ? 'style_observe' : 'analyst_observe';
    check(`${agent} sees only its own tool`, names.includes(own) && !names.includes(other),
      `own=${names.includes(own)} other=${names.includes(other)}`);
  }

  const call = await operator.conn.request('tools.invoke', {
    name: 'analyst_observe', args: {}, agentId: 'echo-analyst', sessionKey: 'agent:echo-analyst:probe',
    idempotencyKey: crypto.randomUUID(),
  });
  check('agent tool call reaches ECHO and the result returns', call?.ok === true && invoked.some(i => i.avatar === 'analyst'),
    JSON.stringify(call).slice(0, 200));

  const before = invoked.length;
  let crossOk = false;
  try {
    const cross = await operator.conn.request('tools.invoke', {
      name: 'analyst_observe', args: {}, agentId: 'echo-style', sessionKey: 'agent:echo-style:probe',
      idempotencyKey: crypto.randomUUID(),
    });
    crossOk = cross?.ok === false;
    log('cross-avatar result:', JSON.stringify(cross).slice(0, 200));
  } catch (error) {
    crossOk = true;
    log('cross-avatar call rejected:', error.message);
  }
  check('echo-style cannot call analyst_observe', crossOk && invoked.length === before);

  node.conn.stop();
  operator.conn.stop();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => { console.error('\nProbe failed:', error.message); process.exit(1); });
