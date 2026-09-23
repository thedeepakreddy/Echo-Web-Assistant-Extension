import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '../..');
const screenshots = path.join(root, 'docs/screenshots');
const media = path.join(root, 'docs/media');
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
fs.mkdirSync(screenshots, { recursive: true });
fs.mkdirSync(media, { recursive: true });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (fn, timeout = 15_000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const value = await fn(); if (value) return value; } catch { /* retry */ }
    await delay(100);
  }
  throw new Error(`Timed out after ${timeout}ms`);
};

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
    });
  }
  async send(method, params = {}, sessionId) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { this.ws.close(); }
}

async function startChrome() {
  if (process.env.ECHO_DOCS_CDP) return { base: process.env.ECHO_DOCS_CDP, child: null, profile: null };
  if (!fs.existsSync(chromePath)) throw new Error(`Google Chrome not found at ${chromePath}`);
  const port = 9334;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-docs-chrome-'));
  const child = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${base}/json/version`)).ok, 20_000);
  return { base, child, profile };
}

async function attach(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  return sessionId;
}

async function page(cdp, url, width, height) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const session = await attach(cdp, targetId);
  await cdp.send('Page.enable', {}, session);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height,
  }, session);
  await delay(900);
  await evaluate(cdp, session, 'document.fonts?.ready', true).catch(() => {});
  return { targetId, session, width, height };
}

async function evaluate(cdp, session, expression, awaitPromise = false) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true, userGesture: true,
  }, session);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Evaluation failed');
  return result.result?.value;
}

async function capture(cdp, p, filename, clipY = 0, clipHeight = p.height) {
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: true,
    clip: { x: 0, y: clipY, width: p.width, height: clipHeight, scale: 1 },
  }, p.session);
  fs.writeFileSync(path.join(screenshots, filename), Buffer.from(result.data, 'base64'));
}

async function captureViewport(cdp, p, filename, scrollY = 0) {
  await evaluate(cdp, p.session, `window.scrollTo(0, ${Math.max(0, Math.floor(scrollY))})`);
  await delay(180);
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, p.session);
  fs.writeFileSync(path.join(screenshots, filename), Buffer.from(result.data, 'base64'));
}

async function closePage(cdp, p) {
  await cdp.send('Target.closeTarget', { targetId: p.targetId }).catch(() => {});
}

async function captureOptions(cdp, buildUrl) {
  const p = await page(cdp, `${buildUrl}/options.html`, 480, 900);
  await delay(1100);
  await captureViewport(cdp, p, 'settings-appearance-and-provider.png');
  const sections = await evaluate(cdp, p.session, `Array.from(document.querySelectorAll('.group-section')).map(s => ({title:s.querySelector('h3')?.textContent||'', y:s.getBoundingClientRect().top+scrollY}))`);
  const y = title => Math.max(0, Math.floor((sections.find(s => s.title.startsWith(title))?.y || 0) - 16));
  await captureViewport(cdp, p, 'settings-provider-and-local-brain.png', y('AI Provider'));
  await captureViewport(cdp, p, 'settings-local-voice-personalization.png', y('Local Brain'));
  await captureViewport(cdp, p, 'settings-memory-skills-privacy.png', y('Memories'));
  await captureViewport(cdp, p, 'settings-privacy-and-data-controls.png', y('Privacy'));
  await captureViewport(cdp, p, 'settings-private-diagnostics-shortcuts.png', y('Private Agent Browsing'));
  await closePage(cdp, p);
}

async function capturePanel(cdp, buildUrl) {
  const p = await page(cdp, `${buildUrl}/sidepanel.html`, 440, 900);
  await delay(900);
  await capture(cdp, p, 'side-panel-home.png');
  const runtimeMessage = message => evaluate(cdp, p.session, `window.__echoDocsSend(${JSON.stringify(message)})`);
  await runtimeMessage({ type: 'ECHO_USER_ECHO', text: 'Summarize this page and give me the three key ideas.' });
  await runtimeMessage({ type: 'ECHO_SAY', text: 'This guide explains how to build a calmer browser workflow with local-first assistance.', tier: 0 });
  await runtimeMessage({ type: 'ECHO_USER_ECHO', text: 'What changed in browser AI this week?' });
  await runtimeMessage({ type: 'ECHO_SAY', text: 'I found three relevant updates and attached the sources below. [1] [2]', tier: 3,
    sources: [{ title: 'Chrome AI documentation', url: 'https://developer.chrome.com/docs/ai' }, { title: 'Web platform updates', url: 'https://web.dev/blog/' }] });
  await runtimeMessage({ type: 'ECHO_USAGE', steps: 2, taskTokens: 1260, sessionTokens: 4380 });
  await delay(500);
  await capture(cdp, p, 'side-panel-conversation.png');
  await evaluate(cdp, p.session, `document.querySelector('button[aria-label="Chat history"]')?.click()`);
  await delay(500);
  await capture(cdp, p, 'side-panel-history.png');
  await closePage(cdp, p);
}

async function captureInPage(cdp, buildUrl) {
  const p = await page(cdp, `${buildUrl}/content.html`, 1440, 900);
  await delay(1600);
  const send = message => evaluate(cdp, p.session, `window.__echoDocsSend(${JSON.stringify(message)})`);
  await send({ type: 'ECHO_PREFS_UPDATED', avatar: 'echo', handsfree: false, language: 'en-US' });
  await send({ type: 'ECHO_GLOBAL_WAKE', state: true });
  await send({ type: 'ECHO_OPEN_PALETTE' });
  await send({ type: 'ECHO_STATE', state: 'Thinking...' });
  await delay(650);
  await capture(cdp, p, 'in-page-command-bar.png');

  await send({ type: 'ECHO_GLOBAL_WAKE', state: false });
  await evaluate(cdp, p.session, `window.postMessage({source:'echo-observer',type:'ECHO_LOCAL_SUGGEST',text:'This looks like a long article. Want a summary?',action:'summarize this page'}, '*')`);
  await delay(500);
  await capture(cdp, p, 'in-page-proactive-suggestion.png');
  await evaluate(cdp, p.session, `document.querySelector('.echo-suggest-no')?.click()`);

  await send({ type: 'ECHO_WRITER_SHOW', requestId: 'docs', title: 'Make concise', state: 'done', text: 'ECHO rewrote the selected text into a clear, concise sentence.', canReplace: true });
  await delay(450);
  await capture(cdp, p, 'in-page-writer.png');
  await closePage(cdp, p);
}

async function recordShowcase(cdp) {
  const showcasePath = path.join(os.tmpdir(), 'echo-docs-showcase/index.html');
  const p = await page(cdp, `file://${showcasePath}`, 1920, 1080);
  await delay(800);
  const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-avatar-frames-'));
  const fps = 10;
  const durationSeconds = 11;
  for (let i = 0; i < fps * durationSeconds; i++) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 88, fromSurface: true }, p.session);
    fs.writeFileSync(path.join(frameDir, `frame-${String(i).padStart(4, '0')}.jpg`), Buffer.from(shot.data, 'base64'));
    await delay(100);
  }
  await closePage(cdp, p);

  const mp4 = path.join(media, 'echo-avatar-expressions.mp4');
  const poster = path.join(media, 'echo-avatar-expressions-poster.jpg');
  const gif = path.join(media, 'echo-avatar-expressions.gif');
  const input = path.join(frameDir, 'frame-%04d.jpg');
  const encode = spawnSync('ffmpeg', ['-y', '-framerate', String(fps), '-i', input, '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: 'inherit' });
  if (encode.status !== 0) throw new Error('ffmpeg could not encode the MP4');
  const posterResult = spawnSync('ffmpeg', ['-y', '-i', mp4, '-vf', 'select=eq(n\\,35)', '-frames:v', '1', poster], { stdio: 'inherit' });
  if (posterResult.status !== 0) throw new Error('ffmpeg could not create the poster');
  const gifResult = spawnSync('ffmpeg', ['-y', '-i', mp4, '-vf', 'fps=8,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3', '-loop', '0', gif], { stdio: 'inherit' });
  if (gifResult.status !== 0) throw new Error('ffmpeg could not create the GIF preview');
  if (frameDir.startsWith(`${os.tmpdir()}${path.sep}echo-avatar-frames-`)) fs.rmSync(frameDir, { recursive: true, force: true });
}

let chrome;
let cdp;
try {
  chrome = await startChrome();
  const version = await (await fetch(`${chrome.base}/json/version`)).json();
  cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.ready;
  const buildUrl = `file://${path.join(os.tmpdir(), 'echo-docs-showcase')}`;
  await captureOptions(cdp, buildUrl);
  await capturePanel(cdp, buildUrl);
  await captureInPage(cdp, buildUrl);
  if (!process.env.ECHO_DOCS_SKIP_VIDEO) await recordShowcase(cdp);
  console.log(`Captured documentation media in ${path.join(root, 'docs')}`);
} finally {
  if (cdp) cdp.close();
  if (chrome?.child) chrome.child.kill('SIGTERM');
  if (chrome?.profile?.startsWith(`${os.tmpdir()}${path.sep}echo-docs-chrome-`)) fs.rmSync(chrome.profile, { recursive: true, force: true });
}
