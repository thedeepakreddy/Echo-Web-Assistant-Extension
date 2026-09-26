// Tier 0 — the local brain.
//
// Runs before any network call. If a request can be satisfied from storage,
// the DOM, or a known site's structure, it is answered here for free. Anything
// it can't confidently handle returns null and falls through to the next tier.

import { say, setState } from './bus';
import { executeTool } from './tools';
import { matchSite, siteSearchUrl, siteActionSelectors, SITE_PROFILES } from './site-knowledge';
import {
  startRecording, stopRecording, cancelRecording, isRecording,
  listWorkflows, deleteWorkflow, playWorkflow, findWorkflowKey, previewWorkflow, isSafeWorkflowUrl,
} from './workflow-engine';
import {
  createWatcher, listWatchers, deleteWatcher, clearWatchers, describeWatcher, WatchCondition,
} from './page-watcher';
import { searchKB, recentPages, pagesToday, kbSize } from './knowledge-base';
import { allHighlights, highlightsForUrl, exportHighlightsMarkdown, searchHighlights } from './highlights';
import { cacheStats, cacheClear } from './response-cache';
import { abortCurrentWork, forgetCloudConversationAfterReply } from './brain';
import { cancelTask } from './safety';
import { scopeForTab } from './agents/leases';
import { searchAvailable } from './web-search';

export interface LocalResult {
  handled: true;
  /** Text spoken to the user (already sent — this is for the router's log). */
  reply: string;
  /** Set when the local brain wants the cloud tier to take over instead. */
  escalate?: string;
}

type Handler = (m: RegExpMatchArray, ctx: Ctx) => Promise<string | null>;
interface Ctx { input: string; tabId?: number; url: string; title: string }

// --- small helpers ---------------------------------------------------------

const store = {
  get: (keys: string[]) => chrome.storage.local.get(keys),
  set: (obj: any) => chrome.storage.local.set(obj),
};

async function memory(): Promise<Record<string, string>> {
  const r = await store.get(['echo_memory']);
  return (r.echo_memory || {}) as Record<string, string>;
}

async function tabInfo(tabId?: number): Promise<{ url: string; title: string }> {
  if (tabId == null) return { url: '', title: '' };
  try {
    const t = await chrome.tabs.get(tabId);
    return { url: t.url || '', title: t.title || '' };
  } catch {
    return { url: '', title: '' };
  }
}

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

/** Normalise a URL fragment the user spoke ("youtube" -> https://youtube.com). */
function toUrl(raw: string): string | null {
  let s = raw.trim().replace(/[.,!?;]+$/, '').replace(/^["']|["']$/g, '');
  if (!s) return null;
  s = s.replace(/\s+dot\s+/gi, '.').replace(/\s+/g, '');
  if (/^https?:\/\//i.test(s)) return s;
  const site = matchSite(s);
  if (site && !s.includes('.')) return site.home;
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(s)) return 'https://' + s;
  return null;
}

// ---------------------------------------------------------------------------
// Handlers. Each returns the reply text, or null to decline (fall through).
// Order matters: the first matching rule wins.
// ---------------------------------------------------------------------------

const RULES: { re: RegExp; fn: Handler }[] = [];
const rule = (re: RegExp, fn: Handler) => RULES.push({ re, fn });

// --- conversation ---
rule(/^(hi|hey|hello|yo|sup|howdy|hiya|good (morning|afternoon|evening))\b[\s!.]*$/i,
  async () => pick([
    "Hey! What can I do for you?",
    "Hi there — ready when you are.",
    "Hello! Point me at something.",
  ]));

rule(/^(thanks|thank you|thx|ty|cheers|nice|great|perfect|awesome|cool)\b[\s!.]*$/i,
  async () => pick(["Anytime.", "Happy to help.", "You got it."]));

rule(/^(bye|goodbye|see ya|later|good night)\b[\s!.]*$/i,
  async () => pick(["See you.", "Catch you later.", "Goodnight!"]));

rule(/\b(who (made|created|built|designed) you|who('?s| is) your (creator|maker|developer)|who are you)\b/i,
  async () => "I'm ECHO — built by Deepak, my brilliant creator. I run your browser for you: reading pages, clicking, typing, remembering things, and automating whatever you repeat.");

// Anchored: "help me fill this form" is a real task, not a request for the
// capability list, so only a bare help request matches here.
rule(/^(?:help|what can you do|what do you do|show me (?:your )?(?:features|capabilities|commands)|how do you work)\s*\??$/i,
  async () => [
    "Here's what I can do — most of it without touching the internet:",
    "• Read, summarise and answer questions about any page",
    "• Click, type, scroll and fill forms for you",
    "• Record a workflow once, then replay it forever ('record a workflow')",
    "• Watch a page and alert you when it changes ('watch this page')",
    "• Extract emails, phones, prices, links ('extract emails')",
    "• Remember facts ('remember my email is…') and recall pages you've read",
    "• Save highlights and give them back when you revisit",
    "Ask me anything, or just tell me what to do.",
  ].join('\n'));

// --- abort ---
// Stops only the work of whoever owns this tab: that avatar, or the classic ECHO.
rule(/^(stop|cancel|abort|nevermind|never mind|quit|halt)\b[\s!.]*$/i,
  async (_m, ctx) => { const scope = scopeForTab(ctx.tabId); abortCurrentWork(scope); cancelTask(scope); return "Stopped."; });

// --- memory ---
rule(/\b(remember|note|save|store)\b.{0,20}?\b(that\s+)?my\s+([\w\s]{2,30}?)\s+(?:is|are|=)\s+(.+)$/i,
  async (m) => {
    const key = m[3].trim().toLowerCase().replace(/\s+/g, '_');
    const value = m[4].trim().replace(/[.!]$/, '');
    const mem = await memory();
    mem[key] = value;
    await store.set({ echo_memory: mem });
    return `Got it — your ${m[3].trim()} is ${value}. I'll remember that.`;
  });

rule(/^(?:what(?:'s| is)|tell me)\s+my\s+([\w\s]{2,30}?)\s*\??$/i,
  async (m) => {
    const want = m[1].trim().toLowerCase().replace(/\s+/g, '_');
    const mem = await memory();
    const hit = mem[want]
      ?? mem[Object.keys(mem).find(k => k.includes(want) || want.includes(k)) || ''];
    if (hit) return `Your ${m[1].trim()} is ${hit}.`;
    const keys = Object.keys(mem);
    return keys.length
      ? `I don't have your ${m[1].trim()} saved. I do know: ${keys.join(', ')}.`
      : `I haven't saved anything about you yet. Try "remember my email is you@example.com".`;
  });

rule(/\b(what do you (remember|know) about me|list (your )?memor(y|ies)|show (my )?memor(y|ies)|everything you remember)\b/i,
  async () => {
    const mem = await memory();
    const entries = Object.entries(mem);
    if (!entries.length) return "I haven't saved anything about you yet.";
    return `Here's what I remember:\n${entries.map(([k, v]) => `• ${k.replace(/_/g, ' ')}: ${v}`).join('\n')}`;
  });

rule(/\b(forget|delete|remove)\b.{0,15}\bmy\s+([\w\s]{2,30}?)\s*$/i,
  async (m) => {
    const want = m[2].trim().toLowerCase().replace(/\s+/g, '_');
    const mem = await memory();
    const key = mem[want] ? want : Object.keys(mem).find(k => k.includes(want));
    if (!key) return `I don't have your ${m[2].trim()} saved.`;
    delete mem[key];
    await store.set({ echo_memory: mem });
    await cacheClear();
    // Memories are shared by every avatar, so every conversation forgets.
    forgetCloudConversationAfterReply();
    return `Forgotten — I no longer have your ${m[2].trim()}.`;
  });

// --- saved tasks ---
rule(/\b(list|show|what)\b.{0,12}\b(my )?(saved )?tasks?\b/i,
  async () => {
    const r = await store.get(['echo_tasks']);
    const tasks = (r.echo_tasks || {}) as Record<string, string>;
    const names = Object.keys(tasks);
    return names.length
      ? `Saved tasks:\n${names.map(n => `• ${n}`).join('\n')}\nSay "run <name>" to use one.`
      : `No saved tasks yet. Say "save a task called X that does Y".`;
  });

// --- workflows ---
rule(/\b(record|capture|watch me|learn)\b.{0,20}\b(a )?(workflow|macro|steps|what i do|sequence)\b/i,
  async (_m, ctx) => {
    if (ctx.tabId == null) return "I need an active tab to record on.";
    if (await isRecording()) return "I'm already recording. Say \"stop recording and call it <name>\" when you're done.";
    if (!isSafeWorkflowUrl(ctx.url)) return "I can't record a workflow on a sign-in or token-bearing URL.";
    await startRecording(ctx.tabId, ctx.url);
    return "Recording. Do your steps normally — I'm watching clicks and typing (never passwords). Say \"stop recording and call it <name>\" when you're finished.";
  });

rule(/\b(stop|finish|end|done)\b.{0,25}\brecording\b(?:.{0,25}?\b(?:call(?:ed)? it|name it|as)\s+["']?([\w\s-]{1,40}?)["']?)?\s*$/i,
  async (m) => {
    if (!await isRecording()) return "I'm not recording right now.";
    const name = (m[2] || `workflow ${Object.keys(await listWorkflows()).length + 1}`).trim();
    const res = await stopRecording(name);
    return res.message;
  });

rule(/\b(cancel|discard|throw away)\b.{0,15}\brecording\b/i,
  async () => {
    if (!await isRecording()) return "I'm not recording right now.";
    await cancelRecording();
    return "Recording cancelled — nothing saved.";
  });

rule(/\b(list|show|what)\b.{0,15}\b(my )?(workflows?|macros?)\b/i,
  async () => {
    const all = await listWorkflows();
    const list = Object.values(all);
    return list.length
      ? `Saved workflows:\n${list.map(w => `• ${w.name} — ${w.steps.length} steps${w.runs ? `, run ${w.runs}×` : ''}`).join('\n')}`
      : `No workflows yet. Say "record a workflow" and I'll learn one by watching you.`;
  });

rule(/^preview\s+(?:my\s+|the\s+)?(?:workflow\s+)?["']?([\w\s-]{2,40}?)["']?\s*$/i,
  async (m) => previewWorkflow(m[1].trim()));

rule(/\b(run|play|replay|execute|do)\b\s+(?:my\s+|the\s+)?(?:workflow\s+)?["']?([\w\s-]{2,40}?)["']?\s*(?:workflow)?\s*$/i,
  async (m, ctx) => {
    const name = m[2].trim();
    const all = await listWorkflows();
    if (!Object.keys(all).length) return null; // no workflows — let a real tier handle it
    // Only claim this if the name actually resolves to something we have.
    if (!findWorkflowKey(all, name)) return null;
    if (ctx.tabId == null) return "I need an active tab to run a workflow.";
    setState(ctx.tabId, `Running workflow "${name}"…`);
    const res = await playWorkflow(name, ctx.tabId);
    return res.message;
  });

rule(/\b(delete|remove|forget)\b.{0,15}\b(workflow|macro)\b\s*["']?([\w\s-]{2,40}?)["']?\s*$/i,
  async (m) => (await deleteWorkflow(m[3].trim()))
    ? `Deleted workflow "${m[3].trim()}".`
    : `I don't have a workflow called "${m[3].trim()}".`);

// --- page watchers ---
// Deliberately narrow: it must name the page/price/stock being watched, so
// "watch this YouTube video" is not mistaken for "monitor this page".
rule(/\b(?:(?:watch|monitor|track)\s+(?:this|the)\s+(?:page|site|price|product|listing|url)|(?:alert|notify|tell|ping)\s+me\s+(?:when|if))\b/i,
  async (_m, ctx) => {
    if (!ctx.url || !/^https?:/.test(ctx.url)) return null;
    const q = ctx.input.toLowerCase();

    let condition: WatchCondition = 'changed';
    let target: string | undefined;

    const below = q.match(/\b(?:below|under|less than|drops? (?:to|below)|cheaper than)\s*([$£€¥₹]?\s?[\d,.]+)/);
    const above = q.match(/\b(?:above|over|more than|exceeds?|goes? (?:to|above))\s*([$£€¥₹]?\s?[\d,.]+)/);
    const says = q.match(/\b(?:says?|contains?|shows?|mentions?)\s+["']?([\w\s]{2,40}?)["']?\s*$/);
    const gone = q.match(/\b(?:no longer|stops? (?:saying|showing)|disappears?|removes?)\s+["']?([\w\s]{2,40}?)["']?\s*$/);

    if (below) { condition = 'below'; target = below[1].replace(/[^\d.]/g, ''); }
    else if (above) { condition = 'above'; target = above[1].replace(/[^\d.]/g, ''); }
    else if (gone) { condition = 'missing'; target = gone[1].trim(); }
    else if (says) { condition = 'contains'; target = says[1].trim(); }

    // "check every N minutes/hours"
    let intervalMin = 60;
    const every = q.match(/\bevery\s+(\d+)\s*(min|minute|hour|hr|day)/);
    if (every) {
      const n = parseInt(every[1], 10);
      intervalMin = /hour|hr/.test(every[2]) ? n * 60 : /day/.test(every[2]) ? n * 1440 : n;
    }

    await createWatcher({
      url: ctx.url,
      label: ctx.title || ctx.url,
      condition,
      target,
      intervalMin,
    });
    const what =
      condition === 'below' ? `it drops below ${target}` :
      condition === 'above' ? `it goes above ${target}` :
      condition === 'contains' ? `it mentions "${target}"` :
      condition === 'missing' ? `"${target}" disappears` :
      'it changes';
    return `Watching this page — I'll send a desktop notification when ${what}. Checking every ${intervalMin} minutes.`;
  });

rule(/\b(list|show|what)\b.{0,15}\b(my )?(watchers?|watches|monitors?)\b/i,
  async () => {
    const all = Object.values(await listWatchers());
    return all.length
      ? `Active watchers:\n${all.map(w => `• ${describeWatcher(w)}`).join('\n')}`
      : `No page watchers running. Open a page and say "watch this page and tell me when it changes".`;
  });

rule(/\b(stop|delete|remove|cancel)\b.{0,15}\b(watch(er|ing)?|monitor)\b\s*["']?([\w\s-]{0,40}?)["']?\s*$/i,
  async (m) => {
    const which = (m[3] || '').trim();
    const all = await listWatchers();
    const list = Object.values(all);
    if (!list.length) return "There are no watchers running.";
    if (!which) {
      await clearWatchers();
      return `Stopped all ${list.length} watcher${list.length === 1 ? '' : 's'}.`;
    }
    return (await deleteWatcher(which)) ? `Stopped watching "${which}".` : `No watcher matching "${which}".`;
  });

// --- extraction ---
rule(/\b(extract|find|get|grab|list|show|collect)\b.{0,20}\b(all\s+)?(emails?|e-mails?|phones?|phone numbers?|prices?|links?|urls?|dates?|handles?|images?|headings?)\b/i,
  async (m, ctx) => {
    if (ctx.tabId == null) return null;
    const word = m[3].toLowerCase();
    const kind =
      /mail/.test(word) ? 'emails' :
      /phone/.test(word) ? 'phones' :
      /price/.test(word) ? 'prices' :
      /link|url/.test(word) ? 'links' :
      /date/.test(word) ? 'dates' :
      /handle/.test(word) ? 'handles' :
      /image/.test(word) ? 'images' : 'headings';

    const res: any = await executeTool('extract_pattern', { kind }, ctx.tabId).catch(() => null);
    if (!res || !res.items) return null;
    if (!res.items.length) return `I didn't find any ${kind} on this page.`;
    const shown = res.items.slice(0, 25);
    const more = res.count > shown.length ? `\n…and ${res.count - shown.length} more.` : '';
    return `Found ${res.count} ${kind}:\n${shown.map((i: string) => `• ${i}`).join('\n')}${more}`;
  });

// --- form filling ---
rule(/\b(fill|complete|autofill|auto-fill)\b.{0,20}\b(this |the )?(form|fields?|it)\b/i,
  async (_m, ctx) => {
    if (ctx.tabId == null) return null;
    const mem = await memory();
    if (!Object.keys(mem).length) {
      return "I don't have any saved details to fill with. Tell me things like \"remember my email is you@example.com\" first.";
    }
    const res: any = await executeTool('fill_form', { memory: mem }, ctx.tabId).catch(() => null);
    if (!res) return null;
    if (!res.filled?.length) {
      return `I couldn't match any fields on this page to what I know about you (I have: ${Object.keys(mem).join(', ')}).`;
    }
    const names = res.filled.map((f: any) => f.key.replace(/_/g, ' ')).join(', ');
    const skipped = res.skipped?.length ? ` I left ${res.skipped.length} sensitive field(s) alone.` : '';
    return `Filled ${res.filled.length} field${res.filled.length === 1 ? '' : 's'}: ${names}.${skipped} Check it before submitting — I won't submit for you.`;
  });

// --- highlights ---
rule(/\b(show|list|my|all)\b.{0,15}\bhighlights?\b/i,
  async (_m, ctx) => {
    const onPage = ctx.url ? await highlightsForUrl(ctx.url) : [];
    if (onPage.length) {
      return `${onPage.length} highlight${onPage.length === 1 ? '' : 's'} on this page:\n${onPage.map(h => `• ${h.text.slice(0, 120)}`).join('\n')}`;
    }
    const all = await allHighlights(20);
    return all.length
      ? `Your latest highlights:\n${all.slice(0, 8).map(h => `• ${h.text.slice(0, 100)} — ${h.title.slice(0, 40)}`).join('\n')}`
      : `No highlights yet. Select any text on a page and click the ECHO chip that appears.`;
  });

rule(/\b(export|download)\b.{0,15}\bhighlights?\b/i,
  async (_m, ctx) => {
    const md = await exportHighlightsMarkdown();
    await executeTool('download_data', { filename: 'echo-highlights.md', content: md }, ctx.tabId).catch(() => null);
    return "Exported your highlights as echo-highlights.md.";
  });

rule(/\b(search|find)\b.{0,20}\b(in )?(my )?highlights?\b\s*(?:for\s+)?["']?([\w\s]{2,40})["']?/i,
  async (m) => {
    const hits = await searchHighlights(m[4].trim());
    return hits.length
      ? `${hits.length} matching highlight${hits.length === 1 ? '' : 's'}:\n${hits.map(h => `• ${h.text.slice(0, 120)} — ${h.title.slice(0, 40)}`).join('\n')}`
      : `Nothing in your highlights matches "${m[4].trim()}".`;
  });

// --- browsing history / knowledge base ---
rule(/\b(what|which)\b.{0,25}\b(did i|have i)\b.{0,15}\b(read|visit|browse|look at|see)\b.{0,15}\b(today)\b/i,
  async () => {
    const pages = await pagesToday();
    if (!pages.length) return "I haven't indexed any pages today yet.";
    return `You've read ${pages.length} page${pages.length === 1 ? '' : 's'} today:\n${pages.slice(0, 12).map(p => `• ${p.title.slice(0, 70)} — ${p.domain}`).join('\n')}`;
  });

rule(/\b(what|which)\b.{0,30}\b(article|page|site|thing)\b.{0,30}\b(about|on|regarding)\s+["']?([\w\s]{3,50}?)["']?\s*\??$/i,
  async (m) => {
    const hits = await searchKB(m[4].trim());
    if (!hits.length) return null; // nothing local — let a paid tier try
    return `From pages you've read:\n${hits.map(h => `• ${h.title.slice(0, 70)}\n  ${h.domain} — ${h.snippet.slice(0, 140)}`).join('\n')}`;
  });

rule(/\b(recent|last|latest)\b.{0,15}\b(pages?|sites?|articles?)\b.{0,15}\b(i )?(read|visited|browsed)?\b/i,
  async () => {
    const pages = await recentPages(10);
    return pages.length
      ? `Recently read:\n${pages.map(p => `• ${p.title.slice(0, 70)} — ${p.domain}`).join('\n')}`
      : "I haven't indexed any pages yet.";
  });

// --- navigation (direct, no model needed) ---
rule(/^(?:open|go to|navigate to|visit|take me to|launch|browse to)\s+(.{2,120}?)\s*$/i,
  async (m, ctx) => {
    const raw = m[1].trim();
    // "open a new tab and search X" is a real task — don't shortcut it.
    if (/\b(and|then|search|find|look up|type|click|buy|order)\b/i.test(raw)) return null;
    const url = toUrl(raw);
    if (!url) return null;
    const res: any = await executeTool('open_url', { url }, ctx.tabId).catch(() => null);
    if (!res) return null;
    const site = matchSite(url);
    return `Opened ${site?.name || url}.`;
  });

// --- site-aware search (zero-token, uses the site's own search URL) ---
rule(/^(?:search|look up|find|google)\s+(?:for\s+)?(.+?)\s+(?:on|in|at)\s+([\w.]{2,30})\s*$/i,
  async (m, ctx) => siteSearch(m[2], m[1], ctx));
rule(/^(?:search|look up|find)\s+([\w.]{2,30})\s+for\s+(.+?)\s*$/i,
  async (m, ctx) => siteSearch(m[1], m[2], ctx));
rule(/^(?:google|search(?: the web)?(?: for)?)\s+(.{2,120}?)\s*$/i,
  async (m, ctx) => {
    // "search the web / online for X" gets a cited answer when Claude or Gemini
    // can search; "google X" still opens Google.
    if (/^search (the web|online)\b/i.test(ctx.input) && await searchAvailable()) return null;
    return siteSearch('google', m[1], ctx);
  });

async function siteSearch(siteName: string, query: string, ctx: Ctx): Promise<string | null> {
  const q = query.trim();
  // "search this page for X" is a find-on-page request, not a web search.
  if (/\b(this|the current|current)\s+(page|article|site|tab|document)\b|\bon this page\b/i.test(q)) return null;
  const site = matchSite(siteName);
  if (!site) return null;
  const url = siteSearchUrl(site, q);
  if (!url) return null;
  const res: any = await executeTool('open_url', { url }, ctx.tabId).catch(() => null);
  if (!res) return null;
  return `Searched ${site.name} for "${q}".`;
}

// --- site-aware button clicks ---
rule(/^(?:click|press|hit|tap)\s+(?:the\s+)?([\w\s]{2,30}?)\s*(?:button)?\s*$/i,
  async (m, ctx) => {
    if (!ctx.url || ctx.tabId == null) return null;
    const site = matchSite(ctx.url);
    if (!site) return null;
    const sels = siteActionSelectors(site, m[1].trim());
    if (!sels) return null;
    const res: any = await executeTool('click_selector', { selectors: sels }, ctx.tabId).catch(() => null);
    if (!res?.clicked) return null;
    return `Clicked ${m[1].trim()} on ${site.name}.`;
  });

// --- tab housekeeping ---
rule(/\b(how many|list|show|what)\b.{0,15}\btabs?\b.{0,15}\b(open|do i have)?\b/i,
  async (_m, ctx) => {
    const res: any = await executeTool('list_tabs', {}, ctx.tabId).catch(() => null);
    if (!res?.tabs) return null;
    const tabs = res.tabs as any[];
    return `You have ${tabs.length} tabs open:\n${tabs.slice(0, 15).map(t => `• ${t.title || t.url}`).join('\n')}`;
  });

// --- diagnostics ---
rule(/\b(cache|usage|stats|how much|savings?|token)\b.{0,25}\b(stats?|status|saved|used|report)\b/i,
  async () => {
    const [c, kb, stats] = await Promise.all([cacheStats(), kbSize(), routerStats()]);
    const total = stats.t0 + stats.t1 + stats.t2 + stats.t3;
    const localPct = total ? Math.round(((stats.t0 + stats.t1 + stats.t2) / total) * 100) : 0;
    return [
      `Handled ${total} request${total === 1 ? '' : 's'} this install:`,
      `• ${stats.t0} instantly (no AI)`,
      `• ${stats.t1} from cache`,
      `• ${stats.t2} by the on-device model`,
      `• ${stats.t3} by the cloud API`,
      `That's ${localPct}% handled without spending quota.`,
      `Cache: ${c.entries} answers stored, ${c.hits} replays. Knowledge base: ${kb} pages.`,
    ].join('\n');
  });

rule(/\b(clear|reset|wipe)\b.{0,15}\bcache\b/i,
  async () => { await cacheClear(); return "Response cache cleared."; });

rule(/\b(what sites?|which sites?)\b.{0,20}\b(do you know|are supported)\b/i,
  async () => `I know the layout of ${SITE_PROFILES.length} sites well enough to act without any AI: ${SITE_PROFILES.map(s => s.name).join(', ')}.`);

// ---------------------------------------------------------------------------
// Router stats — how many requests each tier served.
// ---------------------------------------------------------------------------

export interface RouterStats { t0: number; t1: number; t2: number; t3: number }

export async function routerStats(): Promise<RouterStats> {
  const r = await store.get(['echo_router_stats']);
  return { t0: 0, t1: 0, t2: 0, t3: 0, ...(r.echo_router_stats || {}) } as RouterStats;
}

export async function bumpTier(tier: 0 | 1 | 2 | 3): Promise<void> {
  const s = await routerStats();
  (s as any)[`t${tier}`] = ((s as any)[`t${tier}`] || 0) + 1;
  await store.set({ echo_router_stats: s });
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * Try to answer entirely locally.
 * Returns null when nothing matched — the caller escalates to the next tier.
 */
export async function handleLocally(input: string, tabId?: number): Promise<LocalResult | null> {
  const text = input.trim();
  if (!text) return null;

  const { url, title } = await tabInfo(tabId);
  const ctx: Ctx = { input: text, tabId, url, title };

  for (const { re, fn } of RULES) {
    const m = text.match(re);
    if (!m) continue;
    try {
      const reply = await fn(m, ctx);
      if (reply === null || reply === undefined) continue; // handler declined
      say(tabId, reply, 0);
      setState(tabId, 'Idle');
      await bumpTier(0);
      return { handled: true, reply };
    } catch (e: any) {
      // A broken local handler must never swallow the request — fall through
      // and let a higher tier answer it properly.
      console.warn('[ECHO] local handler failed:', e?.message || e);
      continue;
    }
  }
  return null;
}

/** Does this request obviously need the cloud? Used to skip cheaper tiers. */
export function needsCloud(input: string): boolean {
  return /\b(write|compose|draft|email to|reply to|translate|rewrite|improve|generate|create a|plan|compare|book|order|buy|apply|fill out and submit)\b/i.test(input);
}
