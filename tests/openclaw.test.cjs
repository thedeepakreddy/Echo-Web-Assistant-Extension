const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { webcrypto } = require('node:crypto');

function loadTs(file, globals = {}, requireStub = () => ({})) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require: requireStub, console, Map, Set, Date, JSON, Promise, Math, Number, String,
    setTimeout, clearTimeout, ...globals }, { filename: file });
  return exports;
}

// A gateway connection that records node.invoke.result replies.
function fakeConnection() {
  const replies = [];
  return {
    replies,
    request: async (method, params) => { if (method === 'node.invoke.result') replies.push(params); return {}; },
  };
}
const invoke = (overrides = {}) => ({ event: 'node.invoke.request', payload: {
  id: 'inv-1', nodeId: 'node-1', command: 'echo.analyst.observe', paramsJSON: '{}', timeoutMs: 30_000, idempotencyKey: 'call-1', ...overrides } });
const settle = () => new Promise(r => setTimeout(r, 20));

test('node tools: a redelivered tool call runs once and returns the first result', async () => {
  const { createNodeToolHost } = loadTs('src/background/openclaw/node-tools.ts');
  const conn = fakeConnection();
  let runs = 0;
  const host = createNodeToolHost(conn, [{ name: 'analyst_observe', command: 'echo.analyst.observe', description: 'd',
    parameters: {}, run: async () => ({ run: ++runs }) }]);
  host.handleEvent(invoke({ id: 'inv-1' }));
  host.handleEvent(invoke({ id: 'inv-2' }));   // same idempotencyKey, new delivery
  await settle();
  assert.equal(runs, 1);
  assert.equal(conn.replies.length, 2);
  assert.deepEqual(conn.replies.map(r => [r.id, r.ok, JSON.parse(r.payload.content[0].text).run]), [['inv-1', true, 1], ['inv-2', true, 1]]);
});

test('node tools: results reach the model as plain text or compact JSON, images as image blocks', async () => {
  const { createNodeToolHost, toToolResult } = loadTs('src/background/openclaw/node-tools.ts');
  const conn = fakeConnection();
  const host = createNodeToolHost(conn, [{ name: 'analyst_observe', command: 'echo.analyst.observe', description: 'd',
    parameters: {}, run: async () => 'URL: https://shop.test/\nBlue Kettle — $39.00' }]);
  host.handleEvent(invoke());
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(conn.replies[0].payload)),
    { content: [{ type: 'text', text: 'URL: https://shop.test/\nBlue Kettle — $39.00' }] }, 'text stays as written, not re-encoded');
  assert.equal(toToolResult({ kind: 'prices', items: ['$39.00'] }).content[0].text, '{"kind":"prices","items":["$39.00"]}');
  const image = { content: [{ type: 'text', text: 'Screenshot' }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }] };
  assert.equal(toToolResult(image), image);
});

test('node tools: unknown commands and malformed arguments fail without running anything', async () => {
  const { createNodeToolHost } = loadTs('src/background/openclaw/node-tools.ts');
  const conn = fakeConnection();
  let runs = 0;
  const host = createNodeToolHost(conn, [{ name: 'analyst_observe', command: 'echo.analyst.observe', description: 'd',
    parameters: {}, run: async () => { runs++; return {}; } }]);
  host.handleEvent(invoke({ id: 'a', command: 'echo.style.observe', idempotencyKey: 'k1' }));
  host.handleEvent(invoke({ id: 'b', paramsJSON: '{not json', idempotencyKey: 'k2' }));
  host.handleEvent(invoke({ id: 'c', paramsJSON: '[1,2]', idempotencyKey: 'k3' }));
  await settle();
  assert.equal(runs, 0);
  // Calls answer concurrently, so compare in id order.
  assert.deepEqual(conn.replies.map(r => [r.id, r.ok, r.error.code]).sort(),
    [['a', false, 'UNKNOWN_COMMAND'], ['b', false, 'INVALID_ARGS'], ['c', false, 'INVALID_ARGS']]);
});

test('node tools: a slow tool answers TIMEOUT before the gateway gives up', async () => {
  const { createNodeToolHost } = loadTs('src/background/openclaw/node-tools.ts');
  const conn = fakeConnection();
  let seenDeadline = 0;
  const host = createNodeToolHost(conn, [{ name: 'analyst_observe', command: 'echo.analyst.observe', description: 'd',
    parameters: {}, run: (_, ctx) => { seenDeadline = ctx.deadline; return new Promise(() => {}); } }]);
  const started = Date.now();
  // 2.1 s budget minus ECHO's 2 s margin leaves ~100 ms.
  host.handleEvent(invoke({ timeoutMs: 2_100 }));
  await new Promise(r => setTimeout(r, 400));
  assert.equal(conn.replies.length, 1);
  assert.equal(conn.replies[0].error.code, 'TIMEOUT');
  assert.ok(seenDeadline - started <= 150, `deadline ${seenDeadline - started}ms`);
});

test('node tools: only node.invoke.request events are handled', async () => {
  const { createNodeToolHost } = loadTs('src/background/openclaw/node-tools.ts');
  const conn = fakeConnection();
  const host = createNodeToolHost(conn, [{ name: 'analyst_observe', command: 'echo.analyst.observe', description: 'd',
    parameters: {}, run: async () => ({}) }]);
  host.handleEvent({ event: 'tick', payload: {} });
  host.handleEvent(invoke({ id: '' }));   // malformed: no id to answer
  await settle();
  assert.equal(conn.replies.length, 0);
  assert.deepEqual(host.commands, ['echo.analyst.observe']);
});

test('device identity: id is the SHA-256 of the raw Ed25519 key and signatures verify', async () => {
  const { deviceIdentity } = loadTs('src/background/openclaw/identity.ts',
    { crypto: webcrypto, btoa, TextEncoder, WeakMap, Uint8Array });
  let saved = null;
  const store = { load: async () => saved, save: async pair => { saved = pair; } };
  const id = await deviceIdentity(store);
  const again = await deviceIdentity(store);
  assert.equal(id, again, 'concurrent callers share one identity');
  assert.equal(saved.privateKey.extractable, false, 'private key never leaves WebCrypto');

  const raw = Buffer.from(id.publicKey, 'base64url');
  assert.equal(raw.length, 32);
  assert.equal(id.deviceId, require('node:crypto').createHash('sha256').update(raw).digest('hex'));
  const signature = Buffer.from(await id.sign('v3|payload'), 'base64url');
  const publicKey = await webcrypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
  assert.equal(await webcrypto.subtle.verify('Ed25519', publicKey, signature, new TextEncoder().encode('v3|payload')), true);
});
