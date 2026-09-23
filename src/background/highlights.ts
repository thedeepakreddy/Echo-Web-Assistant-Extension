// Tier 1 — highlights & notes.
//
// Text you save on any page is stored locally with its URL and context, and
// re-injected the next time you land on that page. Never touches the network.

import { STORE_HIGHLIGHTS, idbPut, idbGetAll, idbGetAllByIndex, idbDelete, idbClear } from './db';

export interface Highlight {
  id: string;
  url: string;
  title: string;
  text: string;
  note?: string;
  color: string;
  ts: number;
}

const MAX_HIGHLIGHTS = 1000;
const COLORS = ['#4a90e2', '#22c55e', '#f59e0b', '#ef4444', '#a855f7'];

function cleanUrl(url: string): string {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; }
}

export async function saveHighlight(
  url: string, title: string, text: string, note?: string, color?: string
): Promise<Highlight> {
  const h: Highlight = {
    id: `hl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    url: cleanUrl(url),
    title: (title || '').substring(0, 200),
    text: (text || '').replace(/\s+/g, ' ').trim().substring(0, 1200),
    note: note?.substring(0, 500),
    color: color || COLORS[Math.floor(Math.random() * COLORS.length)],
    ts: Date.now(),
  };
  await idbPut(STORE_HIGHLIGHTS, h);
  return h;
}

export async function highlightsForUrl(url: string): Promise<Highlight[]> {
  const list = await idbGetAllByIndex<Highlight>(STORE_HIGHLIGHTS, 'url', cleanUrl(url));
  return list.sort((a, b) => a.ts - b.ts);
}

export async function allHighlights(limit = MAX_HIGHLIGHTS): Promise<Highlight[]> {
  const list = await idbGetAll<Highlight>(STORE_HIGHLIGHTS, limit);
  return list.sort((a, b) => b.ts - a.ts);
}

export async function deleteHighlight(id: string): Promise<void> {
  await idbDelete(STORE_HIGHLIGHTS, id);
}

/** Delete every highlight saved on a site (www-insensitive). Returns the count. */
export async function forgetHighlightsForHost(hostname: string): Promise<number> {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  let removed = 0;
  for (const h of await allHighlights()) {
    let hHost = '';
    try { hHost = new URL(h.url).hostname.toLowerCase().replace(/^www\./, ''); } catch { continue; }
    if (hHost !== host) continue;
    await idbDelete(STORE_HIGHLIGHTS, h.id);
    removed++;
  }
  return removed;
}

export async function clearHighlights(): Promise<void> {
  await idbClear(STORE_HIGHLIGHTS);
}

export async function searchHighlights(query: string, limit = 10): Promise<Highlight[]> {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const all = await allHighlights();
  return all
    .filter(h => h.text.toLowerCase().includes(q)
      || h.title.toLowerCase().includes(q)
      || (h.note || '').toLowerCase().includes(q))
    .slice(0, limit);
}

/** Markdown export, grouped by page — pasteable straight into notes apps. */
export async function exportHighlightsMarkdown(): Promise<string> {
  const all = await allHighlights();
  if (!all.length) return '# ECHO Highlights\n\n_Nothing saved yet._\n';
  const byUrl = new Map<string, Highlight[]>();
  for (const h of all) {
    const arr = byUrl.get(h.url) || [];
    arr.push(h);
    byUrl.set(h.url, arr);
  }
  let md = `# ECHO Highlights\n\n_${all.length} highlights across ${byUrl.size} pages._\n\n`;
  for (const [url, list] of byUrl) {
    md += `## ${list[0].title || url}\n<${url}>\n\n`;
    for (const h of list.sort((a, b) => a.ts - b.ts)) {
      md += `> ${h.text}\n`;
      if (h.note) md += `\n**Note:** ${h.note}\n`;
      md += `\n_${new Date(h.ts).toLocaleString()}_\n\n`;
    }
  }
  return md;
}
