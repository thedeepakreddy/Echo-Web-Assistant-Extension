# ECHO × OpenClaw — local gateway and checks

ECHO connects to its own OpenClaw gateway profile (`echo`), separate from any
other OpenClaw setup on the machine. The extension side lives in
`src/background/openclaw/` and stays off until `echo_openclaw.enabled` is set.

## Gateway (one-time)

```bash
npm install -g --save-exact openclaw@2026.9.6
OC=~/.npm-global/bin/openclaw
$OC --profile echo config set gateway.mode local
$OC --profile echo config set gateway.port 18790 --strict-json
$OC --profile echo config set gateway.bind loopback
$OC --profile echo config set gateway.auth.mode token
$OC --profile echo config set gateway.auth.token "$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
$OC --profile echo config set gateway.controlUi.allowedOrigins '["chrome-extension://ajppdcdcnfnnbjfkkoamikimkefjdhee"]' --strict-json
$OC --profile echo config set discovery.mdns.mode off
$OC --profile echo config set agents.defaults.heartbeat.every 0m
```

Each avatar is an agent that may use only its own tools and never runs commands:

```bash
$OC --profile echo config set gateway.nodes.commands.allow '["echo.analyst.observe","echo.style.observe"]' --strict-json
$OC --profile echo config set agents.entries.echo-analyst '{"identity":{"name":"Echo"},"tools":{"allow":["analyst_observe"],"deny":["exec","write","edit","apply_patch","browser","nodes","cron"],"exec":{"security":"deny"}}}' --strict-json
```

Model — Gemini with your AI Studio key (run it yourself; the key is stored by OpenClaw):

```bash
$OC --profile echo onboard --auth-choice gemini-api-key
$OC --profile echo models list --provider google
$OC --profile echo config set agents.defaults.model '{"primary":"google/<model from the list>"}' --strict-json
```

Run the gateway (`claude` must be on `PATH` for the claude-cli runtime):

```bash
PATH="$HOME/.npm-global/bin:$PATH" ~/.npm-global/bin/openclaw --profile echo gateway run
```

## Pairing

A new ECHO install needs two approvals on the gateway host, in this order:

1. the device — `openclaw --profile echo devices list`, then `devices approve <requestId>`
2. its command list — `openclaw --profile echo nodes pending`, then `nodes approve <requestId>`

The operator role pairs automatically when ECHO presents the gateway's shared
token over loopback. Adding avatar commands later asks for step 2 again, so
declare every avatar's commands up front.

## Checks

| Command | What it proves |
| --- | --- |
| `npm test` | tool host dedupes redelivered calls, rejects bad input, answers before the deadline; device identity signs correctly |
| `npm run openclaw:probe` | origin + device signature accepted, pairing, per-avatar tool isolation, tool round trip (no model) |
| `npm run openclaw:e2e -- --approve [--agent-run]` | the built extension in headless Chrome for Testing: pairing, reading a real tab, isolation, idle survival, worker-restart recovery; `--agent-run` adds a real model turn that must report a code planted in the page |
| `node tools/openclaw/agent-reconnect.cjs` | real model turns keep calling ECHO's tools after the operator connection is replaced |

The probe and e2e keep a test identity in `tools/openclaw/.probe-state/`
(gitignored). The e2e removes the throwaway device it pairs.

## Known issues (OpenClaw 2026.9.6)

- **claude-cli runtime and reconnects.** The warm Claude Code process stays
  bound to the operator connection that started it. After that connection
  closes, every tool call fails with *"Gateway client authority closed before
  dispatching node.invoke"* until the gateway restarts. ECHO's connection is
  replaced whenever Chrome restarts its service worker, so use an API-key
  provider (Gemini, Anthropic) for agents; claude-cli is for quick local tests
  on a freshly started gateway.
- When that tool call failed, the model answered from its memory of an earlier
  run (a stale code). ECHO must never present facts that no tool returned in
  the current run — see the harness plan (grounded answers, "unverified" badge).
- The gateway ticks every 30 s, which equals Chrome's service-worker idle
  limit; ECHO sends a `health` request every 20 s and keeps a 30 s wake alarm.

## Extension id

`manifest.json` carries a public key, so every build has the id
`ajppdcdcnfnnbjfkkoamikimkefjdhee`. The matching private key (needed only to
pack a `.crx` yourself) is at `~/.echo/echo-extension-key.pem` and must never be
committed. A Chrome Web Store listing gets its own key; put the store's public
key in `manifest.json` then, and update `allowedOrigins`.
