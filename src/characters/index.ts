// ECHO's characters and the colour theme each one brings to every surface:
// the in-page HUD, the command bar, the chat panel and the settings page.
//
// To add a character: trace tools/avatar/characters/<id>/config.json, run
// `python3 tools/avatar/build_avatar.py <id>`, then add an entry below.
// See tools/avatar/README.md.

import echoLayout from '../assets/characters/echo/layout.json';
import styleLayout from '../assets/characters/echo-style/layout.json';
import officerLayout from '../assets/characters/echo-officer/layout.json';
import patrolLayout from '../assets/characters/echo-patrol/layout.json';
import mentorLayout from '../assets/characters/echo-mentor/layout.json';
import visionaryLayout from '../assets/characters/echo-visionary/layout.json';
import analystLayout from '../assets/characters/echo-analyst/layout.json';
import type { VoiceGender } from '../content/voice';

export interface CharacterTheme {
  /** Resting glow, primary buttons, focus rings. */
  accent: string;
  /** Second hue for gradients and the user's chat bubbles. */
  accent2: string;
  listening: string;
  thinking: string;
  speaking: string;
  error: string;
  /** Soft colour fields drifting behind the glass on extension pages. */
  backdrop: [string, string, string];
}

export interface CharacterLayout {
  aspect: number;
  pivot: number[];
  eyes: number[];
  irisTravel: number[];
  tearL: number[];
  tearR: number[];
  blinkSteps: number;
  mouths: string[];
}

export interface Character {
  id: string;
  name: string;
  tagline: string;
  /** The character only ever speaks in a voice of this gender. */
  voice: VoiceGender;
  layout: CharacterLayout;
  theme: CharacterTheme;
}

export const CHARACTERS: Character[] = [
  {
    id: 'echo',
    name: 'Echo',
    tagline: 'Friendly lab assistant',
    voice: 'female',
    layout: echoLayout,
    theme: {
      accent: '#b8a1ff',
      accent2: '#ff9fd0',
      listening: '#7fd6ff',
      thinking: '#a78bfa',
      speaking: '#ffb0d8',
      error: '#ff6b6b',
      backdrop: ['#4c3a9e', '#9c3f7d', '#23458f'],
    },
  },
  // Every character is called Echo; the tagline tells them apart.
  {
    id: 'echo-style',
    name: 'Echo',
    tagline: 'Style advisor',
    voice: 'female',
    layout: styleLayout,
    theme: {   // caramel curls, rose lips, the colourful rail behind her
      accent: '#ffb07c',
      accent2: '#ff86c8',
      listening: '#86d8ff',
      thinking: '#ff9eb5',
      speaking: '#ffd08a',
      error: '#ff6b6b',
      backdrop: ['#6e3b2b', '#8f2f6a', '#29406e'],
    },
  },
  {
    id: 'echo-officer',
    name: 'Echo',
    tagline: 'Safety officer',
    voice: 'male',
    layout: officerLayout,
    theme: {   // badge gold on navy
      accent: '#f7c948',
      accent2: '#6f9bff',
      listening: '#7fd6ff',
      thinking: '#8fb3ff',
      speaking: '#ffd76b',
      error: '#ff6b6b',
      backdrop: ['#1b2a5c', '#6b4a14', '#243a7a'],
    },
  },
  {
    id: 'echo-patrol',
    name: 'Echo',
    tagline: 'Patrol partner',
    voice: 'female',
    layout: patrolLayout,
    theme: {   // patrol blue with a hint of siren red
      accent: '#8cb4ff',
      accent2: '#ff7a8a',
      listening: '#7fe0ff',
      thinking: '#b39dff',
      speaking: '#ffa3b1',
      error: '#ff6b6b',
      backdrop: ['#1d2f63', '#6b1f35', '#1f4f7a'],
    },
  },
  {
    id: 'echo-mentor',
    name: 'Echo',
    tagline: 'Wise mentor',
    voice: 'female',
    layout: mentorLayout,
    theme: {   // silver hair, clear blue eyes
      accent: '#9ecbff',
      accent2: '#d6c8ff',
      listening: '#7fe0ff',
      thinking: '#b8a6ff',
      speaking: '#c9e4ff',
      error: '#ff6b6b',
      backdrop: ['#2b3f66', '#4a3b6e', '#1f4a5a'],
    },
  },
  {
    id: 'echo-visionary',
    name: 'Echo',
    tagline: 'Tech visionary',
    voice: 'male',
    layout: visionaryLayout,
    theme: {   // teal jacket, green lenses, gold tie
      accent: '#2ee6c8',
      accent2: '#f5c542',
      listening: '#7fe0ff',
      thinking: '#7cf29a',
      speaking: '#ffd76b',
      error: '#ff6b6b',
      backdrop: ['#0b5563', '#6b5a14', '#1f6b4a'],
    },
  },
  {
    id: 'echo-analyst',
    name: 'Echo',
    tagline: 'Skeptical analyst',
    voice: 'male',
    layout: analystLayout,
    theme: {   // moody steel-teal studio light
      accent: '#6ec6d6',
      accent2: '#9aa7ff',
      listening: '#7fd6ff',
      thinking: '#b39dff',
      speaking: '#a8e6f0',
      error: '#ff6b6b',
      backdrop: ['#0f3a4a', '#2b2f5e', '#1c2a3a'],
    },
  },
];

/** The original arc-reactor orb, which has no character art. */
export const REACTOR = 'reactor';
export const REACTOR_THEME: CharacterTheme = {
  accent: '#52fefe',
  accent2: '#5b8cff',
  listening: '#52fefe',
  thinking: '#b388ff',
  speaking: '#ffd479',
  error: '#ff6b6b',
  backdrop: ['#0b5563', '#1d3f8a', '#3b2a78'],
};

export const DEFAULT_APPEARANCE = CHARACTERS[0].id;

/** A stored `echo_avatar` value as a known appearance: a character id or 'reactor'. */
export function resolveAppearance(value: unknown): string {
  if (value === REACTOR) return REACTOR;
  return CHARACTERS.some(c => c.id === value) ? String(value) : DEFAULT_APPEARANCE;
}

export function characterById(id: string): Character | null {
  return CHARACTERS.find(c => c.id === id) || null;
}

export function themeFor(appearance: string): CharacterTheme {
  return characterById(appearance)?.theme || REACTOR_THEME;
}

/** The theme as CSS custom properties, for a `style` attribute. */
export function themeVars(theme: CharacterTheme): Record<string, string> {
  return {
    '--e-accent': theme.accent,
    '--e-accent-2': theme.accent2,
    '--e-listening': theme.listening,
    '--e-thinking': theme.thinking,
    '--e-speaking': theme.speaking,
    '--e-error': theme.error,
    '--e-blob-1': theme.backdrop[0],
    '--e-blob-2': theme.backdrop[1],
    '--e-blob-3': theme.backdrop[2],
  };
}

export const characterAsset = (id: string, name: string) => chrome.runtime.getURL(`characters/${id}/${name}.webp`);
