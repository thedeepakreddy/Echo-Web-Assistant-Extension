// ECHO ↔ OpenClaw gateway.
//
// Off unless `echo_openclaw.enabled` is set. When on, ECHO keeps two sockets
// to its gateway: a node that offers every avatar's browser tools (see
// browser-tools.ts), and an operator that runs each avatar's agent in its own
// session (see sessions.ts). Avatars reach OpenClaw only while both are up;
// otherwise the built-in brain answers, so requests never stall.

import { createGatewayConnection, type GatewayConnection, type GatewayState } from './connection';
import { createNodeToolHost } from './node-tools';
import { deviceIdentity, indexedDbKeyStore } from './identity';
import { browserToolsFor, resetLooking } from './browser-tools';
import { createSessionManager, type SessionManager } from './sessions';
import { AVATAR_AGENTS, allCommands, avatarByCharacter } from './registry';
import { TESTED_OPENCLAW } from './setup-script';
import { leaseFor, leasesReady, onLeaseChange } from '../agents/leases';
import { sayAs, setStateAs } from '../bus';
import type { GatewayBrowserDeviceTokenStore, HelloOk } from '@openclaw/gateway-client/browser';

export interface OpenClawSettings { enabled: boolean; url: string; sharedToken?: string }

export interface OpenClawStatus {
  enabled: boolean;
  url: string;
  /** A shared token is saved (it is deleted once both connections are paired). */
  hasToken: boolean;
  node: GatewayState;
  operator: GatewayState;
  serverVersion?: string;
  testedVersion: string;
  /** Whether the gateway approved ECHO's command list (a second, separate approval). */
  commands: { state: 'unknown' | 'pending' | 'approved'; requestId?: string };
  /** Tools published, commands approved and both roles connected: avatars run on OpenClaw. */
  ready: boolean;
}

const SETTINGS_KEY = 'echo_openclaw';
const TOKENS_KEY = 'echo_openclaw_device_tokens';
const STATE_KEY = 'echo_openclaw_state';
export const DEFAULT_URL = 'ws://127.0.0.1:18790';
// Under Chrome's 30 s idle limit with room to spare.
const KEEPALIVE_MS = 20_000;
// If Chrome stops the worker anyway (or the gateway was down), this alarm wakes
// it, and waking runs startOpenClaw() again. 30 s is Chrome's minimum period.
const WAKE_ALARM = 'echo_openclaw_wake';
const NODE_START_FALLBACK_MS = 5_000;

const tokenKey = (p: { clientId: string; deviceId: string; role: string }) => `${p.deviceId}:${p.clientId}:${p.role}`;
const tokenStore: GatewayBrowserDeviceTokenStore = {
  async load(p) {
    const all = (await chrome.storage.local.get([TOKENS_KEY]))[TOKENS_KEY] as Record<string, any> | undefined;
    const row = all?.[tokenKey(p)];
    return row && typeof row.token === 'string' ? { token: row.token, scopes: Array.isArray(row.scopes) ? row.scopes : [] } : null;
  },
  async store(p) {
    const all = ((await chrome.storage.local.get([TOKENS_KEY]))[TOKENS_KEY] || {}) as Record<string, any>;
    all[tokenKey(p)] = { token: p.token, scopes: p.scopes };
    await chrome.storage.local.set({ [TOKENS_KEY]: all });
  },
  async clear(p) {
    const all = ((await chrome.storage.local.get([TOKENS_KEY]))[TOKENS_KEY] || {}) as Record<string, any>;
    delete all[tokenKey(p)];
    await chrome.storage.local.set({ [TOKENS_KEY]: all });
  },
};

// --- state ---------------------------------------------------------------------

let connections: GatewayConnection[] = [];
let node: GatewayConnection | null = null;
let operator: GatewayConnection | null = null;
let sessions: SessionManager | null = null;
let toolsPublished = false;
let serverVersion: string | undefined;
let commandApproval: OpenClawStatus['commands'] = { state: 'unknown' };
let approvalTimer: ReturnType<typeof setTimeout> | null = null;
const APPROVAL_POLL_MS = 4_000;
let current: OpenClawSettings = { enabled: false, url: DEFAULT_URL };
const roleState: Record<'node' | 'operator', GatewayState> = { node: { kind: 'stopped' }, operator: { kind: 'stopped' } };
// Set while ECHO itself rewrites the settings (dropping the shared token), so
// that write does not restart the connections it came from.
let ownSettingsWrite = false;

function publishState(role: 'node' | 'operator', next: GatewayState) {
  roleState[role] = next;
  const brief = (s: GatewayState) => s.kind === 'pairing-required' ? `pairing-required:${s.requestId || ''}` : s.kind === 'error' ? `error:${s.code}` : s.kind;
  chrome.storage.session.set({ [STATE_KEY]: { node: brief(roleState.node), operator: brief(roleState.operator), at: Date.now() } }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'ECHO_OPENCLAW_STATUS_CHANGED' }).catch(() => {});
}

async function settings(): Promise<OpenClawSettings> {
  const saved = (await chrome.storage.local.get([SETTINGS_KEY]))[SETTINGS_KEY] as Partial<OpenClawSettings> | undefined;
  return { enabled: saved?.enabled === true, url: typeof saved?.url === 'string' && saved.url ? saved.url : DEFAULT_URL,
    sharedToken: typeof saved?.sharedToken === 'string' && saved.sharedToken ? saved.sharedToken : undefined };
}

/** Once both roles hold device tokens, ECHO no longer needs (or keeps) the gateway's shared token. */
async function forgetSharedTokenWhenPaired() {
  if (!current.sharedToken || roleState.node.kind !== 'connected' || roleState.operator.kind !== 'connected') return;
  const all = (await chrome.storage.local.get([TOKENS_KEY]))[TOKENS_KEY] as Record<string, unknown> | undefined;
  const roles = Object.keys(all || {}).map(k => k.split(':').pop());
  if (!roles.includes('node') || !roles.includes('operator')) return;
  const { sharedToken: _dropped, ...rest } = current;
  current = rest;
  ownSettingsWrite = true;
  await chrome.storage.local.set({ [SETTINGS_KEY]: rest });
}

// --- lifecycle -----------------------------------------------------------------

/**
 * The node's command list needs its own approval on the gateway
 * (`openclaw nodes approve`). Until then agents would see no tools, so
 * avatars stay on the built-in brain; poll until it is approved.
 */
async function checkCommandApproval() {
  if (approvalTimer) { clearTimeout(approvalTimer); approvalTimer = null; }
  if (!operator?.connected || !node?.connected) return;
  try {
    const { deviceId } = await deviceIdentity(indexedDbKeyStore);
    const described: any = await operator.request('node.describe', { nodeId: deviceId });
    const approved = described?.approvalState === 'approved' && !described?.pendingRequestId;
    const next: OpenClawStatus['commands'] = approved ? { state: 'approved' } : { state: 'pending', requestId: described?.pendingRequestId };
    if (next.state !== commandApproval.state || next.requestId !== commandApproval.requestId) {
      commandApproval = next;
      chrome.runtime.sendMessage({ type: 'ECHO_OPENCLAW_STATUS_CHANGED' }).catch(() => {});
    }
    if (!approved) approvalTimer = setTimeout(() => { checkCommandApproval().catch(() => {}); }, APPROVAL_POLL_MS);
  } catch {
    approvalTimer = setTimeout(() => { checkCommandApproval().catch(() => {}); }, APPROVAL_POLL_MS);
  }
}

function stop() {
  if (approvalTimer) { clearTimeout(approvalTimer); approvalTimer = null; }
  commandApproval = { state: 'unknown' };
  for (const conn of connections) conn.stop();
  connections = [];
  node = operator = null;
  sessions = null;
  toolsPublished = false;
  publishState('node', { kind: 'stopped' });
  publishState('operator', { kind: 'stopped' });
}

const localOrSecure = (url: string) => /^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(url) || url.startsWith('wss://');

async function start() {
  stop();
  current = await settings();
  if (!current.enabled) { await chrome.alarms.clear(WAKE_ALARM); return; }
  if (!localOrSecure(current.url)) {
    publishState('operator', { kind: 'error', code: 'INSECURE_URL', message: 'The gateway must be on this computer or use wss://.', willRetry: false });
    return;
  }
  chrome.alarms.create(WAKE_ALARM, { periodInMinutes: 0.5 });
  const identity = () => deviceIdentity(indexedDbKeyStore);
  const version = chrome.runtime.getManifest().version;
  const tools = AVATAR_AGENTS.flatMap(browserToolsFor);

  // The node starts once the operator side has settled: an operator pairing
  // that lands while the node's request is pending replaces that request, and
  // the user would be left approving an id that no longer exists.
  let nodeStarted = false;
  const startNode = () => { if (!nodeStarted && connections.includes(nodeConn)) { nodeStarted = true; nodeConn.start(); } };

  let host: ReturnType<typeof createNodeToolHost> | null = null;
  const nodeConn = createGatewayConnection({
    url: current.url, role: 'node', sharedToken: current.sharedToken, identity, tokenStore,
    client: { id: 'node-host', mode: 'node', version, platform: 'chrome', displayName: 'ECHO (Chrome)' },
    scopes: [], commands: allCommands(),
    onState: s => {
      if (s.kind !== 'connected') toolsPublished = false;
      publishState('node', s);
      forgetSharedTokenWhenPaired().catch(() => {});
    },
    onEvent: event => host?.handleEvent(event),
    onHello: () => {
      // The gateway drops a node's tools when it disconnects: publish on every hello.
      host?.publish().then(() => { toolsPublished = true; }).catch(error => console.warn('[ECHO] Publishing tools failed:', error));
      checkCommandApproval().catch(() => {});
    },
  });
  host = createNodeToolHost(nodeConn, tools);

  const operatorConn = createGatewayConnection({
    url: current.url, role: 'operator', sharedToken: current.sharedToken, identity, tokenStore,
    client: { id: 'webchat-ui', mode: 'webchat', version, platform: 'chrome', displayName: 'ECHO' },
    scopes: ['operator.read', 'operator.write'], caps: ['tool-events'],
    onState: s => {
      publishState('operator', s);
      if (s.kind === 'connected' || s.kind === 'pairing-required') startNode();
      forgetSharedTokenWhenPaired().catch(() => {});
    },
    onEvent: event => sessions?.handleEvent(event),
    onHello: (hello: HelloOk) => {
      serverVersion = (hello as any)?.server?.version;
      sessions?.resume().catch(error => console.warn('[ECHO] Resuming agent runs failed:', error));
      checkCommandApproval().catch(() => {});
    },
    // Any message on either socket keeps the whole worker, and so both sockets, alive.
    keepAlive: { method: 'health', everyMs: KEEPALIVE_MS },
  });

  sessions = createSessionManager(operatorConn, {
    leaseOf: character => { const l = leaseFor(character); return l ? { tabId: l.tabId, leaseId: l.leaseId } : null; },
    say: (character, tabId, text, tier) => sayAs(character, tabId, text, tier),
    setState: (character, tabId, state) => setStateAs(character, tabId, state),
  });
  node = nodeConn;
  operator = operatorConn;
  connections = [nodeConn, operatorConn];
  operatorConn.start();
  // Don't let an unreachable operator side hold the tools back for long.
  setTimeout(startNode, NODE_START_FALLBACK_MS);
}

export function startOpenClaw(): void {
  start().catch(error => console.error('[ECHO] OpenClaw start failed:', error));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(SETTINGS_KEY in changes)) return;
    if (ownSettingsWrite) { ownSettingsWrite = false; return; }
    start().catch(error => console.error('[ECHO] OpenClaw restart failed:', error));
  });
  // An avatar that loses its tab stops its run and forgets where it was looking.
  onLeaseChange(({ agent, lease, previous }) => {
    if (previous && previous.tabId !== lease?.tabId) {
      resetLooking(agent);
      sessions?.abort(agent).catch(() => {});
    }
  });
}

// --- used by the request router --------------------------------------------------

const allReady = () => !!(current.enabled && toolsPublished && commandApproval.state === 'approved'
  && node?.connected && operator?.connected && sessions);

/** Can this avatar run on OpenClaw right now (tools published and approved, both roles connected)? */
export function openClawReadyFor(character: string): boolean {
  return !!avatarByCharacter(character) && allReady();
}

/** Run a message on the avatar's agent; resolves when the run ends or is stopped. */
export async function runOnOpenClaw(character: string, text: string): Promise<void> {
  await leasesReady;
  if (!sessions) throw new Error('OpenClaw is not connected.');
  return sessions.run(character, text);
}

export function abortOpenClaw(character: string): void {
  sessions?.abort(character).catch(() => {});
}

/** Is an avatar's run in flight on the gateway (maybe from before a worker restart)? */
export async function openClawRunPending(character: string): Promise<boolean> {
  if (sessions?.busy(character)) return true;
  const stored = (await chrome.storage.session.get(['echo_openclaw_runs'])).echo_openclaw_runs as Record<string, { character: string }> | undefined;
  return Object.values(stored || {}).some(r => r.character === character);
}

export async function openClawStatus(): Promise<OpenClawStatus> {
  const s = await settings();
  return { enabled: s.enabled, url: s.url, hasToken: !!s.sharedToken, node: roleState.node, operator: roleState.operator,
    serverVersion, testedVersion: TESTED_OPENCLAW, commands: commandApproval, ready: allReady() };
}

export async function saveOpenClawSettings(patch: Partial<OpenClawSettings>): Promise<void> {
  const next = { ...await settings(), ...patch };
  if (!next.sharedToken) delete next.sharedToken;
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
}
