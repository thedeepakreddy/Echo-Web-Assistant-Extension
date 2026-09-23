// Approval prompt rendered in an extension-origin iframe on the page. Page
// scripts cannot read or click into a cross-origin frame, so only a real user
// gesture here can answer. The background accepts answers only from this
// frame (in the prompt's own tab) or from the side panel.

import '../theme/glass.css';
import './approval.css';
import { resolveAppearance, themeFor, themeVars } from '../characters';

// Tint the prompt with the current character's colours.
chrome.storage.local.get('echo_avatar').then(r => {
  for (const [name, value] of Object.entries(themeVars(themeFor(resolveAppearance(r.echo_avatar))))) {
    document.body.style.setProperty(name, value);
  }
}).catch(() => {});

const id = new URL(location.href).searchParams.get('id') || '';
const detailEl = document.getElementById('detail')!;
const hintEl = document.getElementById('hint')!;
const allow = document.getElementById('allow') as HTMLButtonElement;
const deny = document.getElementById('deny') as HTMLButtonElement;
const box = document.getElementById('box')!;

// Clickjacking guard: Allow only arms after the prompt has been fully visible
// (not covered, faded or transformed by the page) for ARM_MS.
const ARM_MS = 700;
let loaded = false;
let visibleSince = 0;
let answered = false;

function refresh() {
  const armed = loaded && !answered && visibleSince > 0 && Date.now() - visibleSince >= ARM_MS;
  allow.disabled = !armed;
  // The hairline under the request fills while Allow waits to unlock.
  box.classList.toggle('arming-run', loaded && !answered && visibleSince > 0 && !armed);
  box.classList.toggle('armed', armed);
  if (loaded && !answered && visibleSince === 0) hintEl.textContent = 'Waiting until this prompt is fully visible…';
  else if (!answered) hintEl.textContent = '';
}

function setVisible(visible: boolean) {
  if (!visible) visibleSince = 0;
  else if (!visibleSince) {
    visibleSince = Date.now();
    setTimeout(refresh, ARM_MS + 20);
  }
  refresh();
}

if ('isVisible' in IntersectionObserverEntry.prototype) {
  // IntersectionObserver v2 reports occlusion and opacity from the embedding page.
  const observer = new IntersectionObserver(entries => {
    const entry = entries[entries.length - 1] as IntersectionObserverEntry & { isVisible?: boolean };
    setVisible(entry.isIntersecting && !!entry.isVisible);
  }, { trackVisibility: true, delay: 100 } as IntersectionObserverInit);
  observer.observe(box);
} else {
  setVisible(true);
}

function answer(approved: boolean, event: MouseEvent) {
  if (!event.isTrusted || answered) return;
  if (approved && allow.disabled) return;
  answered = true;
  allow.disabled = true;
  deny.disabled = true;
  hintEl.textContent = approved ? 'Allowed.' : 'Denied.';
  chrome.runtime.sendMessage({ type: 'ECHO_APPROVAL_RESPONSE', id, approved }).catch(() => {
    hintEl.textContent = 'Could not reach ECHO. Use the side panel to answer.';
  });
}

allow.addEventListener('click', e => answer(true, e));
deny.addEventListener('click', e => answer(false, e));

chrome.runtime.sendMessage({ type: 'ECHO_APPROVAL_DETAILS', id }).then((r: any) => {
  if (!r?.success || !r.approval) {
    detailEl.textContent = 'This request is no longer pending.';
    answered = true;
    deny.disabled = true;
    refresh();
    return;
  }
  detailEl.textContent = `${r.approval.detail} on ${r.approval.site}`;
  loaded = true;
  refresh();
}).catch(() => { detailEl.textContent = 'Could not load this request. Use the side panel.'; });
