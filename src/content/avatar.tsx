import React, { useEffect, useRef } from 'react';
import { Character, characterAsset } from '../characters';

// ECHO's character: layered images built by tools/avatar/build_avatar.py.
// One rAF loop drives everything by writing styles straight to the DOM, so
// React never re-renders per frame. Every animation is read against the
// clock, so a slow or throttled frame rate can't leave her stuck mid-blink.

type Status = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

/** Cues the speech code sends while ECHO talks. */
export interface AvatarCues {
  /** Speech audio for `text` has started. */
  speak: (text: string) => void;
  /** The voice reached the word starting at `charIndex` (not every voice reports this). */
  word: (charIndex: number) => void;
  /** Something funny: laugh for a couple of seconds, with tears. */
  laugh: () => void;
}

interface Props {
  /** Which character to draw. Remount (change `key`) to switch characters. */
  character: Character;
  status: Status;
  /** True while speech audio is actually playing. */
  talking: boolean;
  cueRef: React.MutableRefObject<AvatarCues | null>;
  onClick: (e: React.MouseEvent) => void;
  onPointerDown: (e: React.PointerEvent) => void;
}

// Mouth shapes every character provides, in the order their images are
// stacked (the build script's VISEMES). REST (-1) is the closed smile.
const MOUTHS = ['c', 'e', 'a1', 'a2', 'o', 'u'] as const;
const REST = -1;
const [C, E, A1, A2, O, U] = [0, 1, 2, 3, 4, 5];
const MOUTH_BLEND_MS = 55;          // crossfade between mouth shapes
const LAUGH_MS = 2200;
const TEARS_AFTER_MS = 1400;        // tears keep rolling a little after the laugh
const CHARS_PER_SEC = 15;           // starting guess at speaking rate; corrected by word events
const LAUGH_WORD = /^(ha(ha)+h?|he(he)+|lol|lmao)\b/i;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
// Frame-rate independent easing toward a target.
const ease = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

interface Script {
  /** Mouth shape per character. */
  shape: number[];
  /** Cumulative speaking time before each character, in "character units". */
  at: number[];
  /** Character indexes where a laughing word starts. */
  laughs: Set<number>;
}

/**
 * Turn reply text into a lip-sync script: each letter gets a mouth shape and
 * a duration (vowels are held longer; lips close on m/b/p; punctuation pauses).
 */
export function toScript(text: string): Script {
  const shape: number[] = [];
  const at: number[] = [];
  const laughs = new Set<number>();
  let t = 0;
  let vowelFlip = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const lower = ch.toLowerCase();
    let s = C, w = 0.85;
    if (lower === 'a') { s = (vowelFlip = !vowelFlip) ? A2 : A1; w = 1.3; }
    else if ('eiy'.includes(lower)) { s = E; w = 1.15; }
    else if (lower === 'o') { s = O; w = 1.3; }
    else if ('uw'.includes(lower)) { s = U; w = 1.1; }
    else if ('mbp'.includes(lower)) { s = REST; w = 0.9; }
    else if (/[a-z]/i.test(ch)) { s = C; w = 0.85; }
    else if (/[0-9]/.test(ch)) { s = A1; w = 2.2; }              // digits are spoken as whole words
    else if (ch === ' ') { s = C; w = 0.4; }
    else if (/[,;:—–]/.test(ch)) { s = REST; w = 3.5; }
    else if (/[.!?\n]/.test(ch)) { s = REST; w = 5.5; }
    else if (/\p{L}/u.test(ch)) { s = A1; w = 1; }               // other scripts: a generic open shape
    else { s = REST; w = 0; }                                     // emoji and symbols aren't spoken
    if (/\S/.test(ch) && (i === 0 || /\s/.test(text[i - 1])) && LAUGH_WORD.test(text.slice(i))) laughs.add(i);
    at.push(t);
    shape.push(s);
    t += w;
  }
  at.push(t);
  return { shape, at, laughs };
}

export function EchoAvatar({ character, status, talking, cueRef, onClick, onPointerDown }: Props) {
  const { layout } = character;
  const blinkSteps = layout.blinkSteps;
  const asset = (name: string) => characterAsset(character.id, name);
  const rootRef = useRef<HTMLDivElement>(null);
  const torsoRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const irisRef = useRef<HTMLImageElement>(null);
  const blinkRefs = useRef<(HTMLImageElement | null)[]>([]);
  const mouthRefs = useRef<(HTMLImageElement | null)[]>([]);
  const statusRef = useRef(status);
  const talkingRef = useRef(talking);
  statusRef.current = status;
  talkingRef.current = talking;

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let cursor: { x: number; y: number } | null = null;
    const onMove = (e: PointerEvent) => { cursor = { x: e.clientX, y: e.clientY }; };
    const onLeave = (e: MouseEvent) => { if (!e.relatedTarget) cursor = null; };
    window.addEventListener('pointermove', onMove, { passive: true, capture: true });
    document.addEventListener('mouseout', onLeave, { passive: true });

    // ---- lip-sync state ----
    let script: Script | null = null;
    let pos = 0;                       // how far into the script we are, in character units
    let rate = CHARS_PER_SEC;
    let speakStart = 0;
    let lastChar = -1;
    let mouth = REST;                  // shape being shown
    let prevMouth = REST;              // shape fading out
    let mouthChangedAt = 0;
    let freeUntil = 0;                 // when talking past the end of the script
    let nod = 0;                       // decaying head-nod impulse, 0..1
    let laughStart = -1e9;             // long ago (not -Infinity: the shake maths would give NaN)

    const setMouth = (s: number, now: number) => {
      if (s === mouth) return;
      prevMouth = mouth;
      mouth = s;
      mouthChangedAt = now;
      if (s === A2 || s === O) nod = Math.min(nod + 0.25, 1);
    };

    cueRef.current = {
      speak: (text: string) => {
        script = toScript(text);
        pos = 0;
        lastChar = -1;
        speakStart = performance.now();
      },
      word: (charIndex: number) => {
        if (!script || charIndex >= script.shape.length) return;
        const target = script.at[charIndex];
        const elapsed = (performance.now() - speakStart) / 1000;
        // Learn this voice's real speed from where it actually is.
        if (charIndex > 12 && elapsed > 0.4) rate = clamp(rate * 0.6 + (target / elapsed) * 0.4, 8, 30);
        pos = target;
      },
      laugh: () => {
        const now = performance.now();
        // Don't restart a laugh that is already going.
        if (now - laughStart > LAUGH_MS * 0.6) laughStart = now;
      },
    };

    // ---- blinking ----
    // Close fast, hold, open slower — the shape of a real blink.
    const blinkAmount = (ms: number) => {
      if (ms < 0) return 0;
      if (ms < 70) return (ms / 70) ** 2;
      if (ms < 110) return 1;
      if (ms < 260) return 1 - ((ms - 110) / 150) * (2 - (ms - 110) / 150);
      return 0;
    };
    let blinkStart = -1e9;
    let doubleBlink = false;
    let nextBlinkAt = performance.now() + rand(1500, 4000);
    const startBlink = (now: number) => {
      blinkStart = now;
      doubleBlink = Math.random() < 0.15;
      nextBlinkAt = now + (statusRef.current === 'thinking' ? rand(4000, 8000) : rand(2500, 6000));
    };

    const cur = { hx: 0, hy: 0, ex: 0, ey: 0, energy: 0, tilt: 0, laugh: 0 };
    let lastTx = 0, lastTy = 0;
    let last = performance.now();
    let raf = 0;
    const applied = new Map<HTMLElement, string>();
    const setStyle = (el: HTMLElement | null | undefined, css: string) => {
      if (!el || applied.get(el) === css) return;
      applied.set(el, css);
      el.style.cssText = css;
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const root = rootRef.current;
      if (!root) return;
      const st = statusRef.current;
      const t = now / 1000;
      const sinceLaugh = now - laughStart;
      const laughing = sinceLaugh < LAUGH_MS;
      const talkingNow = talkingRef.current;

      // ---- gaze: the cursor, or up at the thought cloud while thinking ----
      let tx = 0, ty = 0;
      if (st === 'thinking') {
        tx = -0.45 + 0.12 * Math.sin(now / 900);
        ty = -0.6;
      } else if (cursor) {
        const r = root.getBoundingClientRect();
        const ax = r.left + (layout.eyes[0] / 100) * r.width;
        const ay = r.top + (layout.eyes[1] / 100) * r.height;
        const dx = cursor.x - ax, dy = cursor.y - ay;
        tx = dx / (Math.abs(dx) + 260);
        ty = dy / (Math.abs(dy) + 220);
      }
      if (st === 'error') ty = Math.max(ty, 0.3);
      // People tend to blink when their gaze jumps a long way.
      if (Math.hypot(tx - lastTx, ty - lastTy) > 0.45 && now - blinkStart > 1200 && Math.random() < 0.6) startBlink(now);
      lastTx = tx; lastTy = ty;
      // Eyes lead, the head follows.
      cur.ex = ease(cur.ex, tx, 16, dt);
      cur.ey = ease(cur.ey, ty, 16, dt);
      cur.hx = ease(cur.hx, tx, 5, dt);
      cur.hy = ease(cur.hy, ty, 5, dt);
      cur.energy = ease(cur.energy, talkingNow ? 1 : 0, 3, dt);
      cur.tilt = ease(cur.tilt, st === 'thinking' ? 1 : 0, 3, dt);
      cur.laugh = ease(cur.laugh, laughing ? 1 : 0, laughing ? 10 : 3, dt);
      nod *= Math.exp(-dt * 5);

      // ---- mouth ----
      const shake = Math.sin(sinceLaugh / 1000 * Math.PI * 2 * 5);   // about five "ha"s a second
      if (laughing) {
        setMouth(shake > -0.2 ? A2 : C, now);
      } else if (!talkingNow) {
        script = null;
        setMouth(REST, now);
      } else if (script && pos < script.at[script.at.length - 1]) {
        pos += rate * dt;
        let i = Math.max(lastChar, 0);
        while (i < script.shape.length - 1 && script.at[i + 1] <= pos) i++;
        while (i > 0 && script.at[i] > pos) i--;
        if (i !== lastChar) {
          for (let j = lastChar + 1; j <= i; j++) if (script.laughs.has(j)) cueRef.current?.laugh();
          lastChar = i;
          setMouth(script.shape[i], now);
        }
      } else if (now >= freeUntil) {
        // Still talking past our estimate of the text: keep a soft speaking rhythm.
        const next = [C, E, A1, C, O, REST][Math.floor(Math.random() * 6)];
        setMouth(next === mouth ? C : next, now);
        freeUntil = now + rand(80, 150);
      }
      const blend = clamp((now - mouthChangedAt) / MOUTH_BLEND_MS, 0, 1);
      mouthRefs.current.forEach((el, i) => {
        // The new shape fades in on top of the old one.
        if (i === mouth) setStyle(el, `visibility:visible;opacity:${blend.toFixed(2)};z-index:2`);
        else if (i === prevMouth && blend < 1) setStyle(el, `visibility:visible;opacity:${mouth === REST ? (1 - blend).toFixed(2) : '1'};z-index:1`);
        else setStyle(el, 'visibility:hidden');
      });

      // ---- eyes ----
      let lid = 0;
      if (laughing) {
        lid = sinceLaugh < LAUGH_MS * 0.55 ? 1 : 0.6;   // squeezed shut, then a happy squint
        nextBlinkAt = now + rand(1500, 3000);
      } else {
        if (now >= nextBlinkAt) startBlink(now);
        const since = now - blinkStart;
        lid = Math.max(blinkAmount(since), doubleBlink ? blinkAmount(since - 300) : 0);
      }
      const step = Math.round(lid * blinkSteps);
      blinkRefs.current.forEach((el, i) => setStyle(el, i === step - 1 ? 'visibility:visible' : 'visibility:hidden'));

      root.classList.toggle('laughing', sinceLaugh < LAUGH_MS + TEARS_AFTER_MS);

      // ---- body ----
      const amp = reduced ? 0.35 : 1;
      const e = cur.energy * amp;
      const L = cur.laugh * amp;
      const openness = mouth === A2 ? 1 : mouth === O || mouth === A1 ? 0.7 : mouth === REST ? 0 : 0.35;
      if (torsoRef.current) {
        // Breathing, a speaker's sway, and shoulders shaking with laughter.
        const breathe = reduced ? 0 : Math.sin(t * 1.5) * 0.006;
        const sway = Math.sin(t * 1.1) * 0.8 * e;
        const shift = Math.sin(t * 0.8) * 0.6 * e;
        const bounce = -Math.abs(shake) * 1.2 * L - openness * 0.3 * e;
        torsoRef.current.style.transform =
          `translate(${shift}%, ${bounce}%) rotate(${sway + shake * 0.6 * L}deg) scale(1, ${1 + breathe})`;
      }
      if (headRef.current) {
        // Look target, plus talking gestures, the thinking tilt, and a laugh thrown back.
        const idleSway = reduced ? 0 : Math.sin(t * 0.9) * 0.8;
        const wanderYaw = Math.sin(t * 0.7) * 3 * e;
        const wanderRoll = Math.sin(t * 1.3 + 1) * 2 * e;
        const lean = st === 'listening' ? 1.025 : 1;
        headRef.current.style.transform =
          `rotateY(${cur.hx * 14 * amp + wanderYaw}deg) ` +
          `rotateX(${-cur.hy * 8 * amp - nod * 4 * amp + 7 * L}deg) ` +
          `rotate(${(cur.hx * 3 + idleSway) * amp + wanderRoll - 5 * cur.tilt * amp + shake * 1.5 * L}deg) ` +
          `scale(${lean})`;
      }
      if (irisRef.current) {
        irisRef.current.style.transform =
          `translate(${cur.ex * layout.irisTravel[0]}%, ${cur.ey * layout.irisTravel[1]}%)`;
      }
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove, { capture: true });
      document.removeEventListener('mouseout', onLeave);
      cueRef.current = null;
    };
  }, []);

  const eyeMask = `url("${asset('eyemask')}")`;
  const tear = (side: 'l' | 'r', corner: number[], n: number) => (
    <span
      className={`av-tear av-tear-${side} av-tear-${n}`}
      style={{ left: `${corner[0]}%`, top: `${corner[1]}%` }}
    />
  );

  return (
    <div ref={rootRef} className="echo-avatar">
      <div className="av-glow" />
      <div ref={torsoRef} className="av-torso">
        <img className="av-layer" src={asset('body')} alt="" draggable={false} />
        <div
          ref={headRef}
          className="av-head"
          style={{ transformOrigin: `${layout.pivot[0]}% ${layout.pivot[1]}%` }}
        >
          <img className="av-layer" src={asset('head')} alt="" draggable={false} />
          <div className="av-eyes" style={{ WebkitMaskImage: eyeMask, maskImage: eyeMask }}>
            <img ref={irisRef} className="av-layer" src={asset('iris')} alt="" draggable={false} />
          </div>
          {Array.from({ length: blinkSteps }, (_, i) => (
            <img key={`b${i}`} ref={el => { blinkRefs.current[i] = el; }} className="av-layer av-frame"
              src={asset(`blink${i + 1}`)} alt="" draggable={false} />
          ))}
          {MOUTHS.map((name, i) => (
            <img key={name} ref={el => { mouthRefs.current[i] = el; }} className="av-layer av-frame"
              src={asset(`mouth-${name}`)} alt="" draggable={false} />
          ))}
          {tear('l', layout.tearL, 1)}
          {tear('l', layout.tearL, 2)}
          {tear('r', layout.tearR, 1)}
          {tear('r', layout.tearR, 2)}
        </div>
      </div>
      <div className="av-thought" aria-hidden="true">
        <svg className="av-cloud" viewBox="0 0 120 80">
          <path d="M28 66c-12 0-21-8-21-18 0-9 7-16 16-17 1-12 12-21 25-21 9 0 17 4 21 11 3-2 7-3 11-3 12 0 21 9 21 20 8 2 13 8 13 15 0 8-8 13-17 13z" />
        </svg>
        <span className="av-dot" /><span className="av-dot" /><span className="av-dot" />
        <span className="av-puff av-puff-1" />
        <span className="av-puff av-puff-2" />
      </div>
      <div
        className="av-hit"
        title="Click to talk · long-press for commands · drag to move"
        onClick={onClick}
        onPointerDown={onPointerDown}
      />
    </div>
  );
}
