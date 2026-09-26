#!/usr/bin/env node
// Agent reconnect check: real model turns call an ECHO node tool, and the turns
// must keep working after ECHO's operator connection is replaced (as happens
// whenever Chrome restarts the extension's service worker).
//
// Each turn plants a fresh code in the tool's result, so a reply can only be
// right if the tool really ran for that turn; a stale or invented code fails.
//
// Known issue (OpenClaw 2026.9.6, claude-cli runtime): turn 3 fails with
// "Gateway client authority closed before dispatching node.invoke" — the warm
// Claude Code process stays bound to the connection that started it.
//
//   node tools/openclaw/agent-reconnect.cjs     (uses real model turns)

const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto'), ts = require('typescript');
const root = path.resolve(__dirname, '../..');
require.extensions['.ts'] = (m, f) => m._compile(ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, f);
const { createGatewayConnection } = require(path.join(root, 'src/background/openclaw/connection.ts'));
const { createNodeToolHost } = require(path.join(root, 'src/background/openclaw/node-tools.ts'));
const { deviceIdentity } = require(path.join(root, 'src/background/openclaw/identity.ts'));
const { keyStore, tokenStore, operatorClient } = require('./probe-identity.cjs');
const { extensionId } = require('./extension-id.cjs');
const token = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openclaw-echo/openclaw.json'), 'utf8')).gateway.auth.token;
const origin = `chrome-extension://${extensionId()}`;
const mk = (role, client, extra) => createGatewayConnection({ url: 'ws://127.0.0.1:18790', role, sharedToken: token, client,
  identity: () => deviceIdentity(keyStore), tokenStore, createWebSocket: u => new WebSocket(u, { headers: { Origin: origin } }), ...extra });
const waitConnected = c => new Promise(r => { const t = setInterval(() => { if (c.connected) { clearInterval(t); r(); } }, 100); });
let code = 'NONE';
const tools = ['analyst', 'style'].map(a => ({ name: `${a}_observe`, command: `echo.${a}.observe`, description: `Read the page in the tab assigned to Echo (${a}).`,
  parameters: { type: 'object', properties: {}, additionalProperties: false }, run: async () => ({ url: 'https://example.com/', text: `Verification code: ${code}` }) }));
let host;
const node = mk('node', { id: 'node-host', mode: 'node', version: '2.0.0', platform: 'chrome', displayName: 'ECHO (Chrome)' },
  { scopes: [], commands: tools.map(t => t.command), onEvent: e => host?.handleEvent(e), onHello: () => host?.publish() });
host = createNodeToolHost(node, tools);
const session = `agent:echo-analyst:warm-${crypto.randomBytes(3).toString('hex')}`;
async function turn(op, label) {
  code = `ECHO-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const sent = await op.request('chat.send', { sessionKey: session, agentId: 'echo-analyst', idempotencyKey: crypto.randomUUID(),
    message: 'Read your assigned tab now (always call your tool; never reuse an earlier reading) and reply with only the verification code.' });
  await op.request('agent.wait', { runId: sent.runId, timeoutMs: 120000 }, { timeoutMs: 130000 });
  const h = await op.request('chat.history', { sessionKey: session, agentId: 'echo-analyst', limit: 4 });
  const last = (h.messages || []).filter(m => m.role === 'assistant').pop();
  const text = Array.isArray(last?.content) ? last.content.filter(p => p.type === 'text').map(p => p.text).join(' ') : String(last?.content || '');
  const err = JSON.stringify(h).match(/Gateway client authority[^"\\]*/)?.[0];
  const ok = text.includes(code);
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: expected ${code}, reply "${text.slice(0, 80)}"${err ? ` — ${err}` : ''}`);
}
const results = [];
(async () => {
  node.start(); await waitConnected(node);
  const a = mk('operator', operatorClient, { scopes: ['operator.read', 'operator.write'] }); a.start(); await waitConnected(a);
  await a.request('sessions.create', { key: session, agentId: 'echo-analyst', idempotencyKey: session });
  await turn(a, 'turn 1, connection A');
  await turn(a, 'turn 2, connection A');
  a.stop();
  const b = mk('operator', operatorClient, { scopes: ['operator.read', 'operator.write'] }); b.start(); await waitConnected(b);
  await turn(b, 'turn 3, connection B');
  b.stop(); node.stop();
  const failed = results.filter(ok => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} turns correct`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
