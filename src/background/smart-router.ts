// The router. Every user request enters here and leaves at the cheapest tier
// that can genuinely answer it.
//
//   Tier 0  local-brain     storage / DOM / site knowledge   free, instant
//   Tier 1  response-cache  a previous answer, still valid   free, instant
//   Tier 2  local-llm       on-device summarise / ask        free, ~0.5 s
//   Tier 3  brain.ts        the cloud model                  costs quota
//
// Each tier may decline (return null) and the request falls through. Page
// summaries and multi-tab research walk the same ladder in order of quality:
// Chrome's on-device model when it is ready, else one direct cloud call, else
// the offline extractive reader — so they are fast and never stall.

import { say, setState, echoUser, resolveActiveTab } from './bus';
import { handleLocally, bumpTier, needsCloud, routerStats } from './local-brain';
import { cacheLookup, cacheStore } from './response-cache';
import { localAsk, localSynthesize, activeEngine, chromeAiAvailable, chromeAiSummarize, extractiveSummary, withTimeout } from './local-llm';
import { indexPage } from './knowledge-base';
import { processUserInput as cloudBrain, lastCloudReply, completeText } from './brain';
import { getAuthConfig } from './auth';
import { executeTool } from './tools';
import { isTemporaryChat } from './chats';
import { looksLikeSearch, searchAvailable } from './web-search';
import { isVideoUrl } from './video';
import { scopeForTab, tabAccessible } from './agents/leases';

export interface RouterSettings {
  localFirst: boolean;      // use tiers 0-2 at all
  useCache: boolean;
  useLocalLlm: boolean;
  autoIndex: boolean;       // build the knowledge base while browsing
  passiveSuggest: boolean;
  allowedDomains: string[];
  webSearch: 'auto' | 'off';
}

const DEFAULTS: RouterSettings = {
  localFirst: true,
  useCache: true,
  useLocalLlm: true,
  autoIndex: false,
  passiveSuggest: true,
  allowedDomains: [],
  webSearch: 'auto',
};

export async function getSettings(): Promise<RouterSettings> {
  const r = await chrome.storage.local.get(['echo_local_settings']);
  const saved = (r.echo_local_settings || {}) as Partial<RouterSettings>;
  return { ...DEFAULTS, ...saved, allowedDomains: Array.isArray(saved.allowedDomains) ? saved.allowedDomains : [],
    webSearch: saved.webSearch === 'off' ? 'off' : 'auto' };
}

/** Two hostnames name the same site, ignoring a leading "www.". */
export function sameSite(a: string, b: string): boolean {
  const norm = (h: string) => h.trim().toLowerCase().replace(/^www\./, '');
  return !!a && norm(a) === norm(b);
}

export function domainAllowed(host: string, allowed: string[]): boolean {
  return allowed.some(d => sameSite(d, host));
}

export async function setSettings(patch: Partial<RouterSettings>): Promise<RouterSettings> {
  const next = { ...(await getSettings()), ...patch };
  next.allowedDomains = [...new Set(next.allowedDomains
    .map(d => String(d).trim().toLowerCase())
    .filter(d => /^[a-z0-9.-]+$/.test(d)))];
  await chrome.storage.local.set({ echo_local_settings: next });
  return next;
}

// --- request shape detection ----------------------------------------------

const SUMMARIZE_RE = /\b(summar(y|ise|ize)|tldr|tl;dr|key points?|main points?|gist|what.{0,15}(this page|this article|this video|it).{0,10}about|brief me)\b/i;
const PAGE_QA_RE = /\b(this page|this article|this site|this video|the video|in the video|on this page|here|the page|above|below)\b/i;
const RESEARCH_RE = /\b(research|compare|all (my |these )?tabs|across (my )?tabs|every tab|these pages)\b/i;

function isSummarize(q: string): boolean { return SUMMARIZE_RE.test(q); }
function isPageQuestion(q: string): boolean {
  return PAGE_QA_RE.test(q) && /\?|\b(what|who|when|where|why|how|does|is|are|can|which)\b/i.test(q);
}
function isResearch(q: string): boolean { return RESEARCH_RE.test(q); }

/** Pull readable text out of a tab, preferring the live DOM. Video pages give their transcript. */
async function pageText(tabId?: number): Promise<{ text: string; title: string; url: string } | null> {
  if (tabId == null) return null;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.url && isVideoUrl(tab.url)) {
    try {
      const raw = String(await executeTool('get_video_transcript', { limit: 12000 }, tabId) || '');
      const title = (raw.match(/^VIDEO:\s*(.+)$/m)?.[1] || tab.title || '').trim();
      const text = raw.replace(/^(VIDEO|TRANSCRIPT|NEXT_OFFSET):.*$/gm, '').trim();
      if (text.length >= 150) return { text, title, url: tab.url };
    } catch { /* no captions: fall back to the page text */ }
  }
  try {
    const res: any = await executeTool('get_page_text', {}, tabId);
    const raw = typeof res === 'string' ? res : (res?.result || res?.text || '');
    if (!raw || raw.length < 150) return null;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const title = (raw.match(/^TITLE:\s*(.+)$/m)?.[1] || tab?.title || '').trim();
    // The reader's header lines (TITLE, TEXT range, NEXT_OFFSET) are not page text.
    return { text: raw.replace(/^(TITLE|TEXT|NEXT_OFFSET):.*$/gm, '').trim(), title, url: tab?.url || '' };
  } catch {
    return null;
  }
}

// --- the router ------------------------------------------------------------

export interface RouteOptions {
  /** What to show in the chat for this request (e.g. "/summarize" rather than the expanded skill). */
  display?: string;
  /** The user explicitly asked for a web search. */
  webSearch?: boolean;
}

export async function routeUserInput(rawInput: string, senderTabId?: number, opts: RouteOptions = {}): Promise<void> {
  const input = (rawInput || '').trim();
  if (!input) return;

  const tabId = await resolveActiveTab(senderTabId);
  echoUser(opts.display || input, tabId);

  const settings = await getSettings();
  const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const url = tab?.url || '';
  // Temporary chats leave nothing behind, including cached answers.
  const cacheWrites = settings.useCache && !(await isTemporaryChat());

  // If the user disabled the local stack, or asked for a web search, go
  // straight to the cloud.
  if (!settings.localFirst || opts.webSearch) {
    await runCloud(input, tabId, url, cacheWrites, !!opts.webSearch);
    return;
  }

  try {
    // ---- Tier 0: instant local ------------------------------------------
    const local = await handleLocally(input, tabId);
    if (local) return;

    // Requests that plainly need real generation (or live web results) skip
    // the cheap tiers.
    const forceCloud = needsCloud(input) || (looksLikeSearch(input) && await searchAvailable());

    // ---- Tier 1: response cache -----------------------------------------
    if (settings.useCache && !forceCloud) {
      const hit = await cacheLookup(input, url);
      if (hit) {
        const age = Math.round(hit.ageMs / 60000);
        const note = hit.exact ? '' : ' (from a very similar earlier question)';
        say(tabId, hit.answer + `\n\n_Answered from memory${note}${age > 0 ? `, saved ${age} min ago` : ''}._`, 1);
        setState(tabId, 'Idle');
        await bumpTier(1);
        return;
      }
    }

    // ---- Page summary: best brain available, never stalls ---------------
    if (!forceCloud && tabId != null && isSummarize(input) && !isResearch(input)) {
      const handled = await summarizePage(input, tabId, url, cacheWrites, settings.useLocalLlm);
      if (handled) return;
    }

    // ---- Tier 2: on-device model ----------------------------------------
    if (settings.useLocalLlm && !forceCloud && tabId != null) {
      const handled = await tryLocalLlm(input, tabId, url, cacheWrites);
      if (handled) return;
    }

    // ---- Tier 3: cloud --------------------------------------------------
    await runCloud(input, tabId, url, cacheWrites, false);
  } catch (e: any) {
    // The router itself must never be the thing that breaks a request.
    console.error('[ECHO] router error:', e);
    await runCloud(input, tabId, url, cacheWrites, false);
  }
}

async function tryLocalLlm(input: string, tabId: number, url: string, cacheEnabled: boolean): Promise<boolean> {
  // Research across tabs — many pages, one (or zero) model calls.
  if (isResearch(input)) {
    // Only the tabs this scope may use: an avatar reads its own, ECHO reads the rest.
    const scope = scopeForTab(tabId);
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const targets = tabs.filter(t => t.id != null && /^https?:/.test(t.url || '') && tabAccessible(scope, t.id)).slice(0, 8);
    if (targets.length >= 2) {
      setState(tabId, `Reading ${targets.length} tabs on-device…`);
      const docs: { title: string; url: string; text: string }[] = [];
      for (const t of targets) {
        const p = await pageText(t.id!);
        if (p) docs.push({ title: p.title || t.title || '', url: t.url || '', text: p.text });
      }
      if (docs.length >= 2) {
        let text = '';
        let tier: 2 | 3 = 2;
        if (!await chromeAiAvailable() && await cloudReady()) {
          setState(tabId, `Comparing ${docs.length} tabs…`);
          const pages = docs.map((d, i) => `[${i + 1}] ${d.title}\n${d.url}\n${d.text.replace(/\s+/g, ' ').slice(0, Math.floor(12000 / docs.length))}`).join('\n\n');
          text = await cloudOneShot(RESEARCH_SYSTEM, `The user asked: ${input}\n\nOpen tabs:\n\n${pages}`) || '';
          if (text) tier = 3;
        }
        if (!text) text = (await localSynthesize(docs)).text;
        say(tabId, `Here's what's across your ${docs.length} tabs:\n\n${text}`, tier);
        setState(tabId, 'Idle');
        await bumpTier(tier);
        if (cacheEnabled) await cacheStore(input, url, text);
        return true;
      }
    }
    return false;
  }

  // Answer a question about the current page.
  if (isPageQuestion(input)) {
    setState(tabId, 'Checking the page on-device…');
    const p = await pageText(tabId);
    if (!p) return false;
    const out = await localAsk(input, p.text, p.title);
    // Only accept a confident local answer; otherwise let the cloud try. The
    // extractive matcher just quotes sentences, so when a cloud model is set
    // up it answers instead — accuracy first.
    if (!out || out.text.length < 40 || /don'?t (know|contain)|not (in|contain|mention)/i.test(out.text)) {
      return false;
    }
    if (out.engine === 'extractive' && await cloudReady()) return false;
    const badge = out.engine === 'chrome-ai' ? 'on-device AI' : 'the page text';
    say(tabId, `${out.text}\n\n_Answered from ${badge} — no API used._`, 2);
    setState(tabId, 'Idle');
    await bumpTier(2);
    if (cacheEnabled) await cacheStore(input, url, out.text);
    return true;
  }

  return false;
}

// --- page summaries --------------------------------------------------------

const CLOUD_ONE_SHOT_MS = 30_000;

const SUMMARY_SYSTEM = [
  'You are ECHO, a browser assistant. Summarize the web page (or video transcript) the user is looking at,',
  'accurately and only from the text provided.',
  'Start with one sentence on what it is about, then 3 to 6 short bullet points starting with "• " giving the key facts.',
  'Keep names, numbers and dates exactly as written. No preamble and no closing remarks.',
].join(' ');

const RESEARCH_SYSTEM = [
  'You are ECHO, a browser assistant. Answer the user\'s request using only the open tabs provided.',
  'Be accurate and concise: a short overview, then bullet points starting with "• ", citing tabs as [1], [2]….',
  'Keep names, numbers and dates exactly as written. No preamble.',
].join(' ');

/** Is a cloud provider set up (key, and model where one is required)? */
export async function cloudReady(): Promise<boolean> {
  try { await getAuthConfig(); return true; } catch { return false; }
}

/** One direct cloud call — no tools, no history — within a time limit. Null on failure. */
async function cloudOneShot(system: string, prompt: string): Promise<string | null> {
  try {
    const out = (await withTimeout(completeText(system, prompt, 800), CLOUD_ONE_SHOT_MS, 'The cloud model')).trim();
    return out.length > 40 ? out : null;
  } catch (e) {
    console.warn('[ECHO] cloud summary failed:', e);
    return null;
  }
}

/**
 * Summarise the current page with the best brain available: Chrome's
 * on-device model when it is ready, else the cloud in a single call, else the
 * offline extractive reader. Each step has a time limit, so a summary always
 * arrives.
 */
async function summarizePage(input: string, tabId: number, url: string, cacheEnabled: boolean, useLocalLlm: boolean): Promise<boolean> {
  setState(tabId, 'Reading the page…');
  const p = await pageText(tabId);
  if (!p) return false;   // nothing readable here; the full cloud brain can try its tools

  let text: string | null = null;
  let tier: 2 | 3 = 2;
  let note = '';
  if (useLocalLlm && await chromeAiAvailable()) {
    setState(tabId, 'Summarizing on-device…');
    text = await chromeAiSummarize(p.text, p.title);
    note = 'Summarised by on-device AI — no API used.';
  }
  if (!text && await cloudReady()) {
    setState(tabId, 'Summarizing…');
    const body = p.text.replace(/\s+/g, ' ').slice(0, 12_000);
    text = await cloudOneShot(SUMMARY_SYSTEM, `Title: ${p.title}\nURL: ${p.url}\n\nText:\n"""\n${body}\n"""`);
    tier = 3;
    note = '';
  }
  if (!text) {
    text = extractiveSummary(p.text.replace(/\s+/g, ' ').slice(0, 12_000), p.title);
    tier = 2;
    note = 'Quick summary by the offline reader. Add an API key in Settings for fuller, more accurate summaries.';
    if (text.length < 60) text = 'There is not enough readable text on this page to summarise.';
  }

  say(tabId, note ? `${text}\n\n_${note}_` : text, tier);
  setState(tabId, 'Idle');
  await bumpTier(tier);
  if (cacheEnabled) await cacheStore(input, url, text);
  if (p.url) ingestPage(p.url, p.title, p.text).catch(() => {});
  return true;
}

/**
 * Tabs attached with @ normally go to the cloud model. With no cloud provider
 * set up, answer from them on-device instead of failing.
 */
export async function answerFromTabsOnDevice(request: string, tabs: { title: string; url: string; text: string }[], tabId?: number): Promise<void> {
  setState(tabId, `Reading ${tabs.length === 1 ? 'the attached tab' : `${tabs.length} attached tabs`} on-device…`);
  let text = '';
  if (tabs.length === 1 && !isSummarize(request)) text = (await localAsk(request, tabs[0].text, tabs[0].title))?.text || '';
  if (!text) text = (await localSynthesize(tabs)).text;
  say(tabId, `${text}\n\n_Answered on-device from the attached tab${tabs.length === 1 ? '' : 's'}. Add an API key in Settings for fuller answers._`, 2);
  setState(tabId, 'Idle');
  await bumpTier(2);
}

async function runCloud(input: string, tabId: number | undefined, url: string, cacheEnabled: boolean, webSearch: boolean): Promise<void> {
  await bumpTier(3);
  const scope = scopeForTab(tabId);
  await cloudBrain(input, tabId, { skipEcho: true, webSearch, scope });
  // Store the cloud's reply so an identical question is free next time.
  const reply = lastCloudReply(scope);
  if (reply && cacheEnabled) await cacheStore(input, url, reply);
}

// --- knowledge-base ingestion ---------------------------------------------

/** Called when a content script reports the page it just rendered. */
export async function ingestPage(url: string, title: string, text: string): Promise<void> {
  const s = await getSettings();
  if (!s.autoIndex) return;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return; }
  if (!domainAllowed(host, s.allowedDomains)) return;
  await indexPage(url, title, text);
}

export async function routerReport(): Promise<string> {
  const s = await routerStats();
  const engine = await activeEngine();
  const total = s.t0 + s.t1 + s.t2 + s.t3;
  if (!total) return 'No requests handled yet.';
  const local = s.t0 + s.t1 + s.t2;
  return [
    `${total} requests · ${Math.round((local / total) * 100)}% handled locally`,
    `instant ${s.t0} · cached ${s.t1} · on-device ${s.t2} · cloud ${s.t3}`,
    `on-device engine: ${engine === 'chrome-ai' ? "Chrome built-in AI" : 'extractive reader'}`,
  ].join('\n');
}
