// ECHO's browser tools, offered to OpenClaw agents through the node role.
//
// OpenClaw forwards an agent's tool call as `node.invoke.request`, which
// carries the command and arguments but never the calling session. So every
// avatar gets its own command names (echo.<avatar>.<tool>) and each agent is
// allowed only its own: the gateway's tool policy is what keeps one avatar out
// of another avatar's tab, and the tab is never an argument the model picks.

import type { EventFrame } from '@openclaw/gateway-client/browser';
import type { GatewayConnection } from './connection';

export interface InvokeContext {
  /** Epoch ms after which the gateway has given up: never start a page change after it. */
  deadline: number;
  idempotencyKey?: string;
}

export interface NodeTool {
  /** Model-visible name, unique across this node: `<avatar>_<tool>`. */
  name: string;
  command: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: InvokeContext): Promise<unknown>;
}

type Outcome = { ok: true; payload: unknown } | { ok: false; error: { code: string; message: string } };

const PLUGIN_ID = 'echo';
const REMEMBERED_RESULTS = 200;
const DEFAULT_INVOKE_TIMEOUT_MS = 30_000;
// Answer a little before the gateway stops waiting, so a result never lands
// after the agent was already told the call failed.
const DEADLINE_MARGIN_MS = 2_000;

class ToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function parseArgs(paramsJSON: unknown): Record<string, unknown> {
  if (paramsJSON === undefined || paramsJSON === null || paramsJSON === '') return {};
  let parsed: unknown;
  try { parsed = JSON.parse(String(paramsJSON)); } catch { throw new ToolError('INVALID_ARGS', 'Arguments are not valid JSON.'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ToolError('INVALID_ARGS', 'Arguments must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

export function createNodeToolHost(conn: GatewayConnection, tools: NodeTool[]) {
  const byCommand = new Map(tools.map(tool => [tool.command, tool]));
  // Keyed by the model's tool-call id: a redelivered call gets the first
  // outcome (or joins the one still running) instead of acting twice.
  const outcomes = new Map<string, Promise<Outcome>>();

  async function execute(tool: NodeTool, paramsJSON: unknown, ctx: InvokeContext): Promise<Outcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const args = parseArgs(paramsJSON);
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ToolError('TIMEOUT', 'ECHO ran out of time for this step.')),
          Math.max(0, ctx.deadline - Date.now()));
      });
      return { ok: true, payload: await Promise.race([tool.run(args, ctx), expired]) };
    } catch (error: any) {
      return { ok: false, error: { code: error instanceof ToolError ? error.code : 'TOOL_FAILED',
        message: String(error?.message || error || 'Tool failed').slice(0, 500) } };
    } finally {
      clearTimeout(timer);
    }
  }

  async function handleInvoke(payload: any): Promise<void> {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const nodeId = typeof payload?.nodeId === 'string' ? payload.nodeId : '';
    if (!id || !nodeId) return;
    const tool = byCommand.get(String(payload.command || ''));
    const key = typeof payload.idempotencyKey === 'string' && payload.idempotencyKey ? payload.idempotencyKey : undefined;
    const timeoutMs = Number.isFinite(payload.timeoutMs) && payload.timeoutMs > 0 ? payload.timeoutMs : DEFAULT_INVOKE_TIMEOUT_MS;
    const ctx: InvokeContext = { deadline: Date.now() + timeoutMs - DEADLINE_MARGIN_MS, idempotencyKey: key };

    let outcome: Promise<Outcome>;
    if (!tool) {
      outcome = Promise.resolve({ ok: false, error: { code: 'UNKNOWN_COMMAND', message: `ECHO has no command ${payload.command}.` } });
    } else if (key && outcomes.has(key)) {
      outcome = outcomes.get(key)!;
    } else {
      outcome = execute(tool, payload.paramsJSON, ctx);
      if (key) {
        outcomes.set(key, outcome);
        while (outcomes.size > REMEMBERED_RESULTS) outcomes.delete(outcomes.keys().next().value!);
      }
    }
    const result = await outcome;
    try {
      await conn.request('node.invoke.result', result.ok
        ? { id, nodeId, ok: true, payload: result.payload }
        : { id, nodeId, ok: false, error: result.error });
    } catch (error) {
      // Disconnected mid-call: the gateway times the call out and the agent re-observes.
      console.warn('[ECHO] Could not return a tool result to the gateway:', error);
    }
  }

  return {
    commands: tools.map(tool => tool.command),
    /** The gateway drops a node's tools when it disconnects: call on every hello. */
    publish: () => conn.request('node.pluginTools.update', {
      tools: tools.map(({ name, description, parameters, command }) =>
        ({ pluginId: PLUGIN_ID, name, description, parameters, command })),
    }),
    handleEvent(event: EventFrame) {
      if (event.event === 'node.invoke.request') void handleInvoke(event.payload);
    },
  };
}
