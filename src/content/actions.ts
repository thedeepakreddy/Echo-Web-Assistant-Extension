// ECHO content-script DOM engine.
//
// The agent "sees" the page through read_screen, which numbers every visible
// interactive element and remembers them here. All follow-up actions
// (click_element, type_text) address those numbers instead of raw x/y
// coordinates — this is far more reliable than document.elementFromPoint,
// which breaks with fixed headers, overlays, and any scrolling.

import { extractPattern, extractList, PatternKind } from './extractors';
import { snapshot, resolveRef, sensitiveField } from './snapshot';
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

/**
 * The element an action targets: a reference from the agent's page view
 * (checked to still be the same control), or a number from read_screen.
 */
function target(args: any): HTMLElement | undefined {
  if (args?.ref) return resolveRef(args.ref, args.doc);
  return echoElements[Number(args?.index)];
}

function setFieldValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  // The native setter, so React/Vue controlled inputs register the change.
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
    : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
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

    case 'snapshot':
      return { success: true, result: snapshot(args || {}) };

    case 'click_element': {
      const idx = args.ref ? String(args.ref) : Number(args.index);
      const el = target(args);
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
      // A link that opens a new tab: Chrome blocks that as a pop-up when a
      // script clicks it, so ECHO opens the address itself.
      const link = el.closest('a[href]') as HTMLAnchorElement | null;
      if (link && /^https?:/i.test(link.href) && link.target && !['_self', '_top', '_parent'].includes(link.target.toLowerCase())) {
        return { success: true, result: { clicked: `Clicked [${idx}] ${label}`, newTabUrl: link.href } };
      }
      el.click();
      return { success: true, result: `Clicked [${idx}] ${label}` };
    }

    case 'type_text': {
      const idx = args.ref ? String(args.ref) : Number(args.index);
      const el = target(args) as HTMLInputElement | HTMLTextAreaElement | HTMLElement;
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
        setFieldValue(el as HTMLInputElement | HTMLTextAreaElement, text);
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

    case 'select_option': {
      const el = target(args);
      if (!(el instanceof HTMLSelectElement)) {
        return { success: false, error: 'That is not a drop-down list. Click it, observe, then click the option.' };
      }
      if (args.expectedLabel && describe(el) !== args.expectedLabel) {
        return { success: false, error: 'The list changed after approval. Observe again.' };
      }
      const want = String(args.option ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const options = Array.from(el.options);
      const option = options.find(o => o.text.replace(/\s+/g, ' ').trim().toLowerCase() === want || o.value.toLowerCase() === want)
        || options.find(o => o.text.toLowerCase().includes(want));
      if (!want || !option) {
        return { success: false, error: `No option "${args.option}". Options: ${options.slice(0, 20).map(o => `"${o.text.trim()}"`).join(', ')}` };
      }
      setFieldValue(el, option.value);
      return { success: true, result: `Chose "${option.text.trim()}" in ${args.ref}` };
    }

    case 'set_checked': {
      const el = target(args);
      if (!el) return { success: false, error: 'No such element. Observe again.' };
      if (args.expectedLabel && describe(el) !== args.expectedLabel) {
        return { success: false, error: 'The control changed after approval. Observe again.' };
      }
      const isOn = () => (el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true');
      const want = args.checked !== false;
      if (isOn() !== want) el.click();
      return isOn() === want
        ? { success: true, result: `${args.ref} is now ${want ? 'checked' : 'unchecked'}` }
        : { success: false, error: `${args.ref} did not change. Observe the page to see why.` };
    }

    case 'check_field': {
      // For verify: compare a field without ever returning what it holds.
      const el = target(args);
      if (!el) return { success: false, error: 'No such element. Observe again.' };
      const value = el instanceof HTMLSelectElement ? (el.selectedOptions[0]?.text || '')
        : el.isContentEditable ? el.innerText : String((el as HTMLInputElement).value ?? '');
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
      const checks: { check: string; pass: boolean }[] = [];
      if (typeof args.filled === 'boolean') checks.push({ check: `${args.ref} is ${args.filled ? 'filled' : 'empty'}`, pass: !!norm(value) === args.filled });
      if (typeof args.equals === 'string') checks.push({ check: `${args.ref} holds "${args.equals}"`, pass: !sensitiveField(el) && norm(value) === norm(args.equals) });
      if (typeof args.checked === 'boolean') {
        const on = el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true';
        checks.push({ check: `${args.ref} is ${args.checked ? 'checked' : 'unchecked'}`, pass: on === args.checked });
      }
      return { success: true, result: checks };
    }

    case 'find_texts': {
      // For verify: which of these exact texts the whole page shows, with the
      // words around each as proof. ECHO's own panel is not part of the page.
      const own = document.getElementById('echo-extension-root');
      const body = (document.body?.innerText || '').replace(own?.innerText || '\u0000', '');
      const flat = body.replace(/\s+/g, ' ');
      const lower = flat.toLowerCase();
      const texts: string[] = Array.isArray(args.texts) ? args.texts.map(String).slice(0, 10) : [];
      return { success: true, result: texts.map(text => {
        const at = lower.indexOf(text.replace(/\s+/g, ' ').trim().toLowerCase());
        return { text, found: at >= 0, context: at >= 0 ? flat.slice(Math.max(0, at - 80), at + text.length + 80).trim() : undefined };
      }) };
    }

    case 'extract_list':
      return { success: true, result: extractList(Number(args.index) || 0) };

    case 'inspect_action': {
      const wanted = String(args.action || '');
      const index = Number(args.index);
      let el: HTMLElement | undefined;
      try { el = args.ref ? resolveRef(args.ref, args.doc) : Number.isInteger(index) ? echoElements[index] : undefined; }
      catch (error: any) { return { success: false, error: error.message }; }
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
