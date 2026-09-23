// Tier 1 — in-page highlighting.
//
// Selecting text pops a small ECHO chip; clicking it stores the selection in
// IndexedDB via the background. On a later visit the saved passages are found
// again by text and re-wrapped, so your marks come back without any server.

let chip: HTMLElement | null = null;
let chipTimer: number | null = null;
let injected = false;

const MARK_CLASS = 'echo-hl-mark';

function removeChip() {
  chip?.remove();
  chip = null;
  if (chipTimer) { window.clearTimeout(chipTimer); chipTimer = null; }
}

function showChip(x: number, y: number, text: string) {
  removeChip();
  chip = document.createElement('div');
  chip.className = 'echo-hl-chip';
  // ECHO's glass look, inline because the chip lives outside ECHO's own root.
  const mark = document.createElement('span');
  Object.assign(mark.style, {
    width: '8px', height: '8px', borderRadius: '50%', flex: 'none',
    background: 'linear-gradient(135deg, #b8a1ff, #ff9fd0)',
    boxShadow: '0 0 8px rgba(184,161,255,0.8)',
  } as CSSStyleDeclaration);
  chip.append(mark, document.createTextNode('Save to ECHO'));
  Object.assign(chip.style, {
    position: 'absolute',
    left: `${Math.max(8, x - 60)}px`,
    top: `${Math.max(8, y - 44)}px`,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    background: 'linear-gradient(180deg, rgba(255,255,255,0.12), rgba(255,255,255,0.03)), rgba(20,22,32,0.78)',
    backdropFilter: 'blur(24px) saturate(180%)',
    color: 'rgba(255,255,255,0.95)',
    border: '1px solid rgba(255,255,255,0.16)',
    borderRadius: '999px',
    padding: '7px 14px 7px 11px',
    font: '600 12px/1.2 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif',
    letterSpacing: '-0.006em',
    cursor: 'pointer',
    zIndex: '2147483646',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.26), 0 10px 28px rgba(0,0,0,0.35)',
    userSelect: 'none',
    whiteSpace: 'nowrap',
  } as CSSStyleDeclaration);

  chip.addEventListener('mousedown', (e) => {
    // mousedown, not click — click would clear the selection first.
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({
      type: 'ECHO_SAVE_HIGHLIGHT',
      text,
      url: location.href,
      title: document.title,
    }).catch(() => {});
    paintSelection();
    removeChip();
    window.getSelection()?.removeAllRanges();
  });

  document.body.appendChild(chip);
  // Don't leave the chip hanging around if the user ignores it.
  chipTimer = window.setTimeout(removeChip, 6000);
}

function onSelectionEnd(e: MouseEvent) {
  if ((e.target as HTMLElement)?.closest?.('#echo-extension-root, .echo-hl-chip')) return;
  window.setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() || '';
    if (text.length < 12 || text.length > 1200) { removeChip(); return; }
    const range = sel!.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) { removeChip(); return; }
    showChip(rect.left + window.scrollX + rect.width / 2, rect.top + window.scrollY, text);
  }, 10);
}

/** Wrap the current selection in a mark so the user sees it took. */
function paintSelection() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  try {
    const mark = document.createElement('mark');
    mark.className = MARK_CLASS;
    mark.style.background = 'rgba(74,144,226,0.30)';
    mark.style.color = 'inherit';
    mark.style.borderRadius = '2px';
    range.surroundContents(mark);
  } catch {
    // surroundContents throws when the range crosses element boundaries;
    // the highlight is still saved, we just can't paint it this time.
  }
}

/** Re-apply stored highlights by locating their text in the document. */
export function renderHighlights(texts: string[]): number {
  if (!texts?.length) return 0;
  let painted = 0;

  for (const target of texts) {
    const needle = target.replace(/\s+/g, ' ').trim();
    if (needle.length < 12) continue;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest('#echo-extension-root, script, style, noscript')) return NodeFilter.FILTER_REJECT;
        if (p.classList.contains(MARK_CLASS)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    let node: Node | null;
    let done = false;
    while (!done && (node = walker.nextNode())) {
      const content = node.textContent || '';
      // Only single-node matches; cross-element passages are skipped rather
      // than risking a mangled DOM.
      const idx = content.replace(/\s+/g, ' ').indexOf(needle);
      if (idx === -1) continue;
      try {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, Math.min(idx + needle.length, content.length));
        const mark = document.createElement('mark');
        mark.className = MARK_CLASS;
        mark.style.background = 'rgba(74,144,226,0.30)';
        mark.style.color = 'inherit';
        mark.style.borderRadius = '2px';
        range.surroundContents(mark);
        painted++;
        done = true;
      } catch { /* skip this occurrence */ }
    }
  }
  return painted;
}

export function clearRenderedHighlights(): void {
  document.querySelectorAll(`mark.${MARK_CLASS}`).forEach(m => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  });
}

export function initHighlighter(): void {
  if (injected) return;
  injected = true;
  document.addEventListener('mouseup', onSelectionEnd, true);
  document.addEventListener('scroll', removeChip, { passive: true });
}
