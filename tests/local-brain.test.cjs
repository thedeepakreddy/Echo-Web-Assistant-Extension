const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// ECHO's instant local skills answer one simple command for free. A request
// with several steps, or with values the user supplies, must reach the model
// instead of being answered wrongly by a skill that only looks similar.

function loadTs(file, globals = {}, modules = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const require = spec => {
    const key = Object.keys(modules).find(k => spec.endsWith(k));
    return key ? modules[key] : {};
  };
  vm.runInNewContext(js, { exports, require, console: { ...console, warn: () => {} }, URL, Date, Map, Set, JSON, Promise, Math,
    Number, String, Array, Object, Error, RegExp, encodeURIComponent, setTimeout, clearTimeout, ...globals }, { filename: file });
  return exports;
}

function localBrain({ memory = {} } = {}) {
  const executed = [];
  const said = [];
  const store = new Map([['echo_memory', memory]]);
  const chrome = {
    storage: { local: {
      get: async keys => Object.fromEntries([].concat(keys).filter(k => store.has(k)).map(k => [k, store.get(k)])),
      set: async data => Object.entries(data).forEach(([k, v]) => store.set(k, v)),
    } },
    tabs: { get: async id => ({ id, url: 'https://shop.example/', title: 'Shop' }) },
  };
  const tools = { executeTool: async (name, args) => {
    executed.push(name);
    if (name === 'extract_pattern') return { kind: args.kind, count: 2, items: ['$39.00', '$14.00'] };
    if (name === 'fill_form') return { filled: [{ key: 'email' }], skipped: [] };
    return { success: true };
  } };
  const sites = loadTs('src/background/site-knowledge.ts');
  const brain = loadTs('src/background/local-brain.ts', { chrome }, {
    './bus': { say: (_tab, text) => said.push(text), setState: () => {} },
    './tools': tools,
    './site-knowledge': sites,
    './web-search': { searchAvailable: async () => false },
    'agents/leases': { scopeForTab: () => 'default' },
  });
  return { handle: text => brain.handleLocally(text, 7), executed, said };
}

test('local skills: several steps in one request go to the model', async () => {
  const b = localBrain();
  assert.equal(await b.handle('Search this shop for mugs, open the first result, and tell me what it is made of.'), null);
  assert.equal(await b.handle('search for mugs and open the first result'), null);
  assert.equal(await b.handle('find all prices and then add the cheapest to the cart'), null);
  assert.deepEqual(b.executed, [], 'nothing was done on the page');
});

test('local skills: "this shop" means the page in front, not a Google search', async () => {
  const b = localBrain();
  assert.equal(await b.handle('search this shop for mugs'), null);
  const web = await b.handle('google best kettles');
  assert.ok(web?.handled, 'a plain web search is still instant');
  assert.deepEqual(b.executed, ['open_url']);
});

test('local skills: a form with values given in the request is typed by the model', async () => {
  const b = localBrain({ memory: { email: 'me@example.com' } });
  assert.equal(await b.handle('Fill in this form with the name Sam Rivera and the email sam.rivera@example.com. Do not submit it.'), null);
  const own = await b.handle('fill this form');
  assert.ok(own?.handled, 'filling from saved details is still instant');
  assert.deepEqual(b.executed, ['fill_form']);
});

test('local skills: one item\'s price is a question, every price is an extraction', async () => {
  const b = localBrain();
  assert.equal(await b.handle('find the price of the blue kettle'), null);
  const all = await b.handle('extract all prices');
  assert.ok(all?.handled);
  assert.match(b.said.at(-1), /\$39\.00/);
  assert.ok((await b.handle('extract phone numbers'))?.handled, '"phone numbers" is plural too');
  assert.ok((await b.handle('get the emails'))?.handled);
});
