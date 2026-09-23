// Minimal durable task marker. If Chrome terminates the MV3 worker mid-run,
// the next worker reports an interruption instead of leaving the UI thinking.

interface ActiveTask { id: string; tabId?: number; startedAt: number }

let activeTask: ActiveTask | null = null;

// Chrome stops an idle MV3 worker after ~30 s without extension events, even
// while it awaits a slow model reply, and the task is lost. Any extension API
// call resets that timer, so a cheap one every 20 s keeps the worker alive for
// exactly as long as a task is running.
const KEEPALIVE_MS = 20_000;
let keepAlive: ReturnType<typeof setInterval> | null = null;
function holdWorker(on: boolean) {
  if (on && !keepAlive) keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, KEEPALIVE_MS);
  if (!on && keepAlive) { clearInterval(keepAlive); keepAlive = null; }
}

export async function recoverInterruptedTask(): Promise<ActiveTask | null> {
  const r = await chrome.storage.session.get(['echo_active_task']);
  const interrupted = r.echo_active_task as ActiveTask | undefined;
  if (!interrupted) return null;
  await chrome.storage.session.remove('echo_active_task');
  return interrupted;
}

export async function beginTask(tabId?: number): Promise<string> {
  const task = { id: crypto.randomUUID(), tabId, startedAt: Date.now() };
  activeTask = task;
  holdWorker(true);
  await chrome.storage.session.set({ echo_active_task: task });
  chrome.runtime.sendMessage({ type: 'ECHO_TASK_STATUS', active: true, startedAt: task.startedAt }).catch(() => {});
  return task.id;
}

export async function finishTask(id: string): Promise<boolean> {
  if (activeTask?.id !== id) return false;
  activeTask = null;
  holdWorker(false);
  const r = await chrome.storage.session.get(['echo_active_task']);
  if ((r.echo_active_task as ActiveTask | undefined)?.id === id) await chrome.storage.session.remove('echo_active_task');
  chrome.runtime.sendMessage({ type: 'ECHO_TASK_STATUS', active: false }).catch(() => {});
  return true;
}

export async function cancelActiveTask(): Promise<void> {
  activeTask = null;
  holdWorker(false);
  await chrome.storage.session.remove('echo_active_task');
  chrome.runtime.sendMessage({ type: 'ECHO_TASK_STATUS', active: false }).catch(() => {});
}

export async function taskStatus(): Promise<{ active: boolean; startedAt?: number }> {
  const r = await chrome.storage.session.get(['echo_active_task']);
  const task = r.echo_active_task as ActiveTask | undefined;
  return { active: !!task, startedAt: task?.startedAt };
}
