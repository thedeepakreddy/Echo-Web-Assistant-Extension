#!/usr/bin/env node
// EchoBench: ECHO's own benchmark. Each task opens a local copy of a web page
// in headless Chrome for Testing, gives it to an avatar, sends the request
// through ECHO exactly as the side panel does, and scores the result with
// automatic checks only (reply text, page state afterwards, approvals asked).
//
//   npm run build && node tools/echobench/run.cjs                # tasks that need no model
//   ECHOBENCH_PROVIDER=gemini ECHOBENCH_API_KEY=... [ECHOBENCH_MODEL=...] \
//     node tools/echobench/run.cjs --model --runs 3              # every task, 3 runs each
//
// Options: --runs N (repeat each task; reports pass^N), --only id,id,
// --label name (results file name). The key is read from the environment and
// written only into the throwaway Chrome profile, which is deleted afterwards;
// it is never printed or saved in the results.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { launchEcho, evaluate, findTarget, delay } = require('../e2e/chrome.cjs');

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : fallback; };
const withModel = process.argv.includes('--model');
const runs = Math.max(1, Number(arg('runs', '1')));
const only = arg('only', '') ? arg('only', '').split(',') : null;
const label = arg('label', withModel ? `${process.env.ECHOBENCH_PROVIDER || 'model'}` : 'no-model');
const FIXTURES = path.join(__dirname, 'fixtures');
const DEFAULT_AGENT = 'echo';

// Where ECHO keeps each provider's key and model (see src/background/auth.ts).
const PROVIDERS = {
  gemini: ['geminiApiKey', 'geminiModel'], claude: ['anthropicApiKey', 'anthropicModel'], groq: ['groqApiKey', 'groqModel'],
  openrouter: ['openrouterApiKey', 'openrouterModel'], togetherai: ['togetherApiKey', 'togetherModel'],
};

// --- scoring ------------------------------------------------------------------

/** Wilson 95% interval for k successes out of n. */
function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / d;
  const half = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
const pct = x => `${Math.round(x * 1000) / 10}%`;
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** Check a reply and page state against a task's `expect`. Returns failure reasons. */
async function score(expect, reply, pageValue, approvals) {
  const reasons = [];
  const text = reply.toLowerCase();
  for (const needle of expect.replyIncludes || []) {
    if (!text.includes(needle.toLowerCase())) reasons.push(`reply lacks "${needle}"`);
  }
  if (expect.replyIncludesAtLeast) {
    const { count, of } = expect.replyIncludesAtLeast;
    const found = of.filter(n => text.includes(n.toLowerCase()));
    if (found.length < count) reasons.push(`reply has ${found.length}/${count} of [${of.join(', ')}]`);
  }
  for (const needle of expect.replyExcludes || []) {
    if (text.includes(needle.toLowerCase())) reasons.push(`reply contains "${needle}"`);
  }
  if (expect.replyMatches && !new RegExp(expect.replyMatches, 'i').test(reply)) reasons.push(`reply does not match /${expect.replyMatches}/`);
  if (expect.replyExcludesPattern && new RegExp(expect.replyExcludesPattern).test(reply)) reasons.push(`reply matches forbidden /${expect.replyExcludesPattern}/`);
  for (const probe of expect.page || []) {
    const value = await pageValue(probe.expr);
    if (JSON.stringify(value) !== JSON.stringify(probe.equals)) reasons.push(`${probe.expr} = ${JSON.stringify(value)}, want ${JSON.stringify(probe.equals)}`);
  }
  if (expect.approvals?.min != null && approvals < expect.approvals.min) reasons.push(`asked for approval ${approvals}×, want ≥ ${expect.approvals.min}`);
  if (expect.approvals?.max != null && approvals > expect.approvals.max) reasons.push(`asked for approval ${approvals}×, want ≤ ${expect.approvals.max}`);
  if (!reply.trim() && !(expect.page || []).length) reasons.push('no reply');
  return reasons;
}

// --- running ------------------------------------------------------------------

async function main() {
  const allTasks = JSON.parse(fs.readFileSync(path.join(__dirname, 'tasks.json'), 'utf8'));
  let model = null;
  if (withModel) {
    const provider = process.env.ECHOBENCH_PROVIDER;
    const key = process.env.ECHOBENCH_API_KEY;
    if (!PROVIDERS[provider] || !key) throw new Error('Set ECHOBENCH_PROVIDER (gemini|claude|groq|openrouter|togetherai) and ECHOBENCH_API_KEY for --model.');
    model = { provider, key, name: process.env.ECHOBENCH_MODEL || '' };
  }
  const tasks = allTasks.filter(t => (!only || only.includes(t.id)));
  const skipped = tasks.filter(t => t.needsModel && !model).map(t => t.id);
  const selected = tasks.filter(t => !t.needsModel || model);

  // Every task run gets its own origin (a fresh port), so page storage such as
  // a shopping cart can never leak from one task into the next.
  let server = null;
  let base = '';
  async function freshOrigin() {
    if (server) await new Promise(r => server.close(r));
    server = http.createServer((req, res) => {
      const file = path.join(FIXTURES, path.basename(new URL(req.url, 'http://x').pathname));
      if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(file));
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  }

  const { cdp, extensionId, worker, browser, cleanup } = await launchEcho();
  process.on('exit', () => { cleanup(); server?.close(); });
  const inWorker = expr => evaluate(cdp, worker.targetId, expr);

  if (model) {
    const [keyField, modelField] = PROVIDERS[model.provider];
    await inWorker(`chrome.storage.local.set(${JSON.stringify({ provider: model.provider, [keyField]: model.key,
      ...(model.name ? { [modelField]: model.name } : {}) })}).then(() => true)`);
  }

  // ECHO's side panel page: trusted to address avatars and answer approvals.
  const { targetId: panelId } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extensionId}/sidepanel.html` });
  await findTarget(cdp, t => t.targetId === panelId);
  await delay(800);
  const panelEval = expr => evaluate(cdp, panelId, expr);
  const panel = msg => panelEval(`chrome.runtime.sendMessage(${JSON.stringify(msg)})`);
  // Count approval prompts and usage per avatar; answer approvals as the task says.
  await panelEval(`(() => {
    window.__bench = { approvals: {}, usage: {}, answer: 'deny' };
    chrome.runtime.onMessage.addListener(m => {
      if (m.type === 'ECHO_APPROVAL_REQUEST') {
        const tab = String(m.tabId); window.__bench.approvals[tab] = (window.__bench.approvals[tab] || 0) + 1;
        chrome.runtime.sendMessage({ type: 'ECHO_APPROVAL_RESPONSE', id: m.id, approved: window.__bench.answer === 'allow' });
      } else if (m.type === 'ECHO_USAGE') {
        window.__bench.usage[m.agent] = { steps: m.steps, tokens: m.taskTokens };
      }
    });
    return true;
  })()`);

  async function openPage(page) {
    const url = `${base}/${page}`;
    await cdp.send('Target.createTarget', { url });
    for (let i = 0; i < 80; i++) {
      const tab = await inWorker(`chrome.tabs.query({ url: ${JSON.stringify(url)}, status: 'complete' }).then(t => t[0]?.id ?? null)`);
      if (tab != null) return { url, tabId: tab };
      await delay(150);
    }
    throw new Error(`${page} did not load`);
  }

  /** Evaluate in the page's own world (the page's tab may have navigated since). */
  async function pageValue(tabId, expr) {
    const tab = await inWorker(`chrome.tabs.get(${tabId}).then(t => t.url)`).catch(() => null);
    if (!tab) return undefined;
    const target = await findTarget(cdp, t => t.type === 'page' && t.url === tab, 3000);
    if (!target) return undefined;
    return evaluate(cdp, target.targetId, expr).catch(error => `error: ${error.message}`);
  }

  /** Done when the avatar's task has ended: seen running then idle, or idle with a reply already in. */
  async function waitIdle(agent, timeoutMs) {
    const status = () => panel({ type: 'ECHO_TASK_STATUS_REQUEST', agent }).then(r => !!r.active);
    const replied = () => panel({ type: 'ECHO_AGENT_THREAD', agent }).then(r => (r.messages || []).some(m => m.role === 'echo'));
    const started = Date.now();
    let seen = false;
    while (Date.now() - started < timeoutMs) {
      const active = await status();
      if (active) seen = true;
      else if (seen || await replied() || Date.now() - started > 3000) return true;
      await delay(150);
    }
    return false;
  }

  /** One avatar, one page, one request. */
  async function runOne(spec, agent) {
    const { tabId } = await openPage(spec.page);
    const assigned = await panel({ type: 'ECHO_AGENT_ASSIGN', agent, tabId });
    if (!assigned.success) throw new Error(assigned.error);
    await panel({ type: 'USER_INPUT', agent, text: spec.prompt });
    return { tabId, agent, spec };
  }

  async function finishOne(run, started, timeoutMs) {
    const done = await waitIdle(run.agent, timeoutMs);
    const ms = Date.now() - started;
    const thread = (await panel({ type: 'ECHO_AGENT_THREAD', agent: run.agent })).messages || [];
    const replies = thread.filter(m => m.role === 'echo');
    const reply = replies.map(m => m.text).join('\n');
    const tier = Math.max(-1, ...replies.map(m => (typeof m.tier === 'number' ? m.tier : -1)));
    const bench = await panelEval('JSON.parse(JSON.stringify(window.__bench))');
    const approvals = bench.approvals[String(run.tabId)] || 0;
    const usage = bench.usage[run.agent] || { steps: 0, tokens: 0 };
    const reasons = done ? await score(run.spec.expect || {}, reply, expr => pageValue(run.tabId, expr), approvals) : ['timed out'];
    await panel({ type: 'ECHO_ABORT', agent: run.agent });
    await panel({ type: 'ECHO_AGENT_RELEASE', agent: run.agent });
    return { ok: reasons.length === 0, reasons, ms, tier, approvals, tokens: usage.tokens, steps: usage.steps, reply: reply.slice(0, 400) };
  }

  async function setup(task) {
    await freshOrigin();
    await panelEval(`window.__bench.approvals = {}; window.__bench.usage = {}; window.__bench.answer = ${JSON.stringify(task.approvalAnswer || 'deny')}; true`);
    const workflows = Object.fromEntries(Object.entries(task.setup?.workflows || {}).map(([name, wf]) =>
      [name, { name, startUrl: `${base}/${wf.startPage}`, steps: wf.steps, created: Date.now(), runs: 0 }]));
    await inWorker(`chrome.storage.local.set(${JSON.stringify({ echo_memory: task.setup?.memory || {}, echo_workflows: workflows })}).then(() => true)`);
  }

  async function closePages() {
    const { targetInfos } = await cdp.send('Target.getTargets');
    for (const t of targetInfos) if (t.type === 'page' && t.url.startsWith(base)) await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
  }

  console.log(`EchoBench · ${browser} · ${model ? `${model.provider}${model.name ? ` ${model.name}` : ''}` : 'no model (local brains only)'} · ${selected.length} tasks × ${runs} run(s)`);
  if (skipped.length) console.log(`skipped (need --model): ${skipped.join(', ')}`);
  console.log('');

  const results = [];
  for (const task of selected) {
    for (let run = 1; run <= runs; run++) {
      await setup(task);
      const started = Date.now();
      const timeoutMs = (task.timeoutSec || (task.needsModel ? 150 : 40)) * 1000;
      let outcome;
      try {
        if (task.parallel) {
          // Several avatars at once: every one must succeed.
          const launched = [];
          for (const part of task.parallel) launched.push(await runOne(part, part.agent));
          const parts = await Promise.all(launched.map(l => finishOne(l, started, timeoutMs)));
          outcome = { ok: parts.every(p => p.ok), reasons: parts.flatMap((p, i) => p.reasons.map(r => `${task.parallel[i].agent}: ${r}`)),
            ms: Math.max(...parts.map(p => p.ms)), tier: Math.max(...parts.map(p => p.tier)), approvals: parts.reduce((a, p) => a + p.approvals, 0),
            tokens: parts.reduce((a, p) => a + p.tokens, 0), steps: parts.reduce((a, p) => a + p.steps, 0), reply: parts.map(p => p.reply).join(' | ') };
        } else {
          outcome = await finishOne(await runOne(task, task.agent || DEFAULT_AGENT), started, timeoutMs);
        }
      } catch (error) {
        outcome = { ok: false, reasons: [`error: ${error.message}`], ms: Date.now() - started, tier: -1, approvals: 0, tokens: 0, steps: 0, reply: '' };
      }
      await closePages();
      results.push({ id: task.id, category: task.category, run, ...outcome });
      const tierName = ['instant', 'cached', 'on-device', 'cloud'][outcome.tier] || '-';
      console.log(`${outcome.ok ? 'PASS' : 'FAIL'}  ${task.id.padEnd(26)} ${String(Math.round(outcome.ms / 100) / 10 + 's').padStart(6)}  ${tierName.padEnd(9)} ${String(outcome.tokens || 0).padStart(6)} tok${outcome.ok ? '' : `  — ${outcome.reasons.join('; ')}`}`);
    }
  }

  // --- report -------------------------------------------------------------------
  const n = results.length;
  const k = results.filter(r => r.ok).length;
  const [lo, hi] = wilson(k, n);
  const ids = [...new Set(results.map(r => r.id))];
  const allRunsPass = ids.filter(id => results.filter(r => r.id === id).every(r => r.ok)).length;
  const successTokens = results.filter(r => r.ok).reduce((a, r) => a + (r.tokens || 0), 0);
  console.log(`\nSuccess ${k}/${n} = ${pct(k / n)}  (95% CI ${pct(lo)}–${pct(hi)})`);
  if (runs > 1) console.log(`pass^${runs} (every run passed): ${allRunsPass}/${ids.length} tasks`);
  for (const category of [...new Set(results.map(r => r.category))]) {
    const rs = results.filter(r => r.category === category);
    console.log(`  ${category.padEnd(12)} ${rs.filter(r => r.ok).length}/${rs.length}`);
  }
  console.log(`Median time ${Math.round(median(results.map(r => r.ms)) / 100) / 10}s · tokens per success ${k ? Math.round(successTokens / k) : 0}`);

  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.json`);
  fs.writeFileSync(file, JSON.stringify({ when: new Date().toISOString(), browser, model: model ? { provider: model.provider, name: model.name || 'default' } : null,
    runs, skipped, summary: { success: k, total: n, ci95: [lo, hi], passAll: allRunsPass, tasks: ids.length }, results }, null, 2));
  console.log(`Results: ${path.relative(process.cwd(), file)}`);
  cdp.close();
  process.exit(0);
}

if (require.main === module) {
  main().catch(error => { console.error('\nEchoBench failed:', error.stack || error.message); process.exit(1); });
}
module.exports = { score, wilson };
