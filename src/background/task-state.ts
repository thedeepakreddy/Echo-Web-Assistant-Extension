// Durable task markers, one per running task. Avatars working in their own
// tabs each have a task, so several can run at once. If Chrome terminates the
// MV3 worker mid-run, the next worker reports each interruption instead of
// leaving the UI thinking.

import { DEFAULT_SCOPE } from './agents/leases';

export interface ActiveTask { id: string; scope: string; tabId?: number; startedAt: number }

const KEY = 'echo_active_tasks';
const LEGACY_KEY = 'echo_active_task';

const active = new Map<string, ActiveTask>();
let writes: Promise<unknown> = Promise.resolve();

// Chrome stops an idle MV3 worker after ~30 s without extension events, even
// while it awaits a slow model reply, and the task is lost. Any extension API
// call resets that timer, so a cheap one every 20 s keeps the worker alive for
// exactly as long as any task is running.
const KEEPALIVE_MS = 20_000;
let keepAlive: ReturnType<typeof setInterval> | null = null;
function holdWorker() {
  const on = active.size > 0;
  if (on && !keepAlive) keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, KEEPALIVE_MS);
  if (!on && keepAlive) { clearInterval(keepAlive); keepAlive = null; }
}

function persist(): Promise<void> {
  const snapshot = Object.fromEntries(active);
  const write = writes.then(() => chrome.storage.session.set({ [KEY]: snapshot }));
  writes = write.catch(() => {});
  return write;
}

function announce(scope: string) {
  const running = [...active.values()].filter(t => t.scope === scope);
  chrome.runtime.sendMessage({ type: 'ECHO_TASK_STATUS', agent: scope, active: running.length > 0,
    startedAt: running[0]?.startedAt }).catch(() => {});
}

/** Tasks a previous worker was running when it stopped. Clears the markers. */
export async function recoverInterruptedTasks(): Promise<ActiveTask[]> {
  const r = await chrome.storage.session.get([KEY, LEGACY_KEY]);
  const found = Object.values((r[KEY] || {}) as Record<string, ActiveTask>);
  const legacy = r[LEGACY_KEY] as Omit<ActiveTask, 'scope'> | undefined;
  if (legacy) found.push({ ...legacy, scope: DEFAULT_SCOPE });
  await chrome.storage.session.remove([KEY, LEGACY_KEY]);
  return found.filter(t => t && typeof t.id === 'string');
}

export async function beginTask(tabId?: number, scope: string = DEFAULT_SCOPE): Promise<string> {
  const task: ActiveTask = { id: crypto.randomUUID(), scope, tabId, startedAt: Date.now() };
  active.set(task.id, task);
  holdWorker();
  await persist();
  announce(scope);
  return task.id;
}

/** True when the task was still running (not already stopped by the user). */
export async function finishTask(id: string): Promise<boolean> {
  const task = active.get(id);
  if (!task) return false;
  active.delete(id);
  holdWorker();
  await persist();
  announce(task.scope);
  return true;
}

/** Stop tracking one scope's tasks, or every task when no scope is given. */
export async function cancelActiveTask(scope?: string): Promise<void> {
  const scopes = new Set<string>();
  for (const [id, task] of active) {
    if (scope && task.scope !== scope) continue;
    active.delete(id);
    scopes.add(task.scope);
  }
  if (scope) scopes.add(scope);
  holdWorker();
  await persist();
  scopes.forEach(announce);
}

export async function taskStatus(scope?: string): Promise<{ active: boolean; startedAt?: number }> {
  const running = [...active.values()].filter(t => !scope || t.scope === scope);
  return { active: running.length > 0, startedAt: running[0]?.startedAt };
}

/** Every scope that has a task running right now. */
export function runningScopes(): string[] {
  return [...new Set([...active.values()].map(t => t.scope))];
}
