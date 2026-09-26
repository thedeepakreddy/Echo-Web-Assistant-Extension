#!/usr/bin/env node
// Phase 1 end-to-end: two avatars work in two tabs at the same time, in a real
// headless Chrome, with no model or API key (only ECHO's local tools).
//
//   1. Echo · Skeptical analyst gets tab A, Echo · Style advisor gets tab B
//   2. the analyst runs a slow recorded workflow in its tab
//   3. meanwhile the style advisor extracts emails from its tab and finishes
//   4. stopping the analyst stops only the analyst
//   5. the style advisor keeps working; the classic ECHO still works
//   6. each thread holds only its own messages
//   7. releasing an avatar, or closing its tab, ends its lease
//
//   npm run build && node tools/e2e/multi-agent.cjs

const http = require('node:http');
const { launchEcho, evaluate, findTarget, delay } = require('./chrome.cjs');

/** Ask ECHO for this page's look from inside the page's content script, as the orb does. */
async function orbAvatar(cdp, pageUrl, extensionId) {
  const page = await findTarget(cdp, t => t.type === 'page' && t.url === pageUrl);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const contexts = [];
  cdp.ws.addEventListener('message', function onMessage(e) {
    const msg = JSON.parse(e.data);
    if (msg.sessionId === sessionId && msg.method === 'Runtime.executionContextCreated') contexts.push(msg.params.context);
  });
  await cdp.send('Runtime.enable', {}, sessionId);
  await delay(300);
  const isolated = contexts.find(c => c.origin === `chrome-extension://${extensionId}` || c.auxData?.type === 'isolated');
  try {
    if (!isolated) return null;
    const r = await cdp.send('Runtime.evaluate', { contextId: isolated.id, awaitPromise: true, returnByValue: true,
      expression: `chrome.runtime.sendMessage({ type: 'ECHO_CONTENT_PREFS' }).then(r => r.avatar)` }, sessionId);
    return r.result.value;
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const log = (...a) => console.log('     ', ...a);

const PAGES = {
  '/a': '<title>Analyst desk</title><h1>Quarterly numbers</h1><p>Revenue rose 12% on subscription growth.</p>',
  '/b': '<title>Style studio</title><h1>Fittings</h1><p>Book with alice@example.com or bob@example.org this week.</p>',
};

async function waitFor(fn, timeoutMs, stepMs = 250) {
  for (const started = Date.now(); Date.now() - started < timeoutMs; await delay(stepMs)) {
    const value = await fn().catch(() => null);
    if (value) return value;
  }
  return null;
}

async function main() {
  const server = http.createServer((req, res) => {
    const body = PAGES[req.url];
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body ? `<!doctype html><html><body>${body}</body></html>` : 'not found');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const { cdp, extensionId, worker, browser, cleanup } = await launchEcho({ urls: [`${base}/a`, `${base}/b`] });
  process.on('exit', () => { cleanup(); server.close(); });
  log(browser);
  const inWorker = expr => evaluate(cdp, worker.targetId, expr);

  const tabs = await waitFor(async () => {
    const list = await inWorker(`chrome.tabs.query({ url: '${base}/*', status: 'complete' }).then(t => t.map(x => ({ id: x.id, url: x.url })))`);
    return list.length === 2 ? list : null;
  }, 15_000);
  const tabA = tabs.find(t => t.url.endsWith('/a')).id;
  const tabB = tabs.find(t => t.url.endsWith('/b')).id;
  check('two pages open', tabA != null && tabB != null, `tab A ${tabA}, tab B ${tabB}`);

  // The side panel page is one of ECHO's trusted pages, so it may assign avatars.
  const { targetId: panelId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extensionId}/sidepanel.html` });
  await findTarget(cdp, t => t.targetId === panelId);
  await delay(800);
  const panel = msg => evaluate(cdp, panelId, `chrome.runtime.sendMessage(${JSON.stringify(msg)})`);
  const thread = agent => panel({ type: 'ECHO_AGENT_THREAD', agent }).then(r => (r.messages || []).map(m => `${m.role}: ${m.text}`));
  const working = agent => panel({ type: 'ECHO_TASK_STATUS_REQUEST', agent }).then(r => !!r.active);

  const a = await panel({ type: 'ECHO_AGENT_ASSIGN', agent: 'echo-analyst', tabId: tabA });
  const b = await panel({ type: 'ECHO_AGENT_ASSIGN', agent: 'echo-style', tabId: tabB });
  const taken = await panel({ type: 'ECHO_AGENT_ASSIGN', agent: 'echo-mentor', tabId: tabA });
  check('each avatar gets its own tab', a.success && b.success && a.lease.tabId === tabA && b.lease.tabId === tabB);
  check('a tab cannot be given to a second avatar', taken.success === false, taken.error);
  const orbA = await orbAvatar(cdp, `${base}/a`, extensionId);
  const orbB = await orbAvatar(cdp, `${base}/b`, extensionId);
  check('each tab\'s orb shows the avatar assigned to it', orbA === 'echo-analyst' && orbB === 'echo-style', `A: ${orbA}, B: ${orbB}`);

  // A slow recorded workflow (six 5-second waits) for the analyst.
  await inWorker(`chrome.storage.local.set({ echo_workflows: { 'slow demo': {
    name: 'slow demo', startUrl: '${base}/a', created: Date.now(), runs: 0,
    steps: Array.from({ length: 6 }, (_, i) => ({ type: 'wait', ms: 5000, id: 'w' + i, at: i })) } } }).then(() => true)`);

  await panel({ type: 'USER_INPUT', agent: 'echo-analyst', text: 'run workflow slow demo' });
  const analystBusy = await waitFor(() => working('echo-analyst'), 5_000);
  check('the analyst starts its long task', !!analystBusy);

  const started = Date.now();
  await panel({ type: 'USER_INPUT', agent: 'echo-style', text: 'extract emails' });
  const styleReply = await waitFor(async () => (await thread('echo-style')).find(m => /alice@example\.com/.test(m)), 10_000);
  const analystStillBusy = await working('echo-analyst');
  check('the style advisor finishes its task while the analyst is still working',
    !!styleReply && analystStillBusy, `${Math.round((Date.now() - started) / 100) / 10}s, analyst working: ${analystStillBusy}`);

  await panel({ type: 'ECHO_ABORT', agent: 'echo-analyst' });
  const stopped = await waitFor(async () => !(await working('echo-analyst')) &&
    (await thread('echo-analyst')).some(m => /stopped/i.test(m)), 8_000);
  check('stopping the analyst stops its workflow', !!stopped, (await thread('echo-analyst')).slice(-1)[0]);

  await panel({ type: 'USER_INPUT', agent: 'echo-style', text: 'what can you do' });
  const styleAgain = await waitFor(async () => (await thread('echo-style')).find(m => /what I can do/i.test(m)), 8_000);
  check('the style advisor keeps working after the analyst was stopped', !!styleAgain);

  await panel({ type: 'USER_INPUT', text: 'what can you do' });
  const classic = await waitFor(async () => {
    const r = await panel({ type: 'ECHO_CHAT_STATE_REQUEST' });
    return (r.state?.messages || []).some(m => /what I can do/i.test(m.text)) ? r.state.messages : null;
  }, 8_000);
  check('the classic ECHO still answers in its own chat', !!classic);

  // What the user asked in each thread must be exactly what was sent to it.
  const analystThread = await thread('echo-analyst');
  const styleThread = await thread('echo-style');
  const asked = list => list.filter(m => m.startsWith('user: ')).map(m => m.slice(6));
  const classicAsked = (classic || []).filter(m => m.role === 'user').map(m => m.text);
  check('each thread holds only its own messages',
    JSON.stringify(asked(analystThread)) === JSON.stringify(['run workflow slow demo'])
    && JSON.stringify(asked(styleThread)) === JSON.stringify(['extract emails', 'what can you do'])
    && JSON.stringify(classicAsked) === JSON.stringify(['what can you do']),
    `analyst ${JSON.stringify(asked(analystThread))}, style ${JSON.stringify(asked(styleThread))}, classic ${JSON.stringify(classicAsked)}`);
  if (process.argv.includes('--debug')) {
    log('analyst:', JSON.stringify(analystThread));
    log('style:', JSON.stringify(styleThread));
    log('classic:', JSON.stringify((classic || []).map(m => `${m.role}: ${m.text.slice(0, 60)}`)));
  }

  await panel({ type: 'ECHO_AGENT_RELEASE', agent: 'echo-analyst' });
  await cdp.send('Target.closeTarget', { targetId: (await findTarget(cdp, t => t.type === 'page' && t.url === `${base}/b`)).targetId });
  const cleared = await waitFor(async () => {
    const r = await panel({ type: 'ECHO_AGENT_LIST' });
    return r.success && r.agents.length === 0 ? true : null;
  }, 5_000);
  check('releasing an avatar and closing a tab both end the lease', !!cleared);

  cdp.close();
  const failed = results.filter(ok => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => { console.error('\nE2E failed:', error.stack || error.message); process.exit(1); });
