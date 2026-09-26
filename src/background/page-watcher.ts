// Tier 0 — page watchers.
//
// "Tell me when this drops below $800." A watcher stores a URL plus a text
// pattern, re-checks it on a chrome.alarms schedule in a background tab, and
// fires a desktop notification when the condition flips. Zero API cost, runs
// forever.

export type WatchCondition = 'changed' | 'below' | 'above' | 'contains' | 'missing';

export interface Watcher {
  id: string;
  url: string;
  label: string;
  /** Optional CSS selector; when absent we scan the whole page text. */
  selector?: string;
  condition: WatchCondition;
  /** Threshold for below/above, needle for contains/missing. */
  target?: string;
  lastValue?: string;
  intervalMin: number;
  created: number;
  checks: number;
  triggered: boolean;
}

export const WATCH_ALARM_PREFIX = 'echo_watch_';

type FiredListener = (watcher: Watcher, detail: string) => void;
const firedListeners: FiredListener[] = [];
/** Called when a watcher's condition is met (after the user is notified). */
export function onWatcherFired(listener: FiredListener): void { firedListeners.push(listener); }

export async function listWatchers(): Promise<Record<string, Watcher>> {
  const r = await chrome.storage.local.get(['echo_watchers']);
  return (r.echo_watchers || {}) as Record<string, Watcher>;
}

async function saveWatchers(w: Record<string, Watcher>) {
  await chrome.storage.local.set({ echo_watchers: w });
}

export async function createWatcher(opts: {
  url: string; label: string; selector?: string;
  condition: WatchCondition; target?: string; intervalMin?: number;
}): Promise<Watcher> {
  const id = `${WATCH_ALARM_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  // Chrome refuses alarm periods under 1 minute; 30 is a sane floor for polling.
  const intervalMin = Math.max(30, Math.min(opts.intervalMin || 60, 1440));
  const w: Watcher = {
    id,
    url: opts.url,
    label: opts.label || opts.url,
    selector: opts.selector,
    condition: opts.condition,
    target: opts.target,
    intervalMin,
    created: Date.now(),
    checks: 0,
    triggered: false,
  };
  const all = await listWatchers();
  all[id] = w;
  await saveWatchers(all);
  chrome.alarms.create(id, { delayInMinutes: intervalMin, periodInMinutes: intervalMin });
  // Seed lastValue immediately so "changed" has a baseline to compare against.
  captureBaseline(w).catch(() => {});
  return w;
}

export async function deleteWatcher(idOrLabel: string): Promise<boolean> {
  const all = await listWatchers();
  const key = all[idOrLabel]
    ? idOrLabel
    : Object.keys(all).find(k => all[k].label.toLowerCase().includes(idOrLabel.toLowerCase()));
  if (!key) return false;
  delete all[key];
  await saveWatchers(all);
  await chrome.alarms.clear(key);
  return true;
}

export async function clearWatchers(): Promise<void> {
  const all = await listWatchers();
  for (const id of Object.keys(all)) await chrome.alarms.clear(id);
  await chrome.storage.local.set({ echo_watchers: {} });
}

async function captureBaseline(w: Watcher) {
  const value = await readValue(w);
  if (value === null) return;
  const all = await listWatchers();
  if (!all[w.id]) return;
  all[w.id].lastValue = value;
  await saveWatchers(all);
}

/** Open the page in a background tab, read the value, close the tab. */
async function readValue(w: Watcher): Promise<string | null> {
  let tab: chrome.tabs.Tab | null = null;
  try {
    tab = await chrome.tabs.create({ url: w.url, active: false });
    await waitForLoad(tab.id!);
    // Content scripts run at document_end; give React-y pages a beat to paint.
    await sleep(1200);
    const res: any = await chrome.tabs.sendMessage(tab.id!, {
      type: 'DOM_ACTION', action: 'read_value', args: { selector: w.selector },
    });
    if (res?.success && typeof res.result?.value === 'string') return res.result.value;
    return null;
  } catch {
    return null;
  } finally {
    if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function firstNumber(s: string): number | null {
  const m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/** Evaluate a watcher's condition against a freshly read value. */
export function evaluate(w: Watcher, value: string): { hit: boolean; detail: string } {
  const prev = w.lastValue ?? '';
  switch (w.condition) {
    case 'changed':
      return { hit: prev !== '' && value !== prev, detail: `was "${truncate(prev)}", now "${truncate(value)}"` };
    case 'below': {
      const n = firstNumber(value), t = firstNumber(w.target || '');
      if (n === null || t === null) return { hit: false, detail: 'no number found' };
      return { hit: n < t, detail: `${n} is below ${t}` };
    }
    case 'above': {
      const n = firstNumber(value), t = firstNumber(w.target || '');
      if (n === null || t === null) return { hit: false, detail: 'no number found' };
      return { hit: n > t, detail: `${n} is above ${t}` };
    }
    case 'contains': {
      const needle = (w.target || '').toLowerCase();
      return { hit: !!needle && value.toLowerCase().includes(needle), detail: `found "${w.target}"` };
    }
    case 'missing': {
      const needle = (w.target || '').toLowerCase();
      return { hit: !!needle && !value.toLowerCase().includes(needle), detail: `"${w.target}" is gone` };
    }
    default:
      return { hit: false, detail: '' };
  }
}

const NOTIF_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Called from the alarm handler. Returns true if the watcher fired. */
export async function runWatcherCheck(id: string): Promise<boolean> {
  const all = await listWatchers();
  const w = all[id];
  if (!w) { await chrome.alarms.clear(id); return false; }

  const value = await readValue(w);
  w.checks++;
  if (value === null) { all[id] = w; await saveWatchers(all); return false; }

  const { hit, detail } = evaluate(w, value);
  const prevValue = w.lastValue;
  w.lastValue = value;

  if (hit && !w.triggered) {
    w.triggered = true;
    all[id] = w;
    await saveWatchers(all);
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: NOTIF_ICON,
      title: `ECHO: ${w.label}`,
      message: `${detail}\nClick to open the page.`,
      priority: 2,
    });
    for (const listener of firedListeners) {
      try { listener(w, detail); } catch (error) { console.warn('[ECHO] Watcher listener failed:', error); }
    }
    return true;
  }

  // Re-arm once the condition relaxes, so a watcher can fire again later.
  if (!hit && w.triggered && prevValue !== value) w.triggered = false;

  all[id] = w;
  await saveWatchers(all);
  return false;
}

/** Rebuild alarms after a browser restart (service worker loses them). */
export async function rehydrateWatchers(): Promise<void> {
  const all = await listWatchers();
  for (const w of Object.values(all)) {
    const existing = await chrome.alarms.get(w.id);
    if (!existing) {
      chrome.alarms.create(w.id, { delayInMinutes: w.intervalMin, periodInMinutes: w.intervalMin });
    }
  }
}

export function describeWatcher(w: Watcher): string {
  const cond = w.condition === 'changed' ? 'changes'
    : w.condition === 'below' ? `drops below ${w.target}`
    : w.condition === 'above' ? `goes above ${w.target}`
    : w.condition === 'contains' ? `contains "${w.target}"`
    : `no longer contains "${w.target}"`;
  return `${w.label} — alerts when it ${cond}, checked every ${w.intervalMin} min${w.lastValue ? ` (last: ${truncate(w.lastValue)})` : ''}`;
}

function truncate(s: string, n = 40): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function waitForLoad(tabId: number, timeout = 12000): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab || tab.status === 'complete') return resolve();
        if (Date.now() - start > timeout) return resolve();
        setTimeout(poll, 300);
      });
    };
    setTimeout(poll, 700);
  });
}
