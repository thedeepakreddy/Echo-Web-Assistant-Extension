// Choosing a text-to-speech voice that matches the character.
//
// The Web Speech API does not say whether a voice is female or male, so this
// reads it from the voice's name: an explicit "Female"/"Male", or a known
// voice name on macOS, Windows/Edge and Chrome. If the language has no voice
// of the right gender, the pitch is shifted so the tone still matches.

export type VoiceGender = 'female' | 'male';

export interface VoiceLike {
  name: string;
  lang: string;
  localService?: boolean;
}

const FEMALE = new Set([
  // Apple (macOS / iOS)
  'samantha', 'karen', 'moira', 'tessa', 'fiona', 'victoria', 'allison', 'ava', 'susan', 'zoe', 'kate',
  'serena', 'veena', 'lekha', 'amelie', 'amélie', 'audrey', 'aurelie', 'aurélie', 'anna', 'helena', 'monica',
  'mónica', 'paulina', 'alice', 'joana', 'luciana', 'milena', 'yuna', 'kyoko', 'tingting', 'meijia', 'sinji',
  'sara', 'nora', 'zuzana', 'ioana', 'ellen', 'laura', 'mariska', 'melina', 'carmit', 'damayanti', 'kanya',
  'lesya', 'yelda', 'tünde', 'tunde', 'satu', 'flo', 'sandy', 'shelley', 'kathy', 'vicki', 'isha', 'martha',
  'catherine', 'nicky', 'marie', 'amira', 'soumya', 'tara', 'geeta', 'piya', 'kiyara',
  // Microsoft (Windows / Edge, including the "Online (Natural)" voices)
  'zira', 'hazel', 'heera', 'kalpana', 'hortense', 'julie', 'katja', 'hedda', 'sabina', 'elsa', 'aria',
  'jenny', 'michelle', 'sonia', 'libby', 'neerja', 'swara', 'shruti', 'pallavi', 'ana', 'emma', 'jane',
  'nancy', 'natasha', 'clara', 'elvira', 'denise', 'eloise', 'vivienne', 'amala', 'xiaoxiao', 'nanami',
  'sunhi', 'dhwani', 'vani', 'aarti', 'gadis', 'salma', 'amber', 'ashley', 'cora', 'elizabeth', 'maisie',
  'mia', 'molly', 'hollie', 'abbi', 'bella', 'olivia', 'yan', 'hiemi', 'nia', 'imani', 'leah', 'luna',
]);

const MALE = new Set([
  // Apple
  'alex', 'daniel', 'fred', 'oliver', 'tom', 'aaron', 'arthur', 'gordon', 'lee', 'rishi', 'thomas', 'jacques',
  'diego', 'jorge', 'juan', 'carlos', 'luca', 'markus', 'yannick', 'xander', 'maged', 'otoya', 'yuri',
  'bruce', 'ralph', 'junior', 'eddy', 'reed', 'rocko', 'nicolas', 'evan', 'nathan', 'aman',
  // Microsoft
  'david', 'mark', 'george', 'ravi', 'hemant', 'paul', 'stefan', 'pablo', 'raul', 'guy', 'christopher',
  'eric', 'roger', 'steffan', 'ryan', 'prabhat', 'madhur', 'mohan', 'valluvar', 'andrew', 'brian', 'davis',
  'tony', 'jason', 'william', 'conrad', 'henri', 'alvaro', 'liam', 'keita', 'yunxi', 'injoon', 'kunal',
  'alfie', 'elliot', 'ethan', 'noah', 'oscar', 'brandon', 'christian', 'jacob', 'kai', 'duncan',
]);

// Apple's novelty voices (bells, whispers, robots) are never a good choice.
const NOVELTY = /\b(bad news|good news|bahh|bells|boing|bubbles|cellos|deranged|hysterical|jester|organ|superstar|trinoids|whisper|wobble|zarvox|albert|grandma|grandpa|princess)\b/i;

// Apple's Eloquence voices and its old MacinTalk voices sound noticeably more
// synthetic than the rest, so they are picked only when nothing better fits.
const ROBOTIC = /^(eddy|flo|reed|rocko|sandy|shelley|fred|junior|kathy|ralph|vicki)\b/i;

// Names that say nothing about gender but are known (Chrome's network voices).
const KNOWN: Record<string, VoiceGender> = {
  'google us english': 'female',
  'google हिन्दी': 'female',
  'google français': 'female',
  'google deutsch': 'female',
  'google italiano': 'female',
  'google 日本語': 'female',
};

// The order ECHO preferred before characters had voices (kept for the orb).
const LEGACY_PREFERENCE = ['Google UK English Female', 'Google US English', 'Samantha', 'Karen', 'Google UK English Male'];

/** A voice's gender as far as its name tells, or null when it doesn't. */
export function voiceGender(voice: VoiceLike): VoiceGender | null {
  const name = voice.name.trim();
  if (/\bfemale\b/i.test(name)) return 'female';
  if (/\bmale\b/i.test(name)) return 'male';
  const known = KNOWN[name.toLowerCase()];
  if (known) return known;
  for (const word of name.toLowerCase().split(/[^\p{L}]+/u)) {
    if (FEMALE.has(word)) return 'female';
    if (MALE.has(word)) return 'male';
  }
  return null;
}

/**
 * The best voice for `lang` and, when given, the character's gender, plus the
 * pitch to speak at. Language comes first (a wrong-language voice mangles the
 * words), then gender, then quality.
 */
export function pickVoice<V extends VoiceLike>(voices: V[], lang: string, gender?: VoiceGender): { voice: V | null; pitch: number } {
  const want = lang.toLowerCase().replace('_', '-');
  const base = want.slice(0, 2);
  const langScore = (v: V) => {
    const l = v.lang.toLowerCase().replace('_', '-');
    return l === want ? 2 : l.startsWith(base) ? 1 : 0;
  };
  const usable = voices.filter(v => !NOVELTY.test(v.name));
  const inLang = usable.filter(v => langScore(v) > 0);
  const pool = inLang.length ? inLang : usable;
  if (!pool.length) return { voice: null, pitch: 1 };

  const score = (v: V) => {
    let s = langScore(v) * 10;
    if (/natural|neural|premium|enhanced/i.test(v.name)) s += 3;
    if (/^google\b/i.test(v.name)) s += 2;          // Chrome's network voices sound the most natural
    if (ROBOTIC.test(v.name)) s -= 4;
    if (gender) {
      const g = voiceGender(v);
      s += g === gender ? 20 : g === null ? 5 : -50;
    } else {
      const i = LEGACY_PREFERENCE.indexOf(v.name);
      if (i >= 0) s += 15 - i;
    }
    return s;
  };
  const voice = pool.reduce((best, v) => (score(v) > score(best) ? v : best), pool[0]);

  // Only a voice of the other gender for this language: shift the pitch so the
  // character still sounds like itself.
  let pitch = 1;
  if (gender && voiceGender(voice) && voiceGender(voice) !== gender) pitch = gender === 'female' ? 1.3 : 0.75;
  return { voice, pitch };
}
