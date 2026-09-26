// Avatar runs on the OpenClaw gateway, from ECHO's operator connection.
//
// A message to an avatar becomes one agent run in that avatar's session
// (agent:<agentId>:lease-<leaseId>, one per tab assignment). Events drive the
// progress shown on the orb and in the panel; the result comes from
// `agent.wait`, which returns the final reply even when events were missed
// while ECHO's worker restarted or its socket reconnected. Runs in flight are
// kept in session storage so a new worker picks them up.

import type { EventFrame } from '@openclaw/gateway-client/browser';
import type { GatewayConnection } from './connection';
import { avatarByCharacter } from './registry';

export interface SessionHost {
  /** The tab an avatar is assigned right now, and the lease id that names its session. */
  leaseOf(character: string): { tabId: number; leaseId: string } | null;
  say(character: string, tabId: number | undefined, text: string, tier?: number): void;
  setState(character: string, tabId: number | undefined, state: string): void;
}

interface Run {
  character: string;
  sessionKey: string;
  agentId: string;
  tabId: number;
  runId?: string;
  startedAt: number;
  seq: number;
  finished: boolean;
  resolve: () => void;
  done: Promise<void>;
}

type StoredRun = Pick<Run, 'character' | 'sessionKey' | 'agentId' | 'tabId' | 'runId' | 'startedAt'>;

const STORE_KEY = 'echo_openclaw_runs';
// agent.wait holds the request open this long each round; the loop keeps
// waiting until the run ends.
const WAIT_ROUND_MS = 25_000;
const PHASES: Record<string, string> = {
  preparing_context: 'Getting ready…', starting_model: 'Thinking…', memory_flushing: 'Tidying memory…',
};

/** The text of an assistant message: a string, or its text parts. */
export function messageText(message: any): string {
  if (!message) return '';
  if (typeof message === 'string') return message;
  const content = message.content ?? message.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n').trim();
  return '';
}

/** "mcp__openclaw__analyst_observe" → "observe". */
export function toolLabel(name: unknown): string {
  const bare = String(name || '').replace(/^mcp__[^_]+__/, '');
  return bare.includes('_') ? bare.slice(bare.indexOf('_') + 1) : bare;
}

export function createSessionManager(conn: GatewayConnection, host: SessionHost) {
  const runs = new Map<string, Run>();          // by session key
  const created = new Set<string>();            // sessions known to exist

  const persist = () => {
    const stored: Record<string, StoredRun> = {};
    for (const [key, r] of runs) {
      if (!r.finished) stored[key] = { character: r.character, sessionKey: r.sessionKey, agentId: r.agentId, tabId: r.tabId, runId: r.runId, startedAt: r.startedAt };
    }
    chrome.storage.session.set({ [STORE_KEY]: stored }).catch(() => {});
  };

  function track(stored: StoredRun): Run {
    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    const run: Run = { ...stored, seq: -1, finished: false, resolve, done };
    runs.set(run.sessionKey, run);
    return run;
  }

  function finish(run: Run, reply?: { text: string; tier?: number }) {
    if (run.finished) return;
    run.finished = true;
    if (runs.get(run.sessionKey) === run) runs.delete(run.sessionKey);
    persist();
    if (reply?.text) host.say(run.character, run.tabId, reply.text, reply.tier ?? 3);
    host.setState(run.character, run.tabId, 'Idle');
    run.resolve();
  }

  /** Wait for the run's end with agent.wait, round after round, until it ends or is stopped. */
  async function awaitEnd(run: Run) {
    while (!run.finished && run.runId) {
      let result: any;
      try {
        result = await conn.request('agent.wait', { runId: run.runId, timeoutMs: WAIT_ROUND_MS }, { timeoutMs: WAIT_ROUND_MS + 10_000 });
      } catch {
        if (!conn.connected) return;          // resumed on the next hello
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      if (run.finished) return;
      if (result?.status === 'ok') {
        finish(run, { text: messageText(result.terminalReply) || 'Done.' });
      } else if (result?.status === 'error') {
        const why = result.error?.message || result.errorMessage || result.stopReason || 'the agent stopped';
        finish(run, { text: result.stopReason === 'superseded' ? '' : `I couldn't finish that: ${why}.`, tier: 0 });
      } else if (result?.endedAt && result?.status && result.status !== 'pending' && result.status !== 'timeout') {
        finish(run, { text: messageText(result.terminalReply) });
      }
    }
  }

  async function ensureSession(key: string, agentId: string) {
    if (created.has(key)) return;
    await conn.request('sessions.create', { key, agentId, idempotencyKey: key });
    created.add(key);
  }

  return {
    /** Is an avatar's run in flight (possibly started by an earlier worker)? */
    busy(character: string): boolean {
      return [...runs.values()].some(r => r.character === character && !r.finished);
    },

    /** Send a message to an avatar's agent; resolves when the run ends or is stopped. */
    async run(character: string, text: string): Promise<void> {
      const avatar = avatarByCharacter(character);
      const lease = host.leaseOf(character);
      if (!avatar || !lease) throw new Error('This avatar has no tab.');
      const sessionKey = `agent:${avatar.agentId}:lease-${lease.leaseId}`;
      const previous = runs.get(sessionKey);
      if (previous) await this.abort(character);
      await ensureSession(sessionKey, avatar.agentId);
      const run = track({ character, sessionKey, agentId: avatar.agentId, tabId: lease.tabId, startedAt: Date.now() });
      host.setState(character, lease.tabId, 'Thinking…');
      try {
        const sent: any = await conn.request('chat.send', { sessionKey, agentId: avatar.agentId, message: text, idempotencyKey: crypto.randomUUID() });
        if (!sent?.runId) throw new Error('The gateway did not start a run.');
        run.runId = sent.runId;
        persist();
      } catch (error) {
        finish(run);
        throw error;
      }
      awaitEnd(run);
      return run.done;
    },

    /** Stop an avatar's run here and on the gateway. */
    async abort(character: string): Promise<void> {
      const run = [...runs.values()].find(r => r.character === character && !r.finished);
      if (!run) return;
      finish(run);
      await conn.request('sessions.abort', { key: run.sessionKey, ...(run.runId ? { runId: run.runId } : {}) }).catch(() => {});
    },

    /** Progress from chat and agent events; the end itself comes from agent.wait. */
    handleEvent(event: EventFrame) {
      const p: any = event.payload;
      const run = p?.sessionKey ? runs.get(p.sessionKey) : undefined;
      if (!run || run.finished || (run.runId && p.runId && p.runId !== run.runId)) return;
      if (event.event === 'chat') {
        if (typeof p.seq === 'number') { if (p.seq <= run.seq) return; run.seq = p.seq; }
        if (p.state === 'status') host.setState(run.character, run.tabId, PHASES[p.phase] || 'Working…');
        else if (p.state === 'delta') host.setState(run.character, run.tabId, 'Writing…');
        else if (p.state === 'final') finish(run, { text: messageText(p.message) || 'Done.' });
        else if (p.state === 'aborted') finish(run);
        else if (p.state === 'error') finish(run, { text: `I couldn't finish that: ${p.errorMessage || p.errorKind || 'the agent stopped'}.`, tier: 0 });
      } else if (event.event === 'agent' && p.stream === 'tool' && p.data?.phase === 'start') {
        host.setState(run.character, run.tabId, `Using ${toolLabel(p.data.name)}…`);
      }
    },

    /** After (re)connecting: pick up runs this or an earlier worker left in flight. */
    async resume(): Promise<void> {
      const stored = ((await chrome.storage.session.get([STORE_KEY]))[STORE_KEY] || {}) as Record<string, StoredRun>;
      for (const s of Object.values(stored)) if (!runs.has(s.sessionKey) && s.runId) track(s);
      for (const run of runs.values()) {
        created.add(run.sessionKey);
        if (!run.finished && run.runId) awaitEnd(run);
      }
    },
  };
}

export type SessionManager = ReturnType<typeof createSessionManager>;
