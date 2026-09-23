// ECHO content-script DOM engine.
//
// The agent "sees" the page through read_screen, which numbers every visible
// interactive element and remembers them here. All follow-up actions
// (click_element, type_text) address those numbers instead of raw x/y
// coordinates — this is far more reliable than document.elementFromPoint,
// which breaks with fixed headers, overlays, and any scrolling.

import { extractPattern, PatternKind } from './extractors';
import { fillForm } from './form-filler';
import { startRecording, stopRecording, playStep, RecordedStep } from './recorder';
import { renderHighlights, clearRenderedHighlights } from './highlighter';

let echoElements: HTMLElement[] = [];

const INTERACTIVE_SELECTOR = [
  'a[href]', 'button', 'input', 'textarea', 'select',
  '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
  '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="option"]',
  '[onclick]', '[contenteditable="true"]', '[contenteditable=""]'
].join(',');

const MAX_ELEMENTS = 25;
const LABEL_MAX = 40;
const PAGE_TEXT_MAX = 700;

function isVisible(el: Element): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  // Must be at least partially within the viewport.
  return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
}

function describe(el: HTMLElement): string {
  const tag = el.tagName.toLowerCase();
  const inputType = tag === 'input' ? ((el as HTMLInputElement).type || 'text').toLowerCase() : '';
  // Never expose a field's current value to a model. Passwords are especially
  // dangerous, but email, payment, and one-time-code fields can be secrets too.
  const controlText = tag === 'input' || tag === 'textarea' || el.isContentEditable
    ? ''
    : (el as HTMLElement).innerText || '';
  let label = (
    controlText ||
    el.getAttribute('aria-label') ||
    el.getAttribute('placeholder') ||
    el.getAttribute('title') ||
    el.getAttribute('name') ||
    (inputType === 'button' || inputType === 'submit' ? (el as HTMLInputElement).value : '') ||
    el.getAttribute('alt') ||
    ''
  ).replace(/\s+/g, ' ').trim();

  // Note the kind of control so the model picks the right action.
  let kind = tag;
  if (tag === 'input') kind = `input:${(el as HTMLInputElement).type || 'text'}`;
  else if (el.getAttribute('role')) kind = el.getAttribute('role')!;
  else if (el.isContentEditable) kind = 'editable';

  if (!label) label = kind;
  return `<${kind}> "${label.substring(0, LABEL_MAX)}"`;
}

function sensitiveField(el: HTMLElement): boolean {
  const hints = [el.getAttribute('type'), el.getAttribute('name'), el.getAttribute('id'),
    el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.getAttribute('placeholder')]
    .filter(Boolean).join(' ');
  return /pass(word|wd)|\b(cvv|cvc|otp|pin|ssn|token|secret|verification.?code|security.?code)\b|credit.?card|card.?number|\bcc-(number|csc|exp)/i.test(hints);
}

export function handleDomAction(action: string, args: any): any {
  switch (action) {
    case 'read_screen': {
      echoElements = [];
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)).filter(isVisible).slice(0, 300);
      echoElements = candidates;
      const offset = Math.min(275, Math.max(0, Math.floor(Number(args?.offset) || 0)));
      let screenInfo = 'Numbered interactive elements (use the number with click_element / type_text):\n';

      for (let idx = offset; idx < Math.min(offset + MAX_ELEMENTS, candidates.length); idx++) {
        const el = candidates[idx];
        // Skip elements whose only content is another interactive we already have
        // (keeps the list focused on leaf controls).
        const desc = describe(el);
        screenInfo += `[${idx}] ${desc}\n`;
      }

      if (candidates.length === 0) {
        screenInfo += '(no interactive elements visible — try scrolling)\n';
      } else if (offset + MAX_ELEMENTS < candidates.length) {
        screenInfo += `More controls available. Call read_screen with offset ${offset + MAX_ELEMENTS}.\n`;
      }

      let pageText = (document.body?.innerText || '').replace(/\n\s*\n/g, '\n').trim();
      pageText = offset === 0 ? pageText.substring(0, PAGE_TEXT_MAX) : '(omitted on later control pages)';

      const url = location.href;
      const title = document.title;
      const result =
        `URL: ${url}\nTITLE: ${title}\n\n${screenInfo}\n--- Visible text (truncated) ---\n${pageText}`;
      return { success: true, result };
    }

    case 'click_element': {
      const idx = Number(args.index);
      const el = echoElements[idx];
      if (!el) {
        return { success: false, error: `No element [${args.index}]. Call read_screen again to refresh the numbered list.` };
      }
      if (!el.isConnected || (args.expectedLabel && describe(el) !== args.expectedLabel)) {
        return { success: false, error: 'The page changed after approval. Read the screen again.' };
      }
      try {
        el.scrollIntoView({ block: 'center', inline: 'center' });
      } catch { /* ignore */ }
      const label = describe(el);
      el.click();
      return { success: true, result: `Clicked [${idx}] ${label}` };
    }

    case 'type_text': {
      const idx = Number(args.index);
      const el = echoElements[idx] as HTMLInputElement | HTMLTextAreaElement | HTMLElement;
      if (!el) {
        return { success: false, error: `No element [${args.index}]. Call read_screen again to refresh the numbered list.` };
      }
      if (!el.isConnected || (args.expectedLabel && describe(el as HTMLElement) !== args.expectedLabel)) {
        return { success: false, error: 'The field changed after approval. Read the screen again.' };
      }
      if (!['INPUT', 'TEXTAREA'].includes(el.tagName) && !el.isContentEditable) {
        return { success: false, error: 'That element is not an editable field.' };
      }
      if (sensitiveField(el as HTMLElement)) {
        return { success: false, error: 'ECHO will not type into password, payment, or verification fields.' };
      }
      const text = String(args.text ?? '');
      const el2 = el as HTMLElement;
      try { el2.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
      (el2 as HTMLElement).focus();

      if (el2.isContentEditable) {
        el2.textContent = text;
        el2.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        const input = el as HTMLInputElement | HTMLTextAreaElement;
        // Use the native value setter so React/Vue controlled inputs register the change.
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(input, text);
        else input.value = text;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }

      if (args.submit) {
        const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true } as any;
        el2.dispatchEvent(new KeyboardEvent('keydown', opts));
        el2.dispatchEvent(new KeyboardEvent('keypress', opts));
        el2.dispatchEvent(new KeyboardEvent('keyup', opts));
        const form = (el as HTMLInputElement).form;
        if (form) { try { form.requestSubmit(); } catch { /* ignore */ } }
      }
      return { success: true, result: `Typed into [${idx}]${args.submit ? ' and submitted' : ''}` };
    }

    case 'press_key': {
      const key = String(args.key || '');
      const keyMap: Record<string, number> = {
        Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46,
        ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ' ': 32
      };
      const code = keyMap[key] ?? 0;
      const target = (document.activeElement as HTMLElement) || document.body;
      const opts = { key, code: key, keyCode: code, which: code, bubbles: true } as any;
      target.dispatchEvent(new KeyboardEvent('keydown', opts));
      target.dispatchEvent(new KeyboardEvent('keypress', opts));
      target.dispatchEvent(new KeyboardEvent('keyup', opts));
      return { success: true, result: `Pressed ${key}` };
    }

    case 'scroll': {
      window.scrollBy({ top: Number(args.amount) || 0, behavior: 'smooth' });
      return { success: true, result: `Scrolled ${args.amount}px` };
    }

    case 'go_back': {
      history.back();
      return { success: true, result: 'Navigated back' };
    }

    case 'go_forward': {
      history.forward();
      return { success: true, result: 'Navigated forward' };
    }

    case 'find_on_page': {
      const query = String(args.text || '').toLowerCase();
      if (!query) return { success: false, error: 'No text provided' };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (node.textContent && node.textContent.toLowerCase().includes(query)) {
          const el = node.parentElement;
          if (el && isVisible(el)) {
            el.scrollIntoView({ block: 'center' });
            const prevOutline = el.style.outline;
            el.style.outline = '3px solid #4a90e2';
            setTimeout(() => { el.style.outline = prevOutline; }, 3000);
            return { success: true, result: `Found "${args.text}": ${node.textContent.trim().substring(0, 120)}` };
          }
        }
      }
      return { success: true, result: `"${args.text}" not found in visible text.` };
    }

    case 'get_page_text': {
      const main = document.querySelector('article, main, [role="main"]') as HTMLElement | null;
      const source = main && main.innerText.length > 200 ? main : document.body;
      const full = (source?.innerText || '').replace(/\n\s*\n/g, '\n').trim();
      const offset = Math.min(full.length, Math.max(0, Math.floor(Number(args?.offset) || 0)));
      const end = Math.min(full.length, offset + 4000);
      const text = full.substring(offset, end);
      return { success: true, result: `TITLE: ${document.title}\nTEXT: ${offset}-${end} of ${full.length}\n${end < full.length ? `NEXT_OFFSET: ${end}\n` : ''}\n${text}` };
    }

    case 'inspect_action': {
      const wanted = String(args.action || '');
      const index = Number(args.index);
      let el = Number.isInteger(index) ? echoElements[index] : undefined;
      if (!el && wanted === 'click_selector') {
        const selectors: string[] = Array.isArray(args.selectors) ? args.selectors : [String(args.selector || '')];
        for (const selector of selectors) {
          try { el = document.querySelector<HTMLElement>(selector) || undefined; } catch { /* try next */ }
          if (el) break;
        }
      }
      return { success: true, result: {
        label: el ? describe(el) : 'an element on this page',
        sensitive: !!el && sensitiveField(el),
      } };
    }

    case 'extract_table': {
      const tables = Array.from(document.querySelectorAll('table'));
      if (tables.length === 0) return { success: true, result: 'No tables found on this page.' };
      const wanted = Number.isFinite(Number(args.index)) ? Number(args.index) : 0;
      const table = tables[wanted] || tables[0];
      const rows = Array.from(table.querySelectorAll('tr')).slice(0, 200).map(tr =>
        Array.from(tr.querySelectorAll('th,td')).map(td => (td as HTMLElement).innerText.replace(/\s+/g, ' ').trim())
      );
      return { success: true, result: JSON.stringify({ tableIndex: wanted, totalTables: tables.length, rows }) };
    }

    // --- local (Tier 0/1) actions — no model involved ---------------------

    case 'extract_pattern': {
      const result = extractPattern(String(args.kind || 'emails') as PatternKind);
      return { success: true, result };
    }

    case 'fill_form': {
      const report = fillForm((args.memory || {}) as Record<string, string>);
      return { success: true, result: report };
    }

    case 'click_selector': {
      // Try each candidate selector until one resolves to a visible element.
      const selectors: string[] = Array.isArray(args.selectors) ? args.selectors : [String(args.selector || '')];
      for (const sel of selectors) {
        if (!sel) continue;
        try {
          const el = Array.from(document.querySelectorAll<HTMLElement>(sel)).find(isVisible);
          if (!el) continue;
          if (args.expectedLabel && describe(el) !== args.expectedLabel) {
            return { success: false, error: 'The target changed after approval.' };
          }
          try { el.scrollIntoView({ block: 'center' }); } catch { /* ignore */ }
          el.click();
          return { success: true, result: { clicked: true, selector: sel } };
        } catch { /* invalid selector — try the next */ }
      }
      return { success: true, result: { clicked: false } };
    }

    case 'read_value': {
      // Used by page watchers: read one element, or the whole page as fallback.
      const sel = args.selector ? String(args.selector) : '';
      let value = '';
      if (sel) {
        try {
          const el = document.querySelector<HTMLElement>(sel);
          value = el ? (el.innerText || (el as HTMLInputElement).value || '') : '';
        } catch { value = ''; }
      }
      if (!value) value = (document.body?.innerText || '').substring(0, 3000);
      return { success: true, result: { value: value.replace(/\s+/g, ' ').trim() } };
    }

    case 'record_start':
      return startRecording();

    case 'record_stop':
      return stopRecording();

    case 'play_step':
      return playStep(args as RecordedStep);

    case 'render_highlights': {
      const painted = renderHighlights((args.texts || []) as string[]);
      return { success: true, result: { painted } };
    }

    case 'clear_highlights': {
      clearRenderedHighlights();
      return { success: true, result: 'cleared' };
    }

    default:
      throw new Error(`Unknown DOM action: ${action}`);
  }
}
