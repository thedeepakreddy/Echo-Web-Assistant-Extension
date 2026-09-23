// Web search with citations. Claude uses Anthropic's server-side web_search
// tool; Gemini uses Google Search grounding. Both return sources, which are
// shown as numbered links under the answer. Other providers answer without it.

import type { Source } from './chats';

export type SearchMode = 'auto' | 'off';

export async function webSearchMode(): Promise<SearchMode> {
  const { echo_local_settings } = await chrome.storage.local.get(['echo_local_settings']);
  return (echo_local_settings as any)?.webSearch === 'off' ? 'off' : 'auto';
}

/** Is a search-capable provider (Claude or Gemini with a key) configured and search on? */
export async function searchAvailable(): Promise<boolean> {
  const r = await chrome.storage.local.get(['provider', 'anthropicApiKey', 'geminiApiKey', 'echo_local_settings']);
  if ((r.echo_local_settings as any)?.webSearch === 'off') return false;
  const provider = r.provider || 'claude';
  return (provider === 'claude' && !!r.anthropicApiKey) || (provider === 'gemini' && !!r.geminiApiKey);
}

/** Questions that need live information rather than the current page. */
export function looksLikeSearch(q: string): boolean {
  const s = String(q || '').toLowerCase();
  if (/\b(this|the) (page|article|site|tab|video|form)\b|\bon this\b|\bhere\b/.test(s)) return false;
  return /\b(search (the )?(web|internet|online)|look (it |this )?up online|on the (web|internet)|latest|news|today|tonight|yesterday|this (week|month|year)|right now|currently|current(ly)? (price|status|version|weather)|live score|score of|weather|forecast|price of|stock price|exchange rate|release date|who won|election|recent(ly)?|trending|with sources|cite|citations?)\b/.test(s)
    || /\b20(2[5-9]|3\d)\b/.test(s);
}

/** Newest Claude models use the dynamic-filtering variant of the tool. */
export function claudeSearchToolType(model: string): 'web_search_20260209' | 'web_search_20250305' {
  return /claude-(opus-(5|4-[6-9])|sonnet-(5|4-6)|fable|mythos)/i.test(model || '')
    ? 'web_search_20260209' : 'web_search_20250305';
}

function numberer() {
  const sources: Source[] = [];
  const index = new Map<string, number>();
  const num = (url: string, title: string): number => {
    const key = url.trim();
    if (!index.has(key)) {
      sources.push({ url: key, title: (title || '').trim() || hostOf(key) });
      index.set(key, sources.length);
    }
    return index.get(key)!;
  };
  return { sources, num };
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/**
 * Claude splits a searched answer into text blocks, each with its own
 * citations. Join them in order and put [n] markers after cited blocks.
 */
export function formatClaudeCitations(blocks: any[]): { text: string; sources: Source[] } {
  const { sources, num } = numberer();
  let text = '';
  for (const block of blocks || []) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    text += block.text;
    const marks = new Set<number>();
    for (const c of block.citations || []) {
      if (c?.url) marks.add(num(String(c.url), String(c.title || '')));
    }
    if (marks.size) text += [...marks].map(n => `[${n}]`).join('');
  }
  return { text: text.trim(), sources };
}

/**
 * Gemini grounding metadata: chunks are the sources, supports map answer
 * segments to chunks. Markers go right after each supported segment. Offsets
 * are found by searching for the segment text, which is robust whether the API
 * counts bytes or characters.
 */
export function formatGeminiGrounding(answer: string, metadata: any): { text: string; sources: Source[]; searchHtml?: string } {
  const text = String(answer || '');
  const chunks: any[] = Array.isArray(metadata?.groundingChunks) ? metadata.groundingChunks : [];
  const { sources, num } = numberer();
  const inserts: { at: number; marks: string }[] = [];
  let cursor = 0;
  for (const support of metadata?.groundingSupports || []) {
    const segment = String(support?.segment?.text || '');
    const ids: number[] = (support?.groundingChunkIndices || [])
      .map((i: number) => chunks[i]?.web).filter((w: any) => w?.uri)
      .map((w: any) => num(String(w.uri), String(w.title || '')));
    if (!segment || !ids.length) continue;
    let at = text.indexOf(segment, cursor);
    if (at < 0) at = text.indexOf(segment);
    if (at < 0) continue;
    const end = at + segment.length;
    cursor = end;
    inserts.push({ at: end, marks: [...new Set(ids)].map(n => `[${n}]`).join('') });
  }
  // Sources that support no specific segment are still listed.
  for (const c of chunks) if (c?.web?.uri) num(String(c.web.uri), String(c.web.title || ''));
  let out = text;
  for (const ins of inserts.sort((a, b) => b.at - a.at)) out = out.slice(0, ins.at) + ins.marks + out.slice(ins.at);
  const searchHtml = typeof metadata?.searchEntryPoint?.renderedContent === 'string'
    ? metadata.searchEntryPoint.renderedContent : undefined;
  return { text: out.trim(), sources, searchHtml };
}

/** Old turns keep their text but drop search payloads (large and not needed again). */
export function stripClaudeSearchBlocks(content: any): any {
  if (!Array.isArray(content)) return content;
  const kept = content
    .filter((b: any) => b?.type !== 'server_tool_use' && b?.type !== 'web_search_tool_result')
    .map((b: any) => (b?.type === 'text' && b.citations ? { type: 'text', text: b.text } : b));
  return kept.length ? kept : [{ type: 'text', text: '(searched the web)' }];
}
