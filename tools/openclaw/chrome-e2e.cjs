#!/usr/bin/env node
// Phase 0 end-to-end: the built extension (dist/) in a real, headless Chrome
// for Testing, connected to ECHO's OpenClaw gateway.
//
//   1. load dist/ in a throwaway profile and open https://example.com
//   2. enable OpenClaw in the extension and assign that tab to Echo (analyst)
//   3. pair the extension (--approve approves on the local test gateway)
//   4. an agent tool call (as echo-analyst) reads the tab through the extension
//   5. echo-style cannot read it
//   6. the extension stays connected after 70 s with no DevTools attached
//   7. (--agent-run) a real model turn: the agent reports a code planted in
//      the page, which it can only know by reading the tab through ECHO
//
//   npm run build && node tools/openclaw/chrome-e2e.cjs --approve [--agent-run]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const dist = path.join(root, 'dist');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };
const profile = arg('profile', 'echo');
const url = arg('url', 'ws://127.0.0.1:18790');
const autoApprove = process.argv.includes('--approve');
const idleSeconds = Number(arg('idle', '70'));
const agentRun = process.argv.includes('--agent-run');
// One session per run, the way each tab assignment gets its own lease session.
const runTag = crypto.randomBytes(3).toString('hex');
let pairedNodeId = null;
const openclaw = arg('openclaw', path.join(os.homedir(), '.npm-global/bin/openclaw'));
const chromeBin = arg('chrome', path.join(os.homedir(),
  'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));

require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
  }).outputText, filename);
};
const { createGatewayConnection } = require(path.join(root, 'src/background/openclaw/connection.ts'));
const { deviceIdentity } = require(path.join(root, 'src/background/openclaw/identity.ts'));
const { keyStore, tokenStore, operatorClient } = require('./probe-identity.cjs');
const { extensionId: expectedExtensionId } = require('./extension-id.cjs');

const delay = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const log = (...a) => console.log('     ', ...a);
const sharedToken = () => JSON.parse(fs.readFileSync(path.join(os.homedir(), `.openclaw-${profile}`, 'openclaw.json'), 'utf8')).gateway.auth.token;
const oc = (...args) => execFileSync(openclaw, ['--profile', profile, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// A pending request can be superseded between listing and approving it (for
// example when the operator role pairs at the same moment); retry next round.
const tryOc = (...args) => { try { oc(...args); return true; } catch (error) { log(`(${args.slice(0, 2).join(' ')} will retry: ${String(error.stderr || error.message).trim().split('\n')[0]})`); return false; } };

// --- minimal CDP client -------------------------------------------------------
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() { this.ws.close(); }
}

async function evaluateInWorker(cdp, targetId, expression) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

async function workerTarget(cdp, extensionId) {
  for (let i = 0; i < 100; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const sw = targetInfos.find(t => t.type === 'service_worker' && t.url === `chrome-extension://${extensionId}/background.js`);
    if (sw) return sw;
    await delay(100);
  }
  return null;
}

// Approve whatever the extension's device is waiting for: device pairing first,
// then the node's command list.
function approvePending(label) {
  const devices = JSON.parse(oc('devices', 'list', '--json'));
  for (const req of devices.pending || []) {
    if (/ECHO/.test(req.displayName || req.clientDisplayName || JSON.stringify(req))) {
      log(`approving ${label} device request ${req.requestId}`);
      tryOc('devices', 'approve', req.requestId);
    }
  }
  const nodes = JSON.parse(oc('nodes', 'pending', '--json'));
  for (const req of nodes.pending || nodes || []) {
    const id = req.requestId || req.id;
    if (id && /ECHO/.test(JSON.stringify(req))) {
      log(`approving ${label} node commands ${id}`);
      tryOc('nodes', 'approve', id);
    }
  }
}

async function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-e2e-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(chromeBin, [
    '--headless=new', `--user-data-dir=${userDir}`, `--remote-debugging-port=${port}`,
    `--load-extension=${dist}`, `--disable-extensions-except=${dist}`,
    '--no-first-run', '--no-default-browser-check', 'https://example.com/',
  ], { stdio: 'ignore' });
  const cleanup = () => {
    try { chrome.kill(); } catch { /* already gone */ }
    // Each run pairs a fresh throwaway profile; never leave it on the gateway.
    if (autoApprove && pairedNodeId) { tryOc('devices', 'remove', pairedNodeId); pairedNodeId = null; }
    try { fs.rmSync(userDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Chrome still flushing; temp dir */ }
  };
  process.on('exit', cleanup);

  let version;
  for (let i = 0; i < 100 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await delay(100); }
  }
  if (!version) throw new Error('Chrome for Testing did not start.');
  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.ready;
  log(`${version.Browser}`);

  const extensionId = expectedExtensionId();
  const sw = await workerTarget(cdp, extensionId);
  check('extension loads with its fixed id', !!sw, extensionId);
  if (!sw) return;

  // The worker's chrome.* bindings appear a moment after its target does.
  for (let i = 0; i < 50; i++) {
    if (await evaluateInWorker(cdp, sw.targetId, `typeof chrome.tabs?.query === 'function'`).catch(() => false)) break;
    await delay(200);
  }

  // Wait for example.com to finish loading so its content script is ready.
  let tabId;
  for (let i = 0; i < 100 && tabId == null; i++) {
    tabId = await evaluateInWorker(cdp, sw.targetId,
      `chrome.tabs.query({ url: 'https://example.com/*', status: 'complete' }).then(t => t[0]?.id ?? null)`);
    if (tabId == null) await delay(200);
  }
  check('example.com is open', tabId != null, `tab ${tabId}`);

  await evaluateInWorker(cdp, sw.targetId, `Promise.all([
    chrome.storage.session.set({ echo_openclaw_leases: { analyst: ${tabId} } }),
    chrome.storage.local.set({ echo_openclaw: { enabled: true, url: ${JSON.stringify(url)}, sharedToken: ${JSON.stringify(sharedToken())} } }),
  ]).then(() => true)`);
  log('OpenClaw enabled in the extension; tab assigned to Echo (analyst)');

  const readState = () => evaluateInWorker(cdp, sw.targetId, `chrome.storage.session.get('echo_openclaw_state').then(r => r.echo_openclaw_state || {})`);
  let st = {};
  for (let i = 0; i < 120; i++) {
    st = await readState();
    if (st.node === 'connected' && st.operator === 'connected') break;
    if (autoApprove && i % 5 === 4 && (String(st.node).startsWith('pairing') || String(st.operator).startsWith('pairing'))) approvePending('extension');
    await delay(500);
  }
  check('extension paired and connected (node + operator)', st.node === 'connected' && st.operator === 'connected', JSON.stringify(st));

  // The node's command list may need its own approval after the device pairs.
  let nodeId;
  // The test operator reuses the probe's paired identity (run probe.cjs once first).
  const operator = createGatewayConnection({
    url, role: 'operator', sharedToken: sharedToken(), client: operatorClient,
    scopes: ['operator.read', 'operator.write'], identity: () => deviceIdentity(keyStore), tokenStore,
    // Same browser-client identity as the probe, so the same extension origin.
    createWebSocket: u => new WebSocket(u, { headers: { Origin: `chrome-extension://${extensionId}` } }),
  });
  const connected = new Promise(resolve => {
    const t = setInterval(() => { if (operator.connected) { clearInterval(t); resolve(); } }, 100);
  });
  operator.start();
  await Promise.race([connected, delay(15000)]);
  if (!operator.connected) throw new Error('test operator could not connect');

  for (let i = 0; i < 60; i++) {
    const list = await operator.request('node.list', {});
    const echo = (list.nodes || []).find(n => n.connected && n.displayName === 'ECHO (Chrome)' && (n.commands || []).includes('echo.analyst.observe'));
    if (echo) { nodeId = echo.nodeId; break; }
    if (autoApprove && i % 5 === 4) approvePending('extension');
    await delay(500);
  }
  check('extension node approved with its avatar commands', !!nodeId, nodeId || 'not found');
  pairedNodeId = nodeId;

  for (const agent of ['echo-analyst', 'echo-style']) {
    await operator.request('sessions.create', { key: `agent:${agent}:e2e-${runTag}`, agentId: agent, label: `ECHO e2e ${agent} ${runTag}`, idempotencyKey: `e2e-${agent}-${runTag}` });
  }
  await delay(500);
  const read = await operator.request('tools.invoke', {
    name: 'analyst_observe', args: {}, agentId: 'echo-analyst', sessionKey: `agent:echo-analyst:e2e-${runTag}`, idempotencyKey: crypto.randomUUID(),
  });
  const text = JSON.stringify(read);
  check('echo-analyst reads its tab through the extension', read?.ok === true && /Example Domain/.test(text), text.slice(0, 160));

  const cross = await operator.request('tools.invoke', {
    name: 'analyst_observe', args: {}, agentId: 'echo-style', sessionKey: `agent:echo-style:e2e-${runTag}`, idempotencyKey: crypto.randomUUID(),
  }).catch(error => ({ ok: false, error: { message: error.message } }));
  check('echo-style cannot read the analyst tab', cross?.ok === false, cross?.error?.code || cross?.error?.message);

  if (agentRun) {
    // A code the model cannot guess: only a real read of the tab reveals it.
    const code = `ECHO-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    await evaluateInWorker(cdp, sw.targetId, `chrome.scripting.executeScript({ target: { tabId: ${tabId} },
      func: code => { const p = document.createElement('p'); p.textContent = 'Verification code: ' + code; document.querySelector('h1').after(p); },
      args: [${JSON.stringify(code)}] }).then(() => true)`);
    const started = Date.now();
    const sent = await operator.request('chat.send', {
      sessionKey: `agent:echo-analyst:e2e-${runTag}`, agentId: 'echo-analyst', idempotencyKey: crypto.randomUUID(),
      message: 'Read the page in your assigned browser tab and reply with only the verification code shown on it.',
    });
    log(`agent run ${sent?.runId || JSON.stringify(sent).slice(0, 120)} started`);
    const waited = await operator.request('agent.wait', { runId: sent.runId, timeoutMs: 170_000 }, { timeoutMs: 180_000 });
    const history = await operator.request('chat.history', { sessionKey: `agent:echo-analyst:e2e-${runTag}`, agentId: 'echo-analyst', limit: 6 });
    log(`run status ${waited?.status}${waited?.stopReason ? ` (${waited.stopReason})` : ''} in ${Math.round((Date.now() - started) / 1000)}s`);
    // The final reply itself must carry the code, not just the tool result in the transcript.
    const replies = (history?.messages || []).filter(m => m.role === 'assistant');
    const last = replies[replies.length - 1];
    const finalText = typeof last?.content === 'string' ? last.content
      : (Array.isArray(last?.content) ? last.content.filter(part => part?.type === 'text').map(part => part.text).join(' ') : '');
    const usedTool = JSON.stringify(history).includes('analyst_observe');
    check('a real agent turn reads the tab through ECHO and reports the planted code', usedTool && finalText.includes(code),
      `reply: ${finalText.slice(0, 80) || '(none)'}`);
  }

  // No DevTools session is attached now, so only the gateway's own traffic
  // can keep the service worker (and its sockets) alive.
  log(`idle for ${idleSeconds}s with no DevTools attached…`);
  await delay(idleSeconds * 1000);
  const after = await operator.request('node.list', {});
  const still = (after.nodes || []).find(n => n.nodeId === nodeId);
  check(`extension still connected after ${idleSeconds}s idle`, !!still?.connected);
  const again = await operator.request('tools.invoke', {
    name: 'analyst_observe', args: {}, agentId: 'echo-analyst', sessionKey: `agent:echo-analyst:e2e-${runTag}`, idempotencyKey: crypto.randomUUID(),
  });
  check('tool call still works after idle', again?.ok === true);

  // Chrome may still stop the worker (update, memory pressure). The wake alarm
  // must bring ECHO back, reconnected and with its tools republished.
  const before = still?.connectedAtMs || 0;
  await cdp.send('Target.closeTarget', { targetId: sw.targetId }).catch(() => {});
  log('stopped the extension service worker; waiting for it to come back…');
  let back = null;
  const stoppedAt = Date.now();
  for (let i = 0; i < 90 && !back; i++) {
    await delay(1000);
    const list = await operator.request('node.list', {});
    back = (list.nodes || []).find(n => n.nodeId === nodeId && n.connected && (n.connectedAtMs || 0) > before) || null;
  }
  check('worker restarts and reconnects by itself', !!back, back ? `after ${Math.round((Date.now() - stoppedAt) / 1000)}s` : 'not back after 90s');
  if (back) {
    await delay(1000);   // tool publish follows the hello
    const afterRestart = await operator.request('tools.invoke', {
      name: 'analyst_observe', args: {}, agentId: 'echo-analyst', sessionKey: `agent:echo-analyst:e2e-${runTag}`, idempotencyKey: crypto.randomUUID(),
    });
    check('tools republished and tab assignment kept after restart', afterRestart?.ok === true && /Example Domain/.test(JSON.stringify(afterRestart)));
  }

  operator.stop();
  cdp.close();
  const failed = results.filter(ok => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => { console.error('\nE2E failed:', error.stack || error.message); process.exit(1); });
