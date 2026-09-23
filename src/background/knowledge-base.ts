// Tier 1 — automatic knowledge base.
//
// As you browse, the content script quietly hands ECHO the readable text of
// each page. Later "what was that article about X?" is answered by a local
// full-text search instead of a web search plus a model call.

import { STORE_KB, idbPut, idbGet, idbGetAll, idbDelete, idbClear, idbTrim, idbCount } from './db';

export interface KBPage {
  url: string;
  domain: string;
  title: string;
  text: string;
  tags: string[];
  ts: number;
  visits: number;
}

const MAX_PAGES = 600;
const MAX_TEXT = 4000;
const MIN_TEXT = 220;      // ignore near-empty pages
const REVISIT_MS = 60_000; // don't rewrite the same page in a tight loop

/** Coarse auto-tags from the URL — enough to filter recall by topic. */
function autoTags(url: string, title: string): string[] {
  const s = (url + ' ' + title).toLowerCase();
  const tags: string[] = [];
  const add = (t: string) => { if (!tags.includes(t)) tags.push(t); };
  if (/github|gitlab|stackoverflow|npm|docs?\.|developer|api|mdn/.test(s)) add('dev');
  if (/news|bbc|cnn|reuters|nytimes|guardian|verge|techcrunch/.test(s)) add('news');
  if (/amazon|ebay|flipkart|shop|store|cart|product|price/.test(s)) add('shopping');
  if (/youtube|netflix|spotify|twitch|vimeo/.test(s)) add('media');
  if (/wikipedia|scholar|arxiv|researchgate|pubmed/.test(s)) add('reference');
  if (/mail|gmail|outlook|inbox/.test(s)) add('mail');
  if (/linkedin|twitter|x\.com|reddit|facebook|instagram/.test(s)) add('social');
  if (/docs\.google|notion|confluence|sheet|slide/.test(s)) add('docs');
  return tags;
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_[ce]id|ref|ref_src|igshid|si)$/i;
const SECRET_PARAM = /^(code|state|access_?token|id_?token|refresh_?token|token|api_?key|key|session|sid|secret|password|signature|sig)$/i;

/**
 * One key per page: tracking parameters and in-page anchors are dropped so the
 * same article is stored once, but meaningful query strings (?id=, ?q=) and
 * hash routes (#/path, #!/path) are kept because they select different content.
 */
function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    u.searchParams.sort();
    const hash = /^#!?\//.test(u.hash) ? u.hash : '';
    return u.origin + u.pathname + u.search + hash;
  } catch { return url; }
}

/** Should this page be remembered at all? */
export function isIndexable(url: string): boolean {
  if (!url) return false;
  if (!/^https?:/i.test(url)) return false;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (/^(mail\.google\.com|docs\.google\.com|drive\.google\.com|(?:[a-z0-9-]+\.)*outlook\.[a-z.]+|(?:[a-z0-9-]+\.)*slack\.com|(?:[a-z0-9-]+\.)*notion\.so)$/.test(host)) return false;
  // Never store anything that looks private or authenticated.
  if (/\b(login|signin|signup|register|password|checkout|payment|billing|account|auth|oauth|token|session|secret|inbox)\b/i.test(url)) return false;
  if (/localhost|127\.0\.0\.1|\.local\b/i.test(url)) return false;
  // OAuth callbacks (?code=&state=), magic links and signed URLs carry secrets.
  try {
    const u = new URL(url);
    if ([...u.searchParams.keys()].some(k => SECRET_PARAM.test(k))) return false;
    if (/[#&](access_?token|id_?token|code|state|token|session)=/i.test(u.hash)) return false;
  } catch { return false; }
  return true;
}

export async function indexPage(url: string, title: string, text: string): Promise<boolean> {
  if (!isIndexable(url)) return false;
  const body = (text || '').replace(/\s+/g, ' ').trim();
  if (body.length < MIN_TEXT) return false;

  const key = cleanUrl(url);
  const existing = await idbGet<KBPage>(STORE_KB, key);
  const now = Date.now();
  if (existing && now - existing.ts < REVISIT_MS) return false;

  const page: KBPage = {
    url: key,
    domain: domainOf(url),
    title: (title || key).substring(0, 200),
    text: body.substring(0, MAX_TEXT),
    tags: autoTags(url, title || ''),
    ts: now,
    visits: (existing?.visits || 0) + 1,
  };
  await idbPut(STORE_KB, page);
  idbTrim(STORE_KB, 'ts', MAX_PAGES);
  return true;
}

export interface KBResult extends KBPage { score: number; snippet: string }

/** Rank pages by term hits in title (weighted), text, domain and freshness. */
export async function searchKB(query: string, limit = 6): Promise<KBResult[]> {
  const terms = query.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
  if (!terms.length) return [];

  const pages = await idbGetAll<KBPage>(STORE_KB, MAX_PAGES);
  const now = Date.now();
  const scored: KBResult[] = [];

  for (const p of pages) {
    const title = p.title.toLowerCase();
    const text = p.text.toLowerCase();
    let score = 0;
    let firstHit = -1;
    for (const t of terms) {
      if (title.includes(t)) score += 6;
      if (p.domain.includes(t)) score += 3;
      if (p.tags.includes(t)) score += 2;
      const idx = text.indexOf(t);
      if (idx !== -1) {
        score += 1;
        // Repeats matter, but with diminishing returns.
        score += Math.min(3, (text.split(t).length - 1) * 0.25);
        if (firstHit === -1) firstHit = idx;
      }
    }
    if (score <= 0) continue;
    // Gentle recency boost: last 24 h ranks above last month.
    const ageDays = (now - p.ts) / 86_400_000;
    score += Math.max(0, 3 - ageDays * 0.35);

    const start = Math.max(0, (firstHit === -1 ? 0 : firstHit) - 90);
    const snippet = p.text.substring(start, start + 240).trim();
    scored.push({ ...p, score, snippet: (start > 0 ? '…' : '') + snippet + '…' });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export async function recentPages(limit = 10): Promise<KBPage[]> {
  const pages = await idbGetAll<KBPage>(STORE_KB, MAX_PAGES);
  pages.sort((a, b) => b.ts - a.ts);
  return pages.slice(0, limit);
}

/** Pages seen since local midnight — powers "what did I read today?". */
export async function pagesToday(): Promise<KBPage[]> {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const pages = await idbGetAll<KBPage>(STORE_KB, MAX_PAGES);
  return pages.filter(p => p.ts >= start.getTime()).sort((a, b) => b.ts - a.ts);
}

export async function getPage(url: string): Promise<KBPage | null> {
  return idbGet<KBPage>(STORE_KB, cleanUrl(url));
}

export async function forgetPage(url: string): Promise<void> {
  await idbDelete(STORE_KB, cleanUrl(url));
}

export async function forgetSite(hostname: string): Promise<number> {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  const pages = await idbGetAll<KBPage>(STORE_KB, MAX_PAGES);
  let removed = 0;
  for (const page of pages) {
    if (page.domain !== host) continue;
    await idbDelete(STORE_KB, page.url);
    removed++;
  }
  return removed;
}

export async function clearKB(): Promise<void> {
  await idbClear(STORE_KB);
}

export async function kbSize(): Promise<number> {
  return idbCount(STORE_KB);
}

const STOPWORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'for', 'was', 'were', 'are', 'you', 'your',
  'what', 'when', 'where', 'which', 'who', 'how', 'about', 'from', 'have', 'has',
  'had', 'been', 'they', 'them', 'their', 'there', 'here', 'can', 'could', 'would',
  'should', 'will', 'did', 'does', 'not', 'but', 'all', 'any', 'some', 'read', 'page',
  'site', 'website', 'article', 'find', 'search', 'show', 'tell',
]);
