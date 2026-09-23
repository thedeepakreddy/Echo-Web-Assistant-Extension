// Video transcripts, read from the page ECHO is on.
//
// YouTube: 1) the caption track the player uses (same-origin fetch, invisible),
//          2) the "Show transcript" panel in the description, as a fallback.
// Other sites: captions loaded into a <video> element's text tracks.

export interface Transcript { title: string; text: string; source: 'captions' | 'panel' | 'track' }

const cache = new Map<string, Transcript>();

function youTubeVideoId(): string | null {
  const host = location.hostname.replace(/^(www|m)\./, '');
  if (host !== 'youtube.com') return null;
  if (location.pathname === '/watch') return new URLSearchParams(location.search).get('v');
  const m = location.pathname.match(/^\/(shorts|live)\/([\w-]{6,})/);
  return m ? m[2] : null;
}

const stamp = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Pull the ytInitialPlayerResponse JSON object out of a watch page's HTML. */
export function extractPlayerResponse(html: string): any | null {
  const marker = html.indexOf('ytInitialPlayerResponse');
  if (marker < 0) return null;
  const start = html.indexOf('{', marker);
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/** json3 caption format -> "[m:ss] text" lines, grouped into ~20 s paragraphs. */
export function parseJson3(data: any): string {
  const lines: string[] = [];
  let bucket = '';
  let bucketStart = -1;
  for (const ev of data?.events || []) {
    if (!Array.isArray(ev.segs)) continue;
    const words = ev.segs.map((s: any) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!words) continue;
    const t = Number(ev.tStartMs) || 0;
    if (bucketStart < 0) bucketStart = t;
    bucket += (bucket ? ' ' : '') + words;
    if (t - bucketStart >= 20000) {
      lines.push(`[${stamp(bucketStart)}] ${bucket}`);
      bucket = '';
      bucketStart = -1;
    }
  }
  if (bucket) lines.push(`[${stamp(Math.max(0, bucketStart))}] ${bucket}`);
  return lines.join('\n');
}

/** Prefer a manual track in the page's language, then English, then auto captions. */
export function pickTrack(tracks: any[], lang: string): any | null {
  if (!tracks?.length) return null;
  const base = (lang || 'en').slice(0, 2).toLowerCase();
  const manual = tracks.filter(t => t.kind !== 'asr');
  const by = (list: any[], code: string) => list.find(t => String(t.languageCode || '').toLowerCase().startsWith(code));
  return by(manual, base) || by(manual, 'en') || manual[0] || by(tracks, base) || by(tracks, 'en') || tracks[0];
}

async function fromCaptionTrack(videoId: string): Promise<string | null> {
  const html = await (await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, { credentials: 'include' })).text();
  const player = extractPlayerResponse(html);
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const track = pickTrack(tracks, document.documentElement.lang || navigator.language);
  if (!track?.baseUrl) return null;
  const url = new URL(track.baseUrl, location.origin);
  if (url.origin !== location.origin) return null;
  url.searchParams.set('fmt', 'json3');
  const body = await (await fetch(url.href, { credentials: 'include' })).text();
  if (!body.trim()) return null;   // YouTube sometimes withholds tracks from direct fetches
  const text = parseJson3(JSON.parse(body));
  return text || null;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function readPanel(): string {
  return Array.from(document.querySelectorAll('ytd-transcript-segment-renderer'))
    .map(seg => {
      const t = seg.querySelector('.segment-timestamp')?.textContent?.trim() || '';
      const words = seg.querySelector('.segment-text')?.textContent?.replace(/\s+/g, ' ').trim() || '';
      return words ? `${t ? `[${t}] ` : ''}${words}` : '';
    })
    .filter(Boolean).join('\n');
}

async function fromTranscriptPanel(): Promise<string | null> {
  let text = readPanel();
  if (text) return text;
  let button = document.querySelector<HTMLElement>('ytd-video-description-transcript-section-renderer button');
  if (!button) {
    document.querySelector<HTMLElement>('#description-inline-expander #expand, tp-yt-paper-button#expand')?.click();
    await sleep(400);
    button = document.querySelector<HTMLElement>('ytd-video-description-transcript-section-renderer button');
  }
  if (!button) return null;
  button.click();
  for (let i = 0; i < 20 && !text; i++) { await sleep(300); text = readPanel(); }
  // Put the page back the way it was.
  document.querySelector<HTMLElement>(
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"] #visibility-button button')?.click();
  return text || null;
}

async function fromTextTracks(): Promise<string | null> {
  for (const video of Array.from(document.querySelectorAll('video'))) {
    for (const track of Array.from(video.textTracks || [])) {
      if (track.kind !== 'subtitles' && track.kind !== 'captions') continue;
      const previous = track.mode;
      if (previous === 'disabled') track.mode = 'hidden';   // loads cues without showing them
      for (let i = 0; i < 10 && !(track.cues && track.cues.length); i++) await sleep(200);
      const cues = Array.from(track.cues || []) as VTTCue[];
      track.mode = previous;
      const text = cues.map(c => `[${stamp(c.startTime * 1000)}] ${String(c.text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()}`)
        .filter(l => !l.endsWith('] ')).join('\n');
      if (text) return text;
    }
  }
  return null;
}

export async function getVideoTranscript(): Promise<Transcript | null> {
  const id = youTubeVideoId();
  const key = id ? `yt:${id}` : `page:${location.href}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let result: Transcript | null = null;
  if (id) {
    const title = document.title.replace(/\s*-\s*YouTube$/, '').replace(/^\(\d+\)\s*/, '');
    let text: string | null = null;
    try { text = await fromCaptionTrack(id); } catch { /* try the panel */ }
    if (text) result = { title, text, source: 'captions' };
    else {
      const panel = await fromTranscriptPanel().catch(() => null);
      if (panel) result = { title, text: panel, source: 'panel' };
    }
  } else {
    const text = await fromTextTracks();
    if (text) result = { title: document.title, text, source: 'track' };
  }
  if (result) cache.set(key, result);
  return result;
}

/** The DOM action: paged like get_page_text. */
export async function videoTranscriptAction(args: any): Promise<{ success: boolean; result?: string; error?: string }> {
  const t = await getVideoTranscript();
  if (!t) return { success: false, error: 'No transcript is available for this video (captions may be turned off).' };
  const limit = Math.min(12000, Math.max(500, Math.floor(Number(args?.limit) || 4000)));
  const offset = Math.min(t.text.length, Math.max(0, Math.floor(Number(args?.offset) || 0)));
  const end = Math.min(t.text.length, offset + limit);
  return { success: true, result: `VIDEO: ${t.title}\nTRANSCRIPT: ${offset}-${end} of ${t.text.length}\n`
    + `${end < t.text.length ? `NEXT_OFFSET: ${end}\n` : ''}\n${t.text.slice(offset, end)}` };
}
