// Browser actions cross a trust boundary: page text and model output may be
// adversarial. ECHO acts freely, but the user personally approves the two
// kinds of action that can't be taken back: paying for something, and
// sending a mail or message (see sensitiveAction below). Every action,
// approved or not, goes into the action log.

import { DEFAULT_SCOPE, scopeForTab } from './agents/leases';

export interface ApprovalPrompt {
  id: string;
  action: string;
  detail: string;
  site: string;
  tabId?: number;
}

/** How an approval ended: the user allowed or denied it, did not answer in time, or the task stopped. */
export type ApprovalOutcome = 'approved' | 'denied' | 'timeout' | 'stopped';

interface PendingApproval {
  prompt: ApprovalPrompt;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingApproval>();
const APPROVAL_TIMEOUT_MS = 45_000;
/** Less time than this and the user could not realistically answer. */
export const MIN_APPROVAL_MS = 5_000;

// Each scope (the classic ECHO, or an avatar holding a tab) has its own task
// counter. Stopping one bumps only its counter, so an action another avatar
// is about to take goes ahead. The scope comes from the tab being acted on.
const epochs = new Map<string, number>();

export function currentTaskEpoch(tabId?: number | null): number {
  return epochs.get(scopeForTab(tabId)) || 0;
}

/** Stop one scope's work in progress, or every scope's when none is given. */
export function cancelTask(scope?: string): void {
  const scopes = scope ? [scope] : [DEFAULT_SCOPE, ...epochs.keys()];
  for (const s of new Set(scopes)) epochs.set(s, (epochs.get(s) || 0) + 1);
  denyPendingApprovals(scope);
}
export function pendingApproval(tabId?: number): ApprovalPrompt | null {
  return [...pending.values()].map(item => item.prompt)
    .find(prompt => tabId == null || prompt.tabId === tabId) || null;
}

export function approvalById(id: string): ApprovalPrompt | null {
  return pending.get(id)?.prompt || null;
}

function broadcast(prompt: ApprovalPrompt | { id: string; type: 'ECHO_APPROVAL_CLEAR' }) {
  const message = 'type' in prompt ? prompt : { type: 'ECHO_APPROVAL_REQUEST', ...prompt };
  chrome.runtime.sendMessage(message).catch(() => {});
  const tabId = 'tabId' in prompt ? prompt.tabId : undefined;
  if (tabId != null) chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

/**
 * Ask the user to allow a payment or a send. `timeoutMs` shortens the wait
 * when the caller has a deadline of its own (an agent's tool call): the prompt
 * must close before the caller gives up, so a late "Allow" never acts.
 */
export async function requestApproval(action: string, detail: string, tabId?: number,
  timeoutMs: number = APPROVAL_TIMEOUT_MS): Promise<boolean> {
  return (await requestApprovalOutcome(action, detail, tabId, timeoutMs)) === 'approved';
}

/** As requestApproval, saying how it ended, so an agent can be told the difference. */
export async function requestApprovalOutcome(action: string, detail: string, tabId?: number,
  timeoutMs: number = APPROVAL_TIMEOUT_MS): Promise<ApprovalOutcome> {
  if (timeoutMs < MIN_APPROVAL_MS) return 'timeout';
  const epoch = currentTaskEpoch(tabId);
  let site = 'the current page';
  if (tabId != null) {
    try { site = new URL((await chrome.tabs.get(tabId)).url || '').hostname || site; } catch { /* no tab */ }
  }
  // Stopped while looking up the site: never show a prompt for a stopped task.
  if (currentTaskEpoch(tabId) !== epoch) return 'stopped';
  const prompt: ApprovalPrompt = {
    id: crypto.randomUUID(), action, detail: detail.slice(0, 180), site, tabId,
  };
  return new Promise(resolve => {
    const timer = setTimeout(() => close(prompt.id, 'timeout'), Math.min(timeoutMs, APPROVAL_TIMEOUT_MS));
    pending.set(prompt.id, { prompt, resolve, timer });
    broadcast(prompt);
  });
}

function close(id: string, outcome: ApprovalOutcome): boolean {
  const item = pending.get(id);
  if (!item) return false;
  pending.delete(id);
  clearTimeout(item.timer);
  item.resolve(outcome);
  const clear = { type: 'ECHO_APPROVAL_CLEAR' as const, id };
  chrome.runtime.sendMessage(clear).catch(() => {});
  if (item.prompt.tabId != null) chrome.tabs.sendMessage(item.prompt.tabId, clear).catch(() => {});
  return true;
}

/** The user's answer to a prompt. */
export function settleApproval(id: string, approved: boolean, senderTabId?: number): boolean {
  const item = pending.get(id);
  if (!item) return false;
  // A content-script answer must come from the tab where the action is pending.
  if (senderTabId != null && senderTabId !== item.prompt.tabId) return false;
  return close(id, approved === true ? 'approved' : 'denied');
}

/** Close waiting approvals for one scope's tabs, or all of them: that work was stopped. */
export function denyPendingApprovals(scope?: string): void {
  for (const [id, item] of [...pending.entries()]) {
    if (!scope || scopeForTab(item.prompt.tabId) === scope) close(id, 'stopped');
  }
}

// Actions the user denied: asking again for the same one in the same task
// would only nag. Keyed by the page and the control; forgotten after a stop
// (a new task epoch) or after a while.
const DENIAL_MEMORY_MS = 10 * 60_000;
const denials = new Map<string, number>();
const denialKey = (tabId: number | undefined, what: string) => `${scopeForTab(tabId)}|${currentTaskEpoch(tabId)}|${what}`;

export function rememberDenial(tabId: number | undefined, what: string): void {
  const now = Date.now();
  for (const [key, at] of denials) if (now - at > DENIAL_MEMORY_MS) denials.delete(key);
  denials.set(denialKey(tabId, what), now);
}

export function wasDenied(tabId: number | undefined, what: string): boolean {
  const at = denials.get(denialKey(tabId, what));
  return at !== undefined && Date.now() - at <= DENIAL_MEMORY_MS;
}

export async function logAction(action: string, detail: string, status: 'approved' | 'denied' | 'done' | 'failed'): Promise<void> {
  // No typed text or page contents are stored in the log.
  const entry = { action, detail: detail.slice(0, 180), status, ts: Date.now() };
  const { echo_action_log } = await chrome.storage.local.get(['echo_action_log']);
  const log = Array.isArray(echo_action_log) ? echo_action_log : [];
  await chrome.storage.local.set({ echo_action_log: [...log, entry].slice(-100) });
  chrome.runtime.sendMessage({ type: 'ECHO_ACTION_LOG', entry }).catch(() => {});
}

// ---- which actions need the user's approval -------------------------------

export type SensitiveKind = 'payment' | 'message';

const PAY_LABEL = /\b(pay|payment|pay now|buy|buy now|purchase|check ?out|place (your )?order|order now|complete (your )?(order|purchase|payment)|confirm (and )?(pay|order|purchase|payment|booking)|book (now|and pay)|subscribe|start (my |your )?(trial|subscription)|upgrade|renew|donate|send money|transfer|top ?up|recharge|add funds|withdraw)\b/i;
const SEND_LABEL = /\b(send|send (now|email|mail|message)|reply( all)?|forward|post|publish|tweet|retweet|repost|comment|submit (comment|review|reply|post)|share (post|now))\b/i;
// "Checkout", "Proceed to checkout": controls that open the checkout page.
const CHECKOUT_PAGE_LINK = /^(?:(?:proceed|go|continue) to )?(?:secure )?check ?out$/i;
/** The name inside a control label like `<button> "Proceed to checkout"`. */
const controlName = (label: string) => (label.match(/^<[^>]*>\s*"(.*)"$/)?.[1] ?? label).trim();
const CONFIRM_LABEL = /\b(confirm|continue|submit|next|proceed|complete|finish|done|ok)\b/i;
const PAYMENT_PAGE = /(checkout|payment|\/pay\b|\/pay\/|billing|purchase|\/buy\/|order-?review|place-?order)/i;
const PAYMENT_HOST = /(^|\.)(paypal\.com|stripe\.com|razorpay\.com|paytm\.com|phonepe\.com|pay\.google\.com|payments\.google\.com|venmo\.com|wise\.com|revolut\.com|cash\.app|squareup\.com|checkout\.shopify\.com)$/i;
// Sites where pressing Enter (or submitting typed text) sends a message.
const MESSAGE_HOST = /(^|\.)(mail\.google\.com|outlook\.(live|office|office365)\.com|mail\.yahoo\.com|mail\.proton\.me|icloud\.com|web\.whatsapp\.com|messenger\.com|facebook\.com|slack\.com|discord\.com|web\.telegram\.org|teams\.microsoft\.com|teams\.live\.com|linkedin\.com|x\.com|twitter\.com|instagram\.com|reddit\.com|chat\.google\.com|signal\.org)$/i;

/**
 * Does this browser action pay for something or send a message? Those need
 * the user's approval; everything else runs straight away.
 */
export function sensitiveAction(a: { tool: string; label?: string; url?: string; key?: string; submit?: boolean }): SensitiveKind | null {
  let host = '';
  let path = '';
  try { const u = new URL(a.url || ''); host = u.hostname; path = u.pathname + u.search; } catch { /* no page */ }
  const label = (a.label || '').slice(0, 200);
  const onPaymentPage = PAYMENT_HOST.test(host) || PAYMENT_PAGE.test(path);

  if (a.tool === 'click_element' || a.tool === 'click_selector') {
    // Going to the checkout page is not paying; the payment click there still asks.
    if (!onPaymentPage && CHECKOUT_PAGE_LINK.test(controlName(label))) return null;
    if (PAY_LABEL.test(label)) return 'payment';
    if (onPaymentPage && CONFIRM_LABEL.test(label)) return 'payment';
    if (SEND_LABEL.test(label)) return 'message';
    return null;
  }
  // Enter or a typed-and-submitted field sends in mail and chat apps.
  const submits = (a.tool === 'press_key' && a.key === 'Enter') || (a.tool === 'type_text' && a.submit === true);
  if (submits) {
    if (MESSAGE_HOST.test(host)) return 'message';
    if (onPaymentPage) return 'payment';
  }
  return null;
}

export function safeNavigationUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('A URL is required.');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS pages can be opened.');
  return url.href;
}
