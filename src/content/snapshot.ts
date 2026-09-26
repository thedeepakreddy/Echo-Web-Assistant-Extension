// What an agent sees of a page: its text and controls in reading order, each
// control with a reference (e12) that stays the same while the control is on
// the page. Asking again returns only what changed. A reference is checked
// before every action, so an out-of-date one fails instead of acting on the
// wrong element, and references never carry over to a newly loaded page.

/** This page load. Actions name the page they were planned on; a reload makes them stale. */
export const DOC_ID = Math.random().toString(36).slice(2, 10);

const INTERACTIVE = [
  'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select', 'summary',
  '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]', '[role="checkbox"]',
  '[role="radio"]', '[role="switch"]', '[role="option"]', '[role="combobox"]', '[role="textbox"]',
  '[role="searchbox"]', '[onclick]', '[contenteditable="true"]', '[contenteditable=""]',
].join(',');
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED',
  'HEAD', 'META', 'LINK', 'AUDIO', 'VIDEO', 'MAP']);
const BLOCK_TAGS = new Set(['DIV', 'P', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ASIDE', 'UL', 'OL',
  'LI', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'CAPTION', 'FORM', 'FIELDSET', 'LEGEND', 'DL', 'DT', 'DD', 'BLOCKQUOTE',
  'PRE', 'FIGURE', 'FIGCAPTION', 'DETAILS', 'DIALOG', 'ADDRESS', 'HR', 'BODY']);
const OWN_UI = 'echo-extension-root';

const NAME_MAX = 80;
const TEXT_LINE_MAX = 400;
const DEFAULT_BUDGET = 6000;
const MAX_LINES = 3000;
// Beyond this share of changed lines, a full view is cheaper to read than the changes.
const DIFF_LIMIT = 0.4;

const refOf = new WeakMap<Element, string>();
const byRef = new Map<string, WeakRef<HTMLElement>>();
const fingerprint = new Map<string, { role: string; name: string }>();
let nextRef = 1;
let last: { url: string; lines: string[] } | null = null;

const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Password, payment and one-time-code fields: ECHO never types into them or reads them out. */
export function sensitiveField(el: Element): boolean {
  const hints = [el.getAttribute('type'), el.getAttribute('name'), el.getAttribute('id'),
    el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.getAttribute('placeholder')]
    .filter(Boolean).join(' ');
  return /pass(word|wd)|\b(cvv|cvc|otp|pin|ssn|token|secret|verification.?code|security.?code)\b|credit.?card|card.?number|\bcc-(number|csc|exp)/i.test(hints);
}

function visible(el: Element): boolean {
  if ((el as HTMLElement).hidden || el.getAttribute('aria-hidden') === 'true') return false;
  if (typeof (el as any).checkVisibility === 'function') {
    if ((el as any).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return true;
    // Boxless containers (display: contents) still show their children.
    return getComputedStyle(el).display === 'contents';
  }
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

function roleOf(el: HTMLElement): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.split(' ')[0];
  const tag = el.tagName;
  if (tag === 'A') return 'link';
  if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
  if (tag === 'SELECT') return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
  if (tag === 'TEXTAREA') return 'textbox';
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    if (type === 'checkbox' || type === 'radio') return type;
    if (type === 'search') return 'searchbox';
    if (type === 'range') return 'slider';
    if (['file', 'color', 'date', 'datetime-local', 'month', 'time', 'week'].includes(type)) return type;
    return 'textbox';
  }
  if (el.isContentEditable) return 'textbox';
  return 'clickable';
}

/** A label's own words, without the text of the control inside it (a list's options). */
function labelText(label: Element, control: Element): string {
  let text = '';
  const walk = (node: Node) => {
    if (node === control) return;
    if (node.nodeType === Node.TEXT_NODE) { text += ` ${node.textContent || ''}`; return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (['SELECT', 'TEXTAREA', 'INPUT', 'BUTTON', 'SCRIPT', 'STYLE', 'OPTION'].includes((node as Element).tagName)) return;
    for (const child of Array.from(node.childNodes)) walk(child);
  };
  walk(label);
  return clean(text);
}

function textOfIds(ids: string): string {
  return ids.split(/\s+/).map(id => clean(document.getElementById(id)?.innerText)).filter(Boolean).join(' ');
}

/** The name a person would read for a control (never a field's typed value). */
function nameOf(el: HTMLElement, role: string): string {
  const aria = clean(el.getAttribute('aria-label')) || (el.getAttribute('aria-labelledby') ? textOfIds(el.getAttribute('aria-labelledby')!) : '');
  if (aria) return aria;
  const field = ['textbox', 'searchbox', 'combobox', 'listbox', 'checkbox', 'radio', 'slider'].includes(role)
    || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
  if (field) {
    const owner = (el as HTMLInputElement).labels?.[0] || el.closest('label');
    const label = owner ? labelText(owner, el) : '';
    if (label) return label;
    return clean(el.getAttribute('placeholder')) || clean(el.getAttribute('title')) || clean(el.getAttribute('name'));
  }
  if (el.tagName === 'INPUT') return clean((el as HTMLInputElement).value) || clean(el.getAttribute('title'));
  return clean(el.innerText) || clean(el.getAttribute('title'))
    || clean(el.querySelector('img[alt]')?.getAttribute('alt')) || clean(el.getAttribute('name'));
}

function statesOf(el: HTMLElement, role: string): string[] {
  const states: string[] = [];
  if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') states.push('disabled');
  if (role === 'checkbox' || role === 'radio' || role === 'switch') {
    const on = el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true';
    states.push(on ? 'checked' : 'unchecked');
  }
  const expanded = el.getAttribute('aria-expanded');
  if (expanded) states.push(expanded === 'true' ? 'expanded' : 'collapsed');
  if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current')) states.push('current');
  if (role === 'textbox' || role === 'searchbox') {
    if (sensitiveField(el)) states.push('protected');
    else {
      const value = el.isContentEditable ? el.innerText : (el as HTMLInputElement).value;
      states.push(clean(value) ? 'filled' : 'empty');
    }
  }
  if ((el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true') states.push('required');
  return states;
}

function refFor(el: HTMLElement): string {
  let ref = refOf.get(el);
  if (!ref) {
    ref = `e${nextRef++}`;
    refOf.set(el, ref);
    byRef.set(ref, new WeakRef(el));
  }
  return ref;
}

/** One control as the agent reads it: [e12] button "Add to cart" (disabled). */
function controlLine(el: HTMLElement): string {
  const role = roleOf(el);
  const full = nameOf(el, role);
  const name = cut(full, NAME_MAX);
  const ref = refFor(el);
  fingerprint.set(ref, { role, name: loose(full) });
  let line = `[${ref}] ${role}${name ? ` "${name}"` : ''}`;
  if (el.tagName === 'SELECT') {
    const chosen = (el as HTMLSelectElement).selectedOptions?.[0];
    if (chosen) line += ` = "${cut(clean(chosen.text), NAME_MAX)}"`;
  }
  const states = statesOf(el, role);
  return states.length ? `${line} (${states.join(', ')})` : line;
}

/**
 * Names compared loosely: counts and punctuation often change ("Cart (2)"),
 * and only the start of a long name (a product card) says which control it is.
 */
function loose(name: string): string {
  return name.toLowerCase().replace(/[\d\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** Every visible line of the page in reading order. */
function pageLines(): string[] {
  const lines: string[] = [];
  let buffer = '';
  const flush = () => {
    const text = clean(buffer);
    buffer = '';
    if (text && lines[lines.length - 1] !== text) lines.push(cut(text, TEXT_LINE_MAX));
  };
  // quiet: inside a label that names a control, whose line already carries the words.
  const visit = (node: Node, quiet = false) => {
    if (lines.length >= MAX_LINES) return;
    if (node.nodeType === Node.TEXT_NODE) { if (!quiet) buffer += ` ${node.textContent || ''}`; return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (SKIP_TAGS.has(el.tagName.toUpperCase()) || el.id === OWN_UI || !visible(el)) return;
    if (el.tagName === 'BR') { flush(); return; }
    if (el.matches(INTERACTIVE)) {
      flush();
      lines.push(controlLine(el));
      // A clickable card (a product tile, a search result) keeps its text:
      // its name shows only the start of it.
      const role = roleOf(el);
      if (['link', 'clickable', 'button', 'option', 'menuitem', 'tab'].includes(role) && clean(el.innerText).length > NAME_MAX) {
        for (const child of Array.from(el.childNodes)) visit(child);
        flush();
      }
      return;
    }
    const heading = /^H[1-6]$/.test(el.tagName) ? Number(el.tagName[1])
      : el.getAttribute('role') === 'heading' ? Number(el.getAttribute('aria-level') || 2) : 0;
    if (heading && !el.querySelector(INTERACTIVE)) {
      flush();
      const text = clean(el.innerText);
      if (text) lines.push(`${'#'.repeat(Math.min(heading, 6))} ${cut(text, TEXT_LINE_MAX)}`);
      return;
    }
    if (el.tagName === 'TD' || el.tagName === 'TH') { if (clean(buffer)) buffer += ' |'; }
    const block = BLOCK_TAGS.has(el.tagName) || !!heading;
    const naming = quiet || (el.tagName === 'LABEL' && !!(el as HTMLLabelElement).control);
    if (block) flush();
    for (const child of Array.from(el.childNodes)) visit(child, naming);
    if (el.shadowRoot) for (const child of Array.from(el.shadowRoot.childNodes)) visit(child, naming);
    if (block) flush();
  };
  if (document.body) visit(document.body);
  flush();
  return lines;
}

/** Line-level changes from `a` to `b` (longest common subsequence). */
function diffLines(a: string[], b: string[]): string[] {
  const n = a.length, m = b.length;
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out;
}

export interface SnapshotArgs {
  /** Always return the whole page, not just what changed. */
  full?: boolean;
  /** Start at this line (for pages longer than one view). */
  from?: number;
  /** Characters of lines to return. */
  budget?: number;
}

/**
 * The page for an agent. After the first view of a page, only the changes
 * since the last view are returned, unless the page changed a lot or `full`
 * is set.
 */
export function snapshot(args: SnapshotArgs = {}): { doc: string; text: string } {
  const lines = pageLines();
  const url = location.href.split('#')[0];
  const head = `URL: ${location.href}\nTITLE: ${clean(document.title)}`;
  const previous = last;
  last = { url, lines };
  const from = Math.max(0, Math.floor(Number(args.from) || 0));

  if (!args.full && !from && previous && previous.url === url && lines.length * previous.lines.length < 4_000_000) {
    const changes = diffLines(previous.lines, lines);
    if (!changes.length) return { doc: DOC_ID, text: `${head}\nNo changes since your last observe.` };
    if (changes.length <= Math.max(8, lines.length * DIFF_LIMIT)) {
      return { doc: DOC_ID, text: `${head}\nChanges since your last observe (+ added, - removed):\n${changes.join('\n')}` };
    }
  }

  const budget = Math.max(500, Math.min(20_000, Math.floor(Number(args.budget) || DEFAULT_BUDGET)));
  const shown: string[] = [];
  let used = 0;
  let i = from;
  for (; i < lines.length; i++) {
    if (used + lines[i].length > budget && shown.length) break;
    shown.push(lines[i]);
    used += lines[i].length + 1;
  }
  const rest = lines.length - i;
  const tail = rest > 0 ? `\n… ${rest} more lines. Observe with from: ${i} to see them.` : '';
  const empty = lines.length ? '' : '\n(The page shows no text or controls yet. It may still be loading.)';
  return { doc: DOC_ID, text: `${head}${from ? `\nLines from ${from}:` : ''}\n${shown.join('\n')}${tail}${empty}` };
}

/**
 * The element behind a reference, if it is still the same control on this
 * page. Anything else is an error that tells the agent to look again.
 */
export function resolveRef(ref: unknown, doc?: unknown): HTMLElement {
  const id = String(ref || '').trim().replace(/^\[|\]$/g, '');
  if (doc && doc !== DOC_ID) throw new Error('A new page has loaded since your last observe. Observe again.');
  const el = byRef.get(id)?.deref();
  if (!el) throw new Error(`There is no ${id || 'element'} on this page. Observe again.`);
  if (!el.isConnected) throw new Error(`${id} is no longer on the page. Observe again.`);
  const was = fingerprint.get(id);
  const role = roleOf(el);
  const now = loose(nameOf(el, role));
  if (was && (was.role !== role || (was.name && now && was.name !== now))) {
    throw new Error(`${id} has changed since your last observe (it was ${was.role} "${was.name}"). Observe again.`);
  }
  if (!visible(el)) throw new Error(`${id} is hidden right now. Observe again.`);
  return el;
}

/** Forget the last view, so the next observe shows the whole page. */
export function resetSnapshot(): void {
  last = null;
}
