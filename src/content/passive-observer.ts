// Tier 2 — passive suggester.
//
// Purely rule-based: it watches dwell time, scroll depth and page shape, then
// offers one relevant action. Nothing is sent anywhere and no model runs until
// the user actually accepts a suggestion.

import { countFillableFields } from './form-filler';

export interface Suggestion { text: string; action: string }

const DWELL_MS = 150_000;      // ~2.5 min on one page

let started = false;
let arrivedAt = 0;
let maxScrollPct = 0;
let firedThisPage = false;
let timers: number[] = [];

function pageKey(): string {
  try { const u = new URL(location.href); return u.origin + u.pathname; } catch { return location.href; }
}

function textLength(): number {
  return (document.body?.innerText || '').length;
}

async function recentlySuggested(): Promise<boolean> {
  const r: any = await chrome.runtime.sendMessage({ type: 'ECHO_SUGGESTION_COOLDOWN' }).catch(() => null);
  return r?.recentlyShown !== false;
}

async function markSuggested(): Promise<boolean> {
  const r: any = await chrome.runtime.sendMessage({ type: 'ECHO_SUGGESTION_COOLDOWN', mark: true }).catch(() => null);
  return r?.recentlyShown === false;
}

async function offer(s: Suggestion) {
  if (firedThisPage) return;
  if (await recentlySuggested()) return;
  // Never interrupt while the user is typing.
  const ae = document.activeElement as HTMLElement | null;
  if (ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName)) return;

  if (!await markSuggested()) return;
  firedThisPage = true;
  window.postMessage({ source: 'echo-observer', type: 'ECHO_LOCAL_SUGGEST', ...s }, '*');
}

function checkForm() {
  if (firedThisPage) return;
  const n = countFillableFields();
  if (n >= 3) {
    offer({ text: `This page has ${n} empty fields — want me to fill them from your saved info?`, action: 'fill form' });
  }
}

function checkDwell() {
  if (firedThisPage) return;
  if (textLength() < 2500) return;      // not an article
  if (Date.now() - arrivedAt < DWELL_MS) return;
  offer({ text: "You've been reading a while — want a summary of this page?", action: 'summarize this page' });
}

function checkScrollDepth() {
  if (firedThisPage) return;
  if (maxScrollPct < 88) return;
  if (textLength() < 3000) return;
  offer({ text: 'Reached the end — want me to save the key points?', action: 'summarize this page' });
}

function onScroll() {
  const h = document.documentElement;
  const total = h.scrollHeight - h.clientHeight;
  if (total <= 0) return;
  const pct = (h.scrollTop / total) * 100;
  if (pct > maxScrollPct) maxScrollPct = pct;
  if (maxScrollPct >= 88) checkScrollDepth();
}

function reset() {
  arrivedAt = Date.now();
  maxScrollPct = 0;
  firedThisPage = false;
  timers.forEach(t => window.clearTimeout(t));
  timers = [];
  // Give SPAs time to render before judging the page.
  timers.push(window.setTimeout(checkForm, 4000));
  timers.push(window.setTimeout(checkDwell, DWELL_MS + 1000));
}

export function initPassiveObserver(): void {
  if (started) return;
  started = true;
  reset();
  window.addEventListener('scroll', onScroll, { passive: true });

  // SPA route changes don't reload the page — re-arm on URL change.
  let lastKey = pageKey();
  window.setInterval(() => {
    const k = pageKey();
    if (k !== lastKey) { lastKey = k; reset(); }
  }, 3000);
}

export function stopPassiveObserver(): void {
  started = false;
  window.removeEventListener('scroll', onScroll);
  timers.forEach(t => window.clearTimeout(t));
  timers = [];
}
