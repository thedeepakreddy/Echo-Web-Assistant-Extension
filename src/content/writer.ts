// ECHO Writer, page side: remember exactly what the user selected when they
// right-clicked, then put the rewritten text back in the same place.

type Saved =
  | { requestId: string; kind: 'input'; el: HTMLInputElement | HTMLTextAreaElement; start: number; end: number; text: string }
  | { requestId: string; kind: 'editable'; root: HTMLElement; range: Range; text: string }
  | { requestId: string; kind: 'page'; text: string };

let saved: Saved | null = null;

const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', '']);
const SENSITIVE = /pass(word|wd)|\b(cvv|cvc|otp|pin|ssn|token|secret|security.?code|verification.?code)\b|credit.?card|card.?number|\bcc-(number|csc|exp)/i;

function isSensitive(el: HTMLElement): boolean {
  if ((el.getAttribute('type') || '').toLowerCase() === 'password') return true;
  return SENSITIVE.test(['type', 'name', 'id', 'autocomplete', 'aria-label', 'placeholder']
    .map(k => el.getAttribute(k) || '').join(' '));
}

function editableRoot(node: Node | null): HTMLElement | null {
  const el = node && (node.nodeType === 1 ? node as HTMLElement : node.parentElement);
  const host = el?.closest<HTMLElement>('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
  return host || null;
}

export function captureSelection(requestId: string): { success: boolean; text?: string; editable?: boolean; error?: string } {
  saved = null;
  const active = document.activeElement as HTMLElement | null;

  if (active && (active.tagName === 'TEXTAREA'
    || (active.tagName === 'INPUT' && TEXT_INPUTS.has(((active as HTMLInputElement).type || '').toLowerCase())))) {
    if (isSensitive(active)) return { success: false, error: "ECHO Writer doesn't work on password, payment or code fields." };
    const el = active as HTMLInputElement | HTMLTextAreaElement;
    let start = el.selectionStart ?? 0;
    let end = el.selectionEnd ?? 0;
    if (start === end) { start = 0; end = el.value.length; }   // nothing selected: the whole field
    const text = el.value.slice(start, end);
    saved = { requestId, kind: 'input', el, start, end, text };
    return { success: true, text, editable: true };
  }

  const selection = window.getSelection();
  if (selection && selection.rangeCount && !selection.isCollapsed) {
    const range = selection.getRangeAt(0).cloneRange();
    const text = selection.toString();
    const root = editableRoot(range.commonAncestorContainer);
    if (root) {
      if (isSensitive(root)) return { success: false, error: "ECHO Writer doesn't work on this field." };
      saved = { requestId, kind: 'editable', root, range, text };
      return { success: true, text, editable: true };
    }
    saved = { requestId, kind: 'page', text };
    return { success: true, text, editable: false };
  }

  const root = active && active.isContentEditable ? editableRoot(active) : null;
  if (root) {
    const range = document.createRange();
    range.selectNodeContents(root);
    const text = root.innerText;
    saved = { requestId, kind: 'editable', root, range, text };
    return { success: true, text, editable: true };
  }
  return { success: false, error: 'Select some text first.' };
}

/** Put `replacement` where the original selection was, if it is still there. */
export function replaceSelection(requestId: string, replacement: string): { success: boolean; error?: string } {
  const s = saved;
  if (!s || s.requestId !== requestId) return { success: false, error: 'That selection is gone. Select the text again.' };
  if (s.kind === 'page') return { success: false, error: "This text isn't editable. Use Copy instead." };

  if (s.kind === 'input') {
    const { el, start, end, text } = s;
    if (!el.isConnected || el.value.slice(start, end) !== text) {
      return { success: false, error: 'The text changed since you selected it. Use Copy instead.' };
    }
    el.focus();
    el.setSelectionRange(start, end);
    // insertText keeps the browser's undo history and fires the events apps listen for.
    if (!document.execCommand('insertText', false, replacement)) {
      el.setRangeText(replacement, start, end, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    saved = null;
    return { success: true };
  }

  const { root, range, text } = s;
  if (!root.isConnected || range.toString() !== text) {
    return { success: false, error: 'The text changed since you selected it. Use Copy instead.' };
  }
  root.focus();
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  if (!document.execCommand('insertText', false, replacement)) {
    range.deleteContents();
    range.insertNode(document.createTextNode(replacement));
    root.dispatchEvent(new Event('input', { bubbles: true }));
  }
  saved = null;
  return { success: true };
}
