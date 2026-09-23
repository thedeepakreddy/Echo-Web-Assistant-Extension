import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EchoAvatar, AvatarCues } from '../../src/content/avatar';
import { CHARACTERS, themeVars } from '../../src/characters';
import '../../src/theme/glass.css';
import '../../src/content/index.css';
import './avatar-showcase.css';

(globalThis as any).chrome = {
  runtime: { getURL: (path: string) => path },
};

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'laughing';
const PHASES: Array<{ phase: Phase; duration: number; caption: string }> = [
  { phase: 'idle', duration: 1500, caption: 'Idle · breathing, blinking and following your cursor' },
  { phase: 'listening', duration: 1500, caption: 'Listening · focused and ready for your voice' },
  { phase: 'thinking', duration: 2300, caption: 'Thinking · reflective gaze and animated thought cloud' },
  { phase: 'speaking', duration: 2600, caption: 'Talking · lip-sync, head movement and natural expression' },
  { phase: 'laughing', duration: 3000, caption: 'Laughing · happy squint, movement and animated tears' },
];

function CharacterCard({ index, phase }: { index: number; phase: Phase }) {
  const character = CHARACTERS[index];
  const cueRef = useRef<AvatarCues | null>(null);
  const talking = phase === 'speaking' || phase === 'laughing';
  const status = phase === 'laughing' ? 'speaking' : phase;

  useEffect(() => {
    if (phase === 'speaking') cueRef.current?.speak('Hello! I am ECHO, your local-first browser assistant.');
    if (phase === 'laughing') {
      cueRef.current?.speak('Haha, that was brilliant!');
      cueRef.current?.laugh();
    }
  }, [phase]);

  return (
    <article className="showcase-card" style={themeVars(character.theme) as React.CSSProperties}>
      <div id="echo-root-wrapper" className="avatar-mode" data-status={status}>
        <EchoAvatar
          character={character}
          status={status}
          talking={talking}
          cueRef={cueRef}
          onClick={() => {}}
          onPointerDown={() => {}}
        />
      </div>
      <div className="character-copy">
        <strong>{character.name}</strong>
        <span>{character.tagline}</span>
      </div>
    </article>
  );
}

function Showcase() {
  const [elapsed, setElapsed] = useState(0);
  const total = useMemo(() => PHASES.reduce((sum, item) => sum + item.duration, 0), []);

  useEffect(() => {
    const started = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      setElapsed((now - started) % total);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [total]);

  let cursor = elapsed;
  let current = PHASES[0];
  let phaseStart = 0;
  for (const item of PHASES) {
    if (cursor < item.duration) { current = item; break; }
    phaseStart += item.duration;
    cursor -= item.duration;
  }
  const progress = ((elapsed - phaseStart) / current.duration) * 100;

  return (
    <main className="showcase">
      <header>
        <div>
          <p className="eyebrow">ECHO ONLINE · AVATAR SYSTEM</p>
          <h1>One assistant. Seven personalities.</h1>
          <p className="subtitle">Every character blinks, listens, thinks, talks and laughs using the same real-time animation engine.</p>
        </div>
        <div className={`phase phase-${current.phase}`}>
          <span className="phase-dot" />
          <strong>{current.phase}</strong>
          <small>{current.caption}</small>
          <i style={{ width: `${progress}%` }} />
        </div>
      </header>

      <section className="character-grid">
        {CHARACTERS.map((_, index) => <CharacterCard key={CHARACTERS[index].id} index={index} phase={current.phase} />)}
      </section>

      <footer>
        <span>Cursor-aware gaze</span><span>Natural blinking</span><span>Text-driven lip sync</span><span>State-aware motion</span><span>Laughter tears</span>
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Showcase />);
