// One authenticated WebSocket to ECHO's OpenClaw gateway, in one role.
//
// ECHO holds two: a "node" connection that offers the browser tools, and an
// "operator" connection that starts and follows agent runs. The official
// @openclaw/gateway-client owns the handshake, reconnect backoff and request
// correlation; this file supplies only what the host owns: the socket, the
// device identity, where issued device tokens live, and what pairing means
// for the UI.

import {
  GatewayBrowserDeviceAuthLifecycle, GatewayProtocolClient, GatewayProtocolRequestError,
  ConnectErrorDetailCodes, DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS, PROTOCOL_VERSION,
  isRetryableGatewayStartupUnavailableError, readConnectErrorDetailCode,
  readPairingConnectErrorDetails, resolveGatewayStartupRetryAfterMs, shouldPauseGatewayReconnect,
  type ConnectParams, type EventFrame, type HelloOk,
  type GatewayBrowserDeviceAuthPlan, type GatewayBrowserDeviceIdentity,
  type GatewayBrowserDeviceTokenStore, type GatewayProtocolSocket, type GatewayProtocolSocketHandlers,
} from '@openclaw/gateway-client/browser';

export type GatewayState =
  | { kind: 'connecting' }
  | { kind: 'connected'; hello: HelloOk }
  /** Waiting for `openclaw devices approve <requestId>` on the gateway host. */
  | { kind: 'pairing-required'; requestId?: string; message: string }
  | { kind: 'error'; code: string; message: string; willRetry: boolean }
  | { kind: 'stopped' };

export interface GatewayConnectionOptions {
  url: string;
  role: 'operator' | 'node';
  client: ConnectParams['client'];
  scopes: string[];
  caps?: string[];
  /** Node role only: every command this node may be invoked with. */
  commands?: string[];
  /** Shared gateway token. Only sent until pairing has issued a device token. */
  sharedToken?: string;
  identity: () => Promise<GatewayBrowserDeviceIdentity>;
  tokenStore: GatewayBrowserDeviceTokenStore;
  /** Tests supply a socket with an Origin header; the extension uses the platform one. */
  createWebSocket?: (url: string) => WebSocket;
  onState?: (state: GatewayState) => void;
  onEvent?: (event: EventFrame) => void;
  onHello?: (hello: HelloOk) => void;
  /**
   * Send this read-only request on a timer while connected. Chrome stops an
   * extension service worker after 30 s without activity, and the gateway may
   * tick only every 30 s, so ECHO must speak first to keep its sockets alive.
   */
  keepAlive?: { method: string; everyMs: number };
}

export interface GatewayConnection {
  start(): void;
  stop(): void;
  readonly connected: boolean;
  request<T = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
}

interface Plan { auth: GatewayBrowserDeviceAuthPlan; params: ConnectParams }

// Retry cadence while a pairing request waits for the user to approve it.
const PAIRING_RETRY_MS = 4000;
const CONNECT_FAILED_CLOSE = 4001;
const TICK_TIMEOUT_CLOSE = 4000;

/** Browsers only accept 1000 and 3000–4999 from script. */
const browserCloseCode = (code?: number) =>
  code === undefined || code === 1000 || (code >= 3000 && code <= 4999) ? code : code === 1008 ? 4008 : 4000;

function createSocket(url: string, handlers: GatewayProtocolSocketHandlers,
  make: (url: string) => WebSocket, maxPayload: () => number | undefined): GatewayProtocolSocket {
  const socket = make(url);
  let opening = true;
  // The protocol's challenge timer only starts at `open`; bound the opening too.
  const openTimer = setTimeout(() => {
    if (!opening) return;
    opening = false;
    handlers.error(new Error(`gateway websocket opening timed out after ${DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS}ms`));
    socket.close();
  }, DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
  const opened = () => { opening = false; clearTimeout(openTimer); };
  socket.addEventListener('open', () => { opened(); handlers.open(); });
  socket.addEventListener('message', event => handlers.message(String(event.data ?? '')));
  socket.addEventListener('close', event => { opened(); handlers.close(event.code, event.reason || ''); });
  socket.addEventListener('error', () => { opened(); handlers.error(new Error('websocket error')); });
  return {
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send: data => {
      const limit = maxPayload();
      if (limit !== undefined && new TextEncoder().encode(data).byteLength > limit) {
        throw new Error('Request exceeds the gateway payload limit.');
      }
      socket.send(data);
    },
    close: (code, reason) => { opened(); socket.close(browserCloseCode(code), reason); },
  };
}

export function createGatewayConnection(opts: GatewayConnectionOptions): GatewayConnection {
  const lifecycle = new GatewayBrowserDeviceAuthLifecycle({ loadIdentity: opts.identity, tokenStore: opts.tokenStore });
  const makeSocket = opts.createWebSocket ?? (url => new WebSocket(url));
  let maxPayload: number | undefined;
  let lastInbound = 0;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  const emit = (state: GatewayState) => { try { opts.onState?.(state); } catch (e) { console.error('[ECHO] gateway state handler', e); } };

  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  const stopTickWatch = () => {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
  };
  // A half-open socket never closes by itself; the gateway ticks every
  // tickIntervalMs, so two missed ticks mean the link is dead.
  const startTickWatch = (hello: HelloOk) => {
    stopTickWatch();
    const interval = Math.max(1000, Number(hello.policy?.tickIntervalMs) || 30_000);
    lastInbound = Date.now();
    tickTimer = setInterval(() => {
      if (Date.now() - lastInbound > interval * 2) client.closeSocket(TICK_TIMEOUT_CLOSE, 'tick timeout');
    }, interval);
    const keepAlive = opts.keepAlive;
    if (keepAlive) {
      keepAliveTimer = setInterval(() => {
        if (client.connected) client.request(keepAlive.method, {}, { timeoutMs: keepAlive.everyMs }).catch(() => { /* tick watch handles a dead link */ });
      }, keepAlive.everyMs);
    }
  };

  const client: GatewayProtocolClient<Plan> = new GatewayProtocolClient<Plan>({
    createSocket: handlers => createSocket(opts.url, handlers, makeSocket, () => maxPayload),
    createRequestId: () => crypto.randomUUID(),
    buildConnectPlan: async ({ nonce, challengeTs }) => {
      const identity = await opts.identity();
      const stored = await opts.tokenStore.load({ clientId: opts.client.id, deviceId: identity.deviceId, role: opts.role });
      const auth = await lifecycle.buildPlan({
        client: opts.client, role: opts.role, defaultScopes: opts.scopes,
        // Once paired, the device token alone authenticates this device.
        token: stored ? undefined : opts.sharedToken,
        nonce, challengeTs,
      });
      const params: ConnectParams = {
        minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION,
        client: opts.client, role: opts.role, scopes: auth.scopes,
        caps: opts.caps ?? [],
        ...(opts.role === 'node' ? { commands: opts.commands ?? [] } : {}),
        auth: auth.auth, device: auth.device,
        locale: typeof navigator !== 'undefined' ? navigator.language : 'en-US',
      } as ConnectParams;
      return { auth, params };
    },
    buildConnectParams: plan => plan.params,
    onConnectHello: async (hello, context) => {
      await lifecycle.acceptHello(hello, context.plan.auth);
      maxPayload = hello.policy?.maxPayload;
      startTickWatch(hello);
      emit({ kind: 'connected', hello });
      opts.onHello?.(hello);
    },
    onConnectFailure: async (error, context) => {
      const code = readConnectErrorDetailCode(error.details);
      if (code === ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH && context.plan.auth.selectedAuth.usingStoredDeviceToken) {
        // Revoked or rotated elsewhere: forget it so the next try re-pairs.
        await lifecycle.clearStoredToken(context.plan.auth);
      }
      if (code === ConnectErrorDetailCodes.PAIRING_REQUIRED) {
        const pairing = readPairingConnectErrorDetails(error.details);
        emit({ kind: 'pairing-required', requestId: pairing?.requestId, message: error.message });
        return { closeCode: CONNECT_FAILED_CLOSE, closeReason: 'pairing required', reconnectDelayMs: PAIRING_RETRY_MS };
      }
      if (isRetryableGatewayStartupUnavailableError(error)) {
        return { closeCode: CONNECT_FAILED_CLOSE, closeReason: 'gateway starting',
          reconnectDelayMs: resolveGatewayStartupRetryAfterMs(error) ?? undefined };
      }
      return { closeCode: CONNECT_FAILED_CLOSE, closeReason: 'connect failed' };
    },
    resolveClose: context => {
      const failure = context.connectFailure;
      if (failure?.reconnectDelayMs !== undefined) {
        return { retry: true, notify: true, reconnectDelayMs: failure.reconnectDelayMs, pendingError: failure.error };
      }
      const details = failure?.error instanceof GatewayProtocolRequestError ? failure.error.details : undefined;
      const retry = !shouldPauseGatewayReconnect({ details, protocolMismatchIsTerminal: true });
      return { retry, notify: true, pendingError: failure?.error };
    },
    onClose: (context, decision) => {
      stopTickWatch();
      const error = context.connectFailure?.error;
      if (readConnectErrorDetailCode(error instanceof GatewayProtocolRequestError ? error.details : undefined)
        === ConnectErrorDetailCodes.PAIRING_REQUIRED) return;   // already reported
      emit(error
        ? { kind: 'error', code: error instanceof GatewayProtocolRequestError ? (readConnectErrorDetailCode(error.details) || error.code) : 'SOCKET',
            message: error.message, willRetry: decision.retry }
        : { kind: 'error', code: 'CLOSED', message: context.reason || `closed (${context.code})`, willRetry: decision.retry });
    },
    onEvent: event => { try { opts.onEvent?.(event); } catch (e) { console.error('[ECHO] gateway event handler', e); } },
    onActivity: () => { lastInbound = Date.now(); },
    onCallbackError: (label, error) => console.error(`[ECHO] gateway ${label} handler error:`, error),
    handshake: { mode: 'require-challenge', timeoutMs: DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS },
    reconnect: { initialMs: 1000, multiplier: 1.7, maxMs: 30_000 },
  });

  return {
    start: () => { emit({ kind: 'connecting' }); client.start(); },
    stop: () => { stopTickWatch(); client.stop(); emit({ kind: 'stopped' }); },
    get connected() { return client.connected; },
    request: (method, params, requestOpts) => client.request(method, params, requestOpts),
  };
}
