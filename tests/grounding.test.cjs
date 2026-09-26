const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// A reply's checkable facts must come from what its tools read (or what the
// user said). Anything else is marked unverified in the chat.

function grounding() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/background/grounding.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, JSON, Map, Set, Number, String, RegExp, Array, Math });
  return exports;
}
const plain = v => JSON.parse(JSON.stringify(v));

const PAGE = `URL: https://shop.example/
# Kettle & Co.
Blue Kettle — $39.00
Steel Kettle — $24.50
Returns accepted within 30 days. Refunds arrive in 5 business days.
The summit runs from 4 May 2031. Press: press@northwind.example
Organisers expect about 12,000 delegates.`;

test('grounding: facts found in what the tools read pass, in any format', () => {
  const g = grounding();
  g.addEvidence('echo-analyst', { content: [{ type: 'text', text: PAGE }] });
  const reply = 'The Blue Kettle costs $39 and the Steel Kettle $24.50. You have 30 days to return it; refunds take 5 business days. '
    + 'The summit starts May 4, 2031 with about 12000 delegates. Contact press@northwind.example. I found 2 kettles.';
  assert.deepEqual(plain(g.unverifiedClaims('echo-analyst', reply)), []);
});

test('grounding: made-up prices, figures, dates, years and emails are flagged', () => {
  const g = grounding();
  g.addEvidence('echo-analyst', PAGE);
  const reply = 'It costs $19.99 (was $39.00). You have 45 days to return it. It starts June 5, 2031, not in 2030. Email sales@northwind.example.';
  assert.deepEqual(plain(g.unverifiedClaims('echo-analyst', reply)), ['$19.99', '45 days', 'June 5, 2031', '2030', 'sales@northwind.example']);
});

test('grounding: quoted phrases must be word for word', () => {
  const g = grounding();
  g.addEvidence('echo', PAGE);
  assert.deepEqual(plain(g.unverifiedClaims('echo', 'The page says "Returns accepted within 30 days."')), []);
  assert.deepEqual(plain(g.unverifiedClaims('echo', 'The page says "free returns for thirty days"')), ['"free returns for thirty days"']);
});

test('grounding: what the user said may be repeated back', () => {
  const g = grounding();
  g.addEvidence('echo', 'Fill the form with phone 555-0142 and budget $2,500');
  assert.deepEqual(plain(g.unverifiedClaims('echo', 'I typed 555-0142 and set the budget to $2,500.')), []);
});

test('grounding: each scope has its own evidence, and none means nothing to judge', () => {
  const g = grounding();
  g.addEvidence('echo-analyst', PAGE);
  assert.deepEqual(plain(g.unverifiedClaims('echo-style', 'It costs $39.00.')), [], 'no evidence here (e.g. after a restart): no flags');
  g.addEvidence('echo-style', 'Glass Kettle — $52.00');
  assert.deepEqual(plain(g.unverifiedClaims('echo-style', 'It costs $39.00.')), ['$39.00'], 'another avatar\'s page is not evidence');
  g.resetEvidence('echo-analyst');
  assert.deepEqual(plain(g.unverifiedClaims('echo-analyst', 'It costs $99.')), []);
});

test('grounding: an address is known once a page or the user has shown it', () => {
  const g = grounding();
  g.addEvidence('echo', 'Open https://Shop.example/Deals?week=40 please');
  assert.equal(g.mentioned('echo', 'shop.example/deals?week=40'), true);
  assert.equal(g.mentioned('echo', 'shop.example/contact.html'), false);
  assert.equal(g.mentioned('echo-style', 'shop.example/deals?week=40'), false, 'another scope has not seen it');
});
