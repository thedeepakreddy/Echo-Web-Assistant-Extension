#!/usr/bin/env node
// Phase 3 end-to-end: the avatar tools as a model receives them, through the
// real gateway (tools.invoke, no model turns), with the built extension in
// headless Chrome for Testing.
//
//   1. observe: text and controls in reading order with references, plain text
//      (not escaped JSON), hidden text left out, whole page (shadow DOM, cards,
//      tables), field values never shown; a second look shows only changes
//   2. act: batched steps by reference, answering with what changed; select,
//      check, type; payment fields refused
//   3. stale references fail instead of acting on the wrong element (removed
//      control, page reloaded behind the agent's back, unknown reference)
//   4. extract list and verify (exact quotes, field states) straight from the page
//   5. screenshot only for a tab on screen, as a small JPEG
//
//   npm run build && node tools/openclaw/harness-e2e.cjs
// Needs the "echo" gateway profile running on 127.0.0.1:18790. Uses no model.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const { launchEcho, evaluate, findTarget, delay, root } = require('../e2e/chrome.cjs');

require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
  }).outputText, filename);
};
const { createGatewayConnection } = require(path.join(root, 'src/background/openclaw/connection.ts'));
const { deviceIdentity } = require(path.join(root, 'src/background/openclaw/identity.ts'));
const { keyStore, tokenStore, operatorClient } = require('./probe-identity.cjs');

const OPENCLAW = path.join(os.homedir(), '.npm-global/bin/openclaw');
const URL_ = 'ws://127.0.0.1:18790';
const FIXTURES = path.join(root, 'tools/echobench/fixtures');
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${String(detail).replace(/\s+/g, ' ').slice(0, 180)}` : ''}`); };
const oc = (...args) => execFileSync(OPENCLAW, ['--profile', 'echo', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const ocJson = (...args) => { const out = oc(...args, '--json'); return JSON.parse(out.slice(out.search(/[[{]/))); };
const tryOc = (...args) => { try { oc(...args); return true; } catch { return false; } };
const sharedToken = () => JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openclaw-echo/openclaw.json'), 'utf8')).gateway.auth.token;
const SLUGS = { 'echo-analyst': 'analyst', 'echo-officer': 'officer', 'echo-mentor': 'mentor', 'echo-patrol': 'patrol', 'echo-visionary': 'visionary', echo: 'echo' };

async function waitFor(fn, timeoutMs, stepMs = 500) {
  for (const started = Date.now(); Date.now() - started < timeoutMs; await delay(stepMs)) {
    const value = await fn().catch(() => null);
    if (value) return value;
  }
  return null;
}

function approveNew(known) {
  try { for (const r of ocJson('devices', 'list').pending || []) if (/ECHO/.test(JSON.stringify(r)) && !known.has(r.deviceId)) tryOc('devices', 'approve', r.requestId); } catch { /* next round */ }
  try {
    const p = ocJson('nodes', 'pending');
    for (const r of p.pending || p || []) { const id = r.requestId || r.id; if (id && /ECHO/.test(JSON.stringify(r)) && !known.has(r.nodeId || r.deviceId)) tryOc('nodes', 'approve', id); }
  } catch { /* next round */ }
}

/** Avatars another connected browser offers tools for: using them here would clash. */
function busyAvatars(ownDevice) {
  const busy = new Set();
  for (const n of ocJson('nodes', 'status').nodes || []) {
    if (!n.connected || n.nodeId === ownDevice) continue;
    let tools = [];
    try { tools = ocJson('nodes', 'describe', '--node', n.nodeId).nodePluginTools || []; } catch { /* none */ }
    for (const t of tools) { const agent = Object.keys(SLUGS).find(a => SLUGS[a] === String(t.name).split('_')[0]); if (agent) busy.add(agent); }
  }
  return busy;
}

/** The text a model would read from a tool result. */
function textOf(value) {
  const out = [];
  const walk = v => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v.content)) { for (const c of v.content) if (c?.type === 'text') out.push(c.text); return; }
    for (const x of Object.values(v)) walk(x);
  };
  walk(value);
  return out.join('\n');
}
const imagesOf = value => {
  const out = [];
  const walk = v => { if (!v || typeof v !== 'object') return; if (Array.isArray(v.content)) { out.push(...v.content.filter(c => c?.type === 'image')); return; } Object.values(v).forEach(walk); };
  walk(value);
  return out;
};
const refFor = (view, pattern) => (view.split('\n').find(l => pattern.test(l)) || '').match(/\[(e\d+)\]/)?.[1];

async function main() {
  const server = http.createServer((req, res) => {
    const file = path.join(FIXTURES, path.basename(new URL(req.url, 'http://x').pathname));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const known = new Set((ocJson('devices', 'list').paired || []).map(d => d.deviceId));
  const { cdp, extensionId, worker, cleanup } = await launchEcho({ urls: [`${base}/shop.html`, `${base}/controls.html`] });
  let testDevice = null;
  let operator = null;
  process.on('exit', () => { operator?.stop(); if (testDevice) tryOc('devices', 'remove', testDevice); cleanup(); server.close(); });
  const inWorker = expr => evaluate(cdp, worker.targetId, expr);
  const { targetId: panelId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extensionId}/sidepanel.html` });
  await findTarget(cdp, t => t.targetId === panelId);
  await delay(800);
  const panel = msg => evaluate(cdp, panelId, `chrome.runtime.sendMessage(${JSON.stringify(msg)})`);

  await panel({ type: 'ECHO_OPENCLAW_SAVE', enabled: true, url: URL_, sharedToken: sharedToken() });
  let rounds = 0;
  const ready = await waitFor(async () => { if (++rounds % 4 === 0) approveNew(known); return (await panel({ type: 'ECHO_OPENCLAW_STATUS' })).status.ready; }, 120_000);
  if (!ready) throw new Error('ECHO did not become ready on the gateway.');
  const tokens = await inWorker(`chrome.storage.local.get('echo_openclaw_device_tokens').then(r => Object.keys(r.echo_openclaw_device_tokens || {}))`);
  testDevice = (tokens[0] || '').split(':')[0] || null;
  if (known.has(testDevice)) testDevice = null;

  const busy = busyAvatars(testDevice);
  const [shopAgent, formAgent] = Object.keys(SLUGS).filter(a => !busy.has(a));
  const tabs = await inWorker(`chrome.tabs.query({ url: '${base}/*' }).then(t => t.map(x => ({ id: x.id, url: x.url })))`);
  const shopTab = tabs.find(t => t.url.endsWith('/shop.html')).id;
  const formTab = tabs.find(t => t.url.endsWith('/controls.html')).id;
  await panel({ type: 'ECHO_AGENT_ASSIGN', agent: shopAgent, tabId: shopTab });
  await panel({ type: 'ECHO_AGENT_ASSIGN', agent: formAgent, tabId: formTab });
  console.log(`      avatars: ${shopAgent} on the shop, ${formAgent} on the order form`);

  operator = createGatewayConnection({ url: URL_, role: 'operator', sharedToken: sharedToken(), client: operatorClient,
    scopes: ['operator.read', 'operator.write'], identity: () => deviceIdentity(keyStore), tokenStore,
    createWebSocket: u => new WebSocket(u, { headers: { Origin: `chrome-extension://${extensionId}` } }) });
  operator.start();
  await waitFor(async () => operator.connected, 15_000, 100);
  const tag = crypto.randomBytes(3).toString('hex');
  const sessionOf = agent => `agent:${agent}:harness-${tag}`;
  for (const agent of [shopAgent, formAgent]) await operator.request('sessions.create', { key: sessionOf(agent), agentId: agent, idempotencyKey: sessionOf(agent) });
  // Tools are offered once an avatar holds a tab; give the publish a moment.
  await delay(800);
  const invoke = async (agent, tool, args = {}) => {
    const res = await operator.request('tools.invoke', { name: `${SLUGS[agent]}_${tool}`, args, agentId: agent, sessionKey: sessionOf(agent),
      idempotencyKey: crypto.randomUUID() }).catch(error => ({ ok: false, error: { message: error.message } }));
    return { res, text: res?.ok === false ? `ERROR ${res.error?.message || ''}` : textOf(res) };
  };

  // 1. observe
  const first = (await invoke(shopAgent, 'observe')).text;
  check('observe: controls carry references, prices and names as written', /\[e\d+\] button "Add to cart"/.test(first) && /Blue Kettle/.test(first) && /\$39\.00/.test(first), first.slice(0, 160));
  check('observe: plain text for the model, not escaped JSON', !first.startsWith('"') && !first.includes('\\n'), first.slice(0, 60));
  const again = (await invoke(shopAgent, 'observe')).text;
  check('observe again: only what changed', /No changes since your last observe/.test(again), again.split('\n').pop());

  // 2. act with what changed, by reference
  const mugButton = refFor(first.split('Speckled Mug')[1] || '', /button "Add to cart"/);
  const added = (await invoke(shopAgent, 'act', { steps: [{ do: 'click', ref: mugButton }] })).text;
  check('act: clicks by reference and answers with what changed', /Clicked/.test(added) && /\+ .*Cart: 1 items/.test(added) && /- .*Cart: 0 items/.test(added), added.replace(/\n/g, ' | ').slice(0, 170));
  const unknown = (await invoke(shopAgent, 'act', { steps: [{ do: 'click', ref: 'e999' }] })).text;
  check('act: an unknown reference fails and nothing is clicked', /failed: There is no e999/.test(unknown), unknown.split('\n')[0]);

  // 4. extract and verify on the shop
  const list = (await invoke(shopAgent, 'extract', { kind: 'list' })).text;
  check('extract list: repeated items exactly as the page shows them', /Speckled Mug — \$14\.00/.test(list) && /Steel Kettle — \$24\.50/.test(list), list.split('\n').slice(0, 3).join(' | '));
  const good = (await invoke(shopAgent, 'verify', { quotes: ['Blue Kettle — $39.00'], urlIncludes: 'shop.html' })).text;
  const bad = (await invoke(shopAgent, 'verify', { quotes: ['Blue Kettle — $19.00'] })).text;
  check('verify: exact quotes pass only when the page shows them', /^PASS \(2 of 2\)/.test(good) && /^FAIL \(0 of 1\)/.test(bad), `${good.split('\n')[0]} / ${bad.split('\n')[0]}`);

  // 1. and 2. on the order form: whole page, hidden text left out, values never shown
  const form = (await invoke(formAgent, 'observe')).text;
  check('observe: whole page including shadow DOM, cards and tables', /Shadow note: ships in 3 days/.test(form) && /\$79\.00/.test(form) && /Basic \| \$5/.test(form), '');
  check('observe: hidden text is left out', !/Hidden instructions|Also hidden/.test(form));
  check('observe: labels name their control once, without its options',
    !/Size Small Medium Large/.test(form) && !form.split('\n').some(l => /^(Gift wrap|Promo code|Card number)$/.test(l.trim())), '');
  check('observe: fields show their state, protected fields are marked',
    /combobox "Size" = "Small"/.test(form) && /checkbox "Gift wrap" \(unchecked\)/.test(form) && /textbox "Promo code" \(empty\)/.test(form) && /"Card number" \(protected\)/.test(form),
    form.split('\n').filter(l => /Size|Gift|Promo|Card/.test(l)).join(' | '));
  const size = refFor(form, /combobox "Size"/), gift = refFor(form, /Gift wrap/), promo = refFor(form, /Promo code/), card = refFor(form, /Card number/), swap = refFor(form, /Swap me/);
  const filled = (await invoke(formAgent, 'act', { steps: [
    { do: 'select', ref: size, option: 'Large' }, { do: 'check', ref: gift }, { do: 'type', ref: promo, text: 'SAVE10' }] })).text;
  check('act: select, check and type in one call, answered with the changes',
    /Status: Size Large/.test(filled) && /Gift wrap" \(checked\)/.test(filled) && /Promo code" \(filled\)/.test(filled), filled.replace(/\n/g, ' | ').slice(0, 170));
  check('observe/act never show what a field holds', !/SAVE10/.test(filled));
  const fields = (await invoke(formAgent, 'verify', { fields: [{ ref: promo, equals: 'SAVE10' }, { ref: gift, checked: true }] })).text;
  const wrong = (await invoke(formAgent, 'verify', { fields: [{ ref: promo, equals: 'WRONG' }] })).text;
  check('verify: field values checked without revealing them', /^PASS \(2 of 2\)/.test(fields) && /^FAIL/.test(wrong) && !/SAVE10/.test(wrong.replace(/"WRONG"/, '')), `${fields.split('\n')[0]} / ${wrong.split('\n')[0]}`);
  const payment = (await invoke(formAgent, 'act', { steps: [{ do: 'type', ref: card, text: '4242424242424242' }] })).text;
  check('act: payment fields are refused', /will not type into password, payment/.test(payment), payment.split('\n')[0]);

  const deluxe = refFor(form, /link "Deluxe Kettle/);
  const opened = (await invoke(formAgent, 'act', { steps: [{ do: 'click', ref: deluxe }] })).text;
  check('act: a control with a long name (a product card) can be clicked', /Clicked/.test(opened) && /controls\.html#details/.test(opened), opened.split('\n')[0]);

  const review = refFor(form, /link "Read the review in a new tab"/);
  const newTab = (await invoke(formAgent, 'act', { steps: [{ do: 'click', ref: review }] })).text;
  const openedId = Number((newTab.match(/A new tab opened \((\d+)/) || [])[1]);
  const switched = openedId ? (await invoke(formAgent, 'tabs', { action: 'switch', tabId: openedId })).text : '';
  check('a tab a link opens from the avatar\'s tab becomes its own', /Lisbon picked to host/.test(switched), newTab.split('\n').find(l => /new tab/.test(l)) || newTab.slice(0, 120));
  if (openedId) await invoke(formAgent, 'tabs', { action: 'switch', tabId: formTab });

  // 3. stale references
  const swapped = (await invoke(formAgent, 'act', { steps: [{ do: 'click', ref: swap }] })).text;
  const stale = (await invoke(formAgent, 'act', { steps: [{ do: 'click', ref: swap }] })).text;
  check('a control that was replaced fails instead of clicking something else', /Clicked/.test(swapped) && /is no longer on the page/.test(stale), stale.split('\n')[0]);
  await inWorker(`chrome.tabs.reload(${formTab}).then(() => true)`);
  await delay(1500);
  const reloaded = (await invoke(formAgent, 'act', { steps: [{ do: 'check', ref: gift }] })).text;
  check('after a reload the agent did not see, old references fail', /A new page has loaded since your last observe/.test(reloaded), reloaded.split('\n')[0]);
  const giftAfter = await evaluate(cdp, (await findTarget(cdp, t => t.type === 'page' && t.url.includes('/controls.html'))).targetId, `document.getElementById('gift').checked`);
  check('…and nothing on the new page was touched', giftAfter === false);

  // 5. screenshots
  await inWorker(`chrome.tabs.update(${shopTab}, { active: true }).then(() => true)`);
  const hidden = (await invoke(formAgent, 'screenshot')).text;
  check('screenshot: refused for a tab that is not on screen, with the reason', /^Not done: .*not on screen/.test(hidden), hidden.slice(0, 90));
  const shot = await invoke(shopAgent, 'screenshot');
  const image = imagesOf(shot.res)[0];
  check('screenshot: a small JPEG of the tab on screen', image?.mimeType === 'image/jpeg' && image.data.length > 1000 && image.data.length < 400_000,
    image ? `${Math.round(image.data.length * 0.75 / 1024)} KB` : shot.text.slice(0, 90));

  await panel({ type: 'ECHO_AGENT_RELEASE', agent: shopAgent });
  await panel({ type: 'ECHO_AGENT_RELEASE', agent: formAgent });
  for (const agent of [shopAgent, formAgent]) await operator.request('sessions.delete', { key: sessionOf(agent) }).catch(() => {});
  cdp.close();
  const failed = results.filter(ok => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => { console.error('\nHarness e2e failed:', error.stack || error.message); process.exit(1); });
