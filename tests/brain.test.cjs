const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// The built-in brain's agent loops, with a scripted model: a task that hits the
// step limit can be continued, empty or blocked turns are always explained,
// overloaded models fall back, and recent tool results stay readable.

function loadTs(file, globals = {}, modules = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports = {};
  const require = spec => {
    const key = Object.keys(modules).find(k => spec.endsWith(k));
    return key ? modules[key] : {};
  };
  vm.runInNewContext(js, { exports, require, console: { ...console, warn: () => {} }, URL, Date, Map, Set, JSON,
    Promise, Math, Number, String, Array, Object, Error, AbortController, setTimeout, clearTimeout, ...globals },
    { filename: file });
  return exports;
}

const plain = v => JSON.parse(JSON.stringify(v));

/**
 * A brain wired to a scripted Gemini (or OpenAI-compatible) model.
 * `reply(call)` gets { model, contents } and returns a response or throws.
 */
function brainWith({ reply, provider = 'gemini', fetchReply, tool = () => ({ text: 'page' }), fastTimers = false }) {
  const calls = [];
  const said = [];
  const tools = [];
  class GoogleGenAI {
    constructor() {
      this.models = {
        generateContent: async req => {
          const call = { model: req.model, contents: plain(req.contents) };
          calls.push(call);
          return reply(call, calls.length);
        },
      };
    }
  }
  const Type = { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER', BOOLEAN: 'BOOLEAN', ARRAY: 'ARRAY' };
  const modules = {
    '@google/genai': { GoogleGenAI, Type },
    '@anthropic-ai/sdk': { __esModule: true, default: class Anthropic {} },
    auth: { getAuthConfig: async () => ({ provider, geminiApiKey: 'test-key', geminiModel: 'model-a', groqApiKey: 'test-key', groqModel: 'llama' }) },
    tools: { executeTool: async (name, args) => { tools.push(name); return tool(name, args, tools.length); } },
    bus: {
      say: (tabId, text) => said.push(text),
      safeSendMessage: () => {},
      echoUser: () => {},
    },
    personalization: { personalContext: async () => '' },
    'web-search': { webSearchMode: async () => 'off', looksLikeSearch: () => false, stripClaudeSearchBlocks: c => c },
    isolation: { ISOLATED_PROMPT: '' },
    video: { isVideoUrl: () => false },
    'agents/leases': { DEFAULT_SCOPE: 'default', scopeForTab: () => 'default', tabAccessible: () => true },
    characters: { characterById: () => null },
  };
  const chrome = {
    storage: { local: { get: async () => ({}) } },
    tabs: { get: async id => ({ id, url: 'https://shop.test/' }), query: async () => [{ id: 1 }] },
  };
  const globals = { chrome };
  if (fastTimers) globals.setTimeout = fn => setTimeout(fn, 0);
  if (fetchReply) {
    globals.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ model: body.model, messages: body.messages });
      return fetchReply(body, calls.length);
    };
  }
  const brain = loadTs('src/background/brain.ts', globals, modules);
  return { brain, calls, said, tools };
}

const text = t => ({ candidates: [{ content: { role: 'model', parts: [{ text: t }] }, finishReason: 'STOP' }] });
const toolCall = (name = 'read_screen') => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args: {} } }] }, finishReason: 'STOP' }] });
const empty = (finishReason = 'STOP') => ({ candidates: [{ content: { role: 'model', parts: [] }, finishReason }] });
const userTexts = contents => contents.filter(m => m.role === 'user' && m.parts.some(p => p.text)).map(m => m.parts.map(p => p.text).join(''));
const modelTexts = contents => contents.filter(m => m.role === 'model' && m.parts.some(p => p.text)).map(m => m.parts.map(p => p.text).join(''));

test('a task stopped at the step limit can be continued: "keep going" still sees what was asked', async () => {
  let continuing = false;
  const { brain, calls, said } = brainWith({ reply: () => (continuing ? text('The cheapest is Mug, $4.') : toolCall()) });
  await brain.processUserInput('Which product here is the cheapest?', 1);
  assert.match(said.at(-1), /stopped before finishing\. Want me to keep going\?/);

  continuing = true;
  await brain.processUserInput('keep going', 1);
  const next = calls.at(-1).contents;
  assert.deepEqual(userTexts(next), ['Which product here is the cheapest?', 'keep going']);
  assert.ok(modelTexts(next).some(t => /not finished yet/.test(t)), 'the history says the task was not finished');
  assert.equal(said.at(-1), 'The cheapest is Mug, $4.');
});

test('after a stopped task, "did you finish?" is asked with the unfinished task in view', async () => {
  let asked = 0;
  const { brain, calls } = brainWith({ reply: () => (asked ? text('No, I stopped before finishing.') : toolCall()) });
  await brain.processUserInput('Compare every product price', 1);
  asked = 1;
  await brain.processUserInput('did you finish', 1);
  const next = calls.at(-1).contents;
  assert.equal(userTexts(next)[0], 'Compare every product price');
  assert.ok(modelTexts(next).some(t => /not finished yet/.test(t)));
});

test('an empty Gemini turn is asked once more, then explained, never silent', async () => {
  const { brain, calls, said } = brainWith({ reply: () => empty() });
  await brain.processUserInput('keep going keep going', 1);
  assert.equal(calls.length, 2, 'one retry, no more');
  assert.match(said.at(-1), /empty answer/);

  // The explanation is kept in the history, so the next request is valid.
  await brain.processUserInput('try again', 1);
  const next = calls.at(-1).contents;
  assert.ok(next.every(m => m.parts.length > 0), 'no empty turns are sent back');
  assert.ok(modelTexts(next).some(t => /empty answer/.test(t)));
});

test('a malformed tool call is retried once and the retry answers', async () => {
  const { brain, said } = brainWith({ reply: (_c, n) => (n === 1 ? empty('MALFORMED_FUNCTION_CALL') : text('Found it.')) });
  await brain.processUserInput('find the price', 1);
  assert.deepEqual(said, ['Found it.']);
});

test('a blocked answer says why instead of retrying', async () => {
  const { brain, calls, said } = brainWith({ reply: () => empty('SAFETY') });
  await brain.processUserInput('something', 1);
  assert.equal(calls.length, 1);
  assert.match(said.at(-1), /safety filter/);
});

test('an overloaded model falls back to the next one', async () => {
  const overloaded = new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}');
  const { brain, calls, said } = brainWith({ reply: call => { if (call.model === 'model-a') throw overloaded; return text('Answer from the fallback.'); } });
  await brain.processUserInput('which is cheapest', 1);
  assert.deepEqual(calls.map(c => c.model), ['model-a', 'gemini-3.5-flash-lite']);
  assert.deepEqual(said, ['Answer from the fallback.']);
});

test('when every model stays overloaded, one retry round, then a clear message', async () => {
  const { brain, calls, said } = brainWith({ fastTimers: true, reply: () => { throw new Error('503 UNAVAILABLE: high demand'); } });
  await brain.processUserInput('which is cheapest', 1);
  assert.equal(calls.length, 6, 'three models, twice');
  assert.match(said.at(-1), /Gemini is overloaded right now/);
});

test('the last three tool results stay readable; older ones are cleared', async () => {
  const { brain, calls } = brainWith({
    reply: (_c, n) => (n <= 5 ? toolCall('get_page_text') : text('Done comparing.')),
    tool: (_name, _args, n) => ({ text: `chunk ${n}` }),
  });
  await brain.processUserInput('compare the prices on this page', 1);
  const results = calls.at(-1).contents.flatMap(m => m.parts).filter(p => p.functionResponse)
    .map(p => p.functionResponse.response.result);
  assert.equal(results.length, 5);
  assert.match(results[0], /cleared/);
  assert.match(results[1], /cleared/);
  assert.deepEqual(results.slice(2).map(r => r.text), ['chunk 3', 'chunk 4', 'chunk 5']);
});

test('a finished long task stays whole in the next request', async () => {
  const { brain, calls } = brainWith({ reply: (_c, n) => (n <= 6 ? toolCall() : text(n === 7 ? 'Mug is cheapest.' : 'It costs $4.')) });
  await brain.processUserInput('Which product is cheapest?', 1);
  await brain.processUserInput('How much is it?', 1);
  const next = calls.at(-1).contents;
  assert.equal(next[0].parts[0].text, 'Which product is cheapest?');
  assert.deepEqual(userTexts(next), ['Which product is cheapest?', 'How much is it?']);
});

test('Groq/OpenRouter: an empty reply is explained and kept, the step limit is remembered', async () => {
  let mode = 'empty';
  const ok = message => ({ ok: true, json: async () => ({ choices: [{ message }], usage: {} }) });
  const { brain, calls, said } = brainWith({
    provider: 'groq',
    fetchReply: () => (mode === 'empty'
      ? ok({ role: 'assistant', content: '' })
      : ok({ role: 'assistant', content: null, tool_calls: [{ id: `c${calls.length}`, type: 'function', function: { name: 'read_screen', arguments: '{}' } }] })),
  });
  await brain.processUserInput('hello there', 1);
  assert.match(said.at(-1), /empty answer/);

  mode = 'tools';
  await brain.processUserInput('Which product is cheapest?', 1);
  assert.match(said.at(-1), /keep going/);
  mode = 'empty';
  await brain.processUserInput('keep going', 1);
  const messages = calls.at(-1).messages;
  assert.ok(messages.some(m => m.role === 'user' && m.content === 'Which product is cheapest?'));
  assert.ok(messages.some(m => m.role === 'assistant' && /not finished yet/.test(m.content)));
  assert.ok(messages.filter(m => m.role === 'assistant').every(m => m.content || m.tool_calls?.length), 'no empty assistant turns');
});
