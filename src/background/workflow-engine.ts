// Tier 0 — workflow recorder & player.
//
// "Watch me" streams steps into session storage so ordinary page navigation and
// MV3 worker restarts do not erase a recording.

import { requestApproval, currentTaskEpoch, safeNavigationUrl, logAction, sensitiveAction } from './safety';
import { say } from './bus';

/** A saved workflow must not retain or replay authentication links. */
export function isSafeWorkflowUrl(raw: string): boolean {
  try {
    const url = new URL(safeNavigationUrl(raw));
    if (url.username || url.password) return false;
    if (/(?:^|\/)(?:login|signin|signup|auth|oauth|reset-password|checkout|payment)(?:\/|$)/i.test(url.pathname)) return false;
    for (const key of url.searchParams.keys()) {
      if (/^(?:access_?token|id_?token|refresh_?token|token|api_?key|key|code|state|session|secret|password|signature)$/i.test(key)) return false;
    }
    if (/(?:access_?token|id_?token|refresh_?token|token|code|session|secret|password)=/i.test(url.hash)) return false;
    return true;
  } catch { return false; }
}

export interface WorkflowStep {
  type: 'click' | 'type' | 'key' | 'scroll' | 'navigate' | 'wait' | 'select';
  /** Ordered selector candidates, most stable first. */
  selectors?: string[];
  /** Visible label at record time — last-resort way to re-find the element. */
  label?: string;
  value?: string;
  url?: string;
  ms?: number;
  id?: string;
  at?: number;
  /** For 'select': the chosen dropdown option(s). */
  options?: { value: string; text: string }[];
}

export interface Workflow {
  name: string;
  steps: WorkflowStep[];
  startUrl: string;
  created: number;
  runs: number;
}

interface RecordingState { tabId: number; startUrl: string; lastUrl: string; startedAt: number; steps: WorkflowStep[] }

let recording: RecordingState | null = null;
let recordingWrites: Promise<unknown> = Promise.resolve();

async function loadRecording(): Promise<RecordingState | null> {
  if (recording) return recording;
  const r = await chrome.storage.session.get(['echo_recording']);
  const stored = r.echo_recording as RecordingState | undefined;
  recording = stored?.tabId && Array.isArray(stored.steps) ? stored : null;
  return recording;
}

export async function isRecording(): Promise<boolean> { return (await loadRecording()) !== null; }
export async function recordingTab(): Promise<number | null> { return (await loadRecording())?.tabId ?? null; }

export async function startRecording(tabId: number, startUrl: string): Promise<void> {
  if (!isSafeWorkflowUrl(startUrl)) throw new Error('Workflows cannot record sign-in or token-bearing URLs.');
  recording = { tabId, startUrl, lastUrl: startUrl, startedAt: Date.now(), steps: [] };
  await chrome.storage.session.set({ echo_recording: recording });
  await chrome.tabs.sendMessage(tabId, { type: 'DOM_ACTION', action: 'record_start', args: {} })
    .catch(() => { /* page will resume when its content script loads */ });
}

export function appendRecordedStep(tabId: number, step: WorkflowStep): Promise<boolean> {
  const work = recordingWrites.then(async () => {
    const state = await loadRecording();
    if (!state || state.tabId !== tabId || state.steps.length >= 200) return false;
    if (!['click', 'type', 'key', 'scroll', 'navigate', 'wait', 'select'].includes(step?.type)) return false;
    if (step.type === 'navigate' && !isSafeWorkflowUrl(step.url || '')) return false;
    if (step.type === 'select' && (!Array.isArray(step.options) || !step.options.length)) return false;
    if (step.id && state.steps.some(s => s.id === step.id)) return true;
    const options = step.type === 'select'
      ? step.options!.slice(0, 50).map(o => ({ value: String(o?.value ?? '').slice(0, 200), text: String(o?.text ?? '').slice(0, 200) }))
      : undefined;
    state.steps.push({ ...step, value: step.value?.slice(0, 2000), options });
    await chrome.storage.session.set({ echo_recording: state });
    return true;
  });
  recordingWrites = work.catch(() => {});
  return work;
}

export async function resumeRecordingForTab(tabId: number): Promise<boolean> {
  return (await loadRecording())?.tabId === tabId;
}

// A URL change this soon after a recorded click/Enter was caused by it.
const NAV_CAUSED_BY_STEP_MS = 4000;

export async function recordNavigation(tabId: number, url: string): Promise<void> {
  const work = recordingWrites.then(async (): Promise<'unsafe' | void> => {
    const state = await loadRecording();
    if (!state || state.tabId !== tabId || state.lastUrl === url) return;
    if (!isSafeWorkflowUrl(url)) return 'unsafe';
    state.lastUrl = url;
    // Replaying the click already performs this navigation; a separate
    // navigate step would load the page twice.
    const last = state.steps[state.steps.length - 1];
    const causedByStep = !!last && (last.type === 'click' || (last.type === 'key' && last.value === 'Enter'))
      && Date.now() - (last.at || 0) < NAV_CAUSED_BY_STEP_MS;
    if (!causedByStep && state.steps.length < 200) {
      state.steps.push({ type: 'navigate', url, id: crypto.randomUUID(), at: Date.now() });
    }
    await chrome.storage.session.set({ echo_recording: state });
  });
  recordingWrites = work.catch(() => {});
  if (await work === 'unsafe') {
    await cancelRecording();
    say(tabId, 'Recording stopped because this page has a private sign-in or token URL. No workflow was saved.');
  }
}

/** Pull the captured steps out of the page and persist them under `name`. */
export async function stopRecording(name: string): Promise<{ ok: boolean; count: number; message: string }> {
  await recordingWrites;
  const state = await loadRecording();
  if (!state) return { ok: false, count: 0, message: 'Not currently recording.' };
  const { tabId, startUrl } = state;

  const steps: WorkflowStep[] = [...state.steps];
  recording = null;
  await chrome.storage.session.remove('echo_recording');
  try {
    const res: any = await chrome.tabs.sendMessage(tabId, { type: 'DOM_ACTION', action: 'record_stop', args: {} });
    if (res?.success && Array.isArray(res.result?.steps)) {
      const seen = new Set(steps.map(s => s.id).filter(Boolean));
      for (const step of res.result.steps as WorkflowStep[]) {
        if (step.id && seen.has(step.id)) continue;
        steps.push(step);
      }
    }
  } catch { /* page may have navigated; streamed steps still survive */ }
  steps.sort((a, b) => (a.at || 0) - (b.at || 0));

  if (!isSafeWorkflowUrl(startUrl) || steps.some(step => step.type === 'navigate' && !isSafeWorkflowUrl(step.url || '')))
    return { ok: false, count: 0, message: 'Recording contained a private sign-in or token URL, so it was not saved.' };

  if (!steps.length) {
    return { ok: false, count: 0, message: "I didn't capture any actions, so there's nothing to save." };
  }

  const wf: Workflow = { name: name.trim(), steps, startUrl, created: Date.now(), runs: 0 };
  const all = await listWorkflows();
  all[wf.name] = wf;
  await chrome.storage.local.set({ echo_workflows: all });
  return { ok: true, count: steps.length, message: `Saved "${wf.name}" — ${steps.length} steps.` };
}

export async function cancelRecording(): Promise<void> {
  await recordingWrites;
  const state = await loadRecording();
  if (!state) return;
  const { tabId } = state;
  recording = null;
  await chrome.storage.session.remove('echo_recording');
  await chrome.tabs.sendMessage(tabId, { type: 'DOM_ACTION', action: 'record_stop', args: {} }).catch(() => {});
}

export async function listWorkflows(): Promise<Record<string, Workflow>> {
  const r = await chrome.storage.local.get(['echo_workflows']);
  return (r.echo_workflows || {}) as Record<string, Workflow>;
}

export async function deleteWorkflow(name: string): Promise<boolean> {
  const all = await listWorkflows();
  const key = findWorkflowKey(all, name);
  if (!key) return false;
  delete all[key];
  await chrome.storage.local.set({ echo_workflows: all });
  return true;
}

/** Tolerant name lookup so "run my standup" finds "daily standup". */
export function findWorkflowKey(all: Record<string, Workflow>, name: string): string | null {
  const n = name.toLowerCase().trim();
  if (!n) return null;
  const keys = Object.keys(all);
  const exact = keys.find(k => k.toLowerCase() === n);
  if (exact) return exact;
  const contains = keys.find(k => k.toLowerCase().includes(n) || n.includes(k.toLowerCase()));
  return contains || null;
}

export async function previewWorkflow(name: string): Promise<string> {
  const all = await listWorkflows();
  const key = findWorkflowKey(all, name);
  if (!key) return `No saved workflow named "${name}".`;
  const wf = all[key];
  const lines = wf.steps.map((step, i) => `${i + 1}. ${step.type === 'navigate' ? `Go to ${isSafeWorkflowUrl(step.url || '') ? step.url : '[private URL — cannot replay]'}` :
    step.type === 'type' ? `Type into ${step.label || 'a field'} (value hidden)` :
    step.type === 'select' ? `Choose ${(step.options || []).map(o => `"${o.text || o.value}"`).join(', ')} in ${step.label || 'a dropdown'}` :
    `${step.type} ${step.label || step.value || ''}`}`);
  return `Preview of "${key}" (${wf.steps.length} steps):\n${lines.join('\n')}\nNo actions were taken.`;
}

export interface PlayResult { ok: boolean; message: string; done: number; total: number }

/**
 * Replay a workflow in `tabId`. Navigation steps wait for load; everything
 * else is handed to the content script, which resolves the selector list.
 */
export async function playWorkflow(name: string, tabId: number): Promise<PlayResult> {
  const all = await listWorkflows();
  const key = findWorkflowKey(all, name);
  if (!key) {
    const names = Object.keys(all);
    return {
      ok: false, done: 0, total: 0,
      message: names.length
        ? `I don't have a workflow called "${name}". I have: ${names.join(', ')}.`
        : `I don't have any workflows saved yet. Say "record a workflow" to make one.`,
    };
  }

  const wf = all[key];
  if ((wf.startUrl && !isSafeWorkflowUrl(wf.startUrl)) || wf.steps.some(step => step.type === 'navigate' && !isSafeWorkflowUrl(step.url || '')))
    return { ok: false, done: 0, total: wf.steps.length, message: 'This saved workflow contains a private or token URL and cannot be replayed. Please record it again.' };
  let done = 0;
  const epoch = currentTaskEpoch();

  const count = (t: WorkflowStep['type']) => wf.steps.filter(step => step.type === t).length;
  const parts = [`${count('click')} clicks`, `${count('type')} typed fields`, `${count('select')} dropdown choices`, `${count('navigate')} page loads`];
  let startHost = '';
  try { startHost = wf.startUrl ? new URL(wf.startUrl).host : ''; } catch { /* checked above */ }
  const summary = `Run workflow "${key}": ${wf.steps.length} steps (${parts.join(', ')})${startHost ? ` starting at ${startHost}` : ''}`;
  // You recorded these steps yourself, so a run only waits for approval when
  // it pays for something or sends a message — once, for the whole run.
  let pageUrl = wf.startUrl || '';
  const risky = wf.steps.some(step => {
    if (step.type === 'navigate' && step.url) pageUrl = step.url;
    const tool = step.type === 'click' ? 'click_element' : step.type === 'key' ? 'press_key' : step.type === 'type' ? 'type_text' : '';
    return !!tool && !!sensitiveAction({ tool, label: step.label, url: pageUrl, key: step.value });
  });
  if (risky) {
    if (!await requestApproval('workflow_run', summary, tabId)) {
      await logAction('workflow_run', summary, 'denied');
      return { ok: false, done, total: wf.steps.length, message: 'Workflow run was not approved.' };
    }
    if (currentTaskEpoch() !== epoch) return { ok: false, done, total: wf.steps.length, message: 'Workflow stopped by user.' };
  }
  await logAction('workflow_run', summary, risky ? 'approved' : 'done');

  // Start from the page the recording began on, so selectors line up.
  if (wf.startUrl) {
    try {
      const startUrl = safeNavigationUrl(wf.startUrl);
      await chrome.tabs.update(tabId, { url: startUrl });
      await waitForLoad(tabId);
    } catch { return { ok: false, done, total: wf.steps.length, message: 'Could not open the workflow start page.' }; }
  }

  for (const step of wf.steps) {
    if (currentTaskEpoch() !== epoch) return { ok: false, done, total: wf.steps.length, message: 'Workflow stopped by user.' };
    try {
      if (step.type === 'navigate' && step.url) {
        const nextUrl = safeNavigationUrl(step.url);
        // Older recordings saved the page a click led to; skip reloading it.
        if ((await chrome.tabs.get(tabId)).url === nextUrl) { await waitForLoad(tabId, 9000, 0); done++; continue; }
        await chrome.tabs.update(tabId, { url: nextUrl });
        await waitForLoad(tabId);
        done++;
        continue;
      }
      if (step.type === 'wait') {
        await sleep(Math.min(step.ms || 500, 5000));
        done++;
        continue;
      }
      const message = { type: 'DOM_ACTION', action: 'play_step', args: step };
      let res: any;
      try {
        res = await chrome.tabs.sendMessage(tabId, message);
      } catch {
        // The previous step may have started a page load; retry once it settles.
        await waitForLoad(tabId, 9000, 0);
        await sleep(300);
        res = await chrome.tabs.sendMessage(tabId, message);
      }
      // Controls can appear a moment late (e.g. a state list that loads after
      // choosing a country), so give the page two short chances to catch up.
      for (let retry = 0; !res?.success && retry < 2; retry++) {
        await sleep(700);
        if (currentTaskEpoch() !== epoch) return { ok: false, done, total: wf.steps.length, message: 'Workflow stopped by user.' };
        res = await chrome.tabs.sendMessage(tabId, message);
      }
      if (!res?.success) {
        return {
          ok: false, done, total: wf.steps.length,
          message: `Stopped at step ${done + 1} of ${wf.steps.length} — ${res?.error || `couldn't find "${step.label || step.type}"`}. The page may have changed since I recorded it.`,
        };
      }
      done++;
      // Let the page react between actions, including any navigation a click
      // or Enter started (recordings no longer store that as its own step).
      await sleep(step.type === 'click' || step.type === 'select' ? 600 : 250);
      if (step.type === 'click' || step.type === 'key') await waitForLoad(tabId, 9000, 0);
    } catch {
      return {
        ok: false, done, total: wf.steps.length,
        message: `Stopped at step ${done + 1} — the page navigated away mid-run.`,
      };
    }
  }

  wf.runs = (wf.runs || 0) + 1;
  all[key] = wf;
  await chrome.storage.local.set({ echo_workflows: all });

  return { ok: true, done, total: wf.steps.length, message: `Ran "${key}" — all ${done} steps completed.` };
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function waitForLoad(tabId: number, timeout = 9000, initialDelay = 700): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab || tab.status === 'complete') return resolve();
        if (Date.now() - start > timeout) return resolve();
        setTimeout(poll, 300);
      });
    };
    setTimeout(poll, initialDelay);
  });
}
