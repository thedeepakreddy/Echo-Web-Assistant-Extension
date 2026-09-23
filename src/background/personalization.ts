// Personalization and long-term memory: who you are, how you like answers, and
// facts ECHO should remember. Everything stays in local storage; only what a
// request needs is placed in that request's system prompt.

export type Tone = 'default' | 'concise' | 'friendly' | 'professional' | 'casual' | 'detailed';

export interface Profile {
  name: string;
  about: string;          // job, interests, context
  tone: Tone;
  instructions: string;   // free-form "always do X"
}

export const DEFAULT_PROFILE: Profile = { name: '', about: '', tone: 'default', instructions: '' };

export const TONES: Record<Tone, { label: string; rule: string }> = {
  default: { label: 'Default', rule: '' },
  concise: { label: 'Concise', rule: 'Keep answers short and to the point.' },
  friendly: { label: 'Friendly', rule: 'Use a warm, friendly tone.' },
  professional: { label: 'Professional', rule: 'Use a clear, professional tone.' },
  casual: { label: 'Casual', rule: 'Use a relaxed, casual tone.' },
  detailed: { label: 'Detailed', rule: 'Give thorough, detailed answers.' },
};

const LIMITS = { name: 60, about: 400, instructions: 800, key: 40, value: 500, memories: 200 };

export function sanitizeProfile(raw: any): Profile {
  const text = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const tone = (raw?.tone in TONES ? raw.tone : 'default') as Tone;
  return {
    name: text(raw?.name, LIMITS.name),
    about: text(raw?.about, LIMITS.about),
    tone,
    instructions: String(raw?.instructions ?? '').trim().slice(0, LIMITS.instructions),
  };
}

export async function getProfile(): Promise<Profile & { memoryEnabled: boolean }> {
  const r = await chrome.storage.local.get(['echo_profile', 'echo_memory_enabled']);
  return { ...sanitizeProfile(r.echo_profile || DEFAULT_PROFILE), memoryEnabled: r.echo_memory_enabled !== false };
}

/** Memory keys are short snake_case labels ("home_city"). */
export function memoryKey(raw: string): string {
  return String(raw || '').toLowerCase().trim()
    .replace(/[^a-z0-9 _-]/g, '').replace(/[\s-]+/g, '_').replace(/^_+|_+$/g, '')
    .slice(0, LIMITS.key);
}

export async function getMemories(): Promise<Record<string, string>> {
  const { echo_memory } = await chrome.storage.local.get(['echo_memory']);
  return { ...((echo_memory || {}) as Record<string, string>) };
}

export async function setMemory(rawKey: string, rawValue: string): Promise<string> {
  const key = memoryKey(rawKey);
  const value = String(rawValue ?? '').trim().slice(0, LIMITS.value);
  if (!key) throw new Error('Give the memory a short name, like "home city".');
  if (!value) throw new Error('A memory needs a value.');
  const memory = await getMemories();
  if (!(key in memory) && Object.keys(memory).length >= LIMITS.memories) {
    throw new Error(`You can save up to ${LIMITS.memories} memories. Delete some first.`);
  }
  memory[key] = value;
  await chrome.storage.local.set({ echo_memory: memory });
  return key;
}

export async function deleteMemory(key: string): Promise<boolean> {
  const memory = await getMemories();
  if (!Object.prototype.hasOwnProperty.call(memory, key)) return false;
  delete memory[key];
  await chrome.storage.local.set({ echo_memory: memory });
  return true;
}

export async function clearMemories(): Promise<void> {
  await chrome.storage.local.set({ echo_memory: {} });
}

/** The personal part of a system prompt. Pure, so it is unit-testable. */
export function buildPersonalContext(
  profile: Profile, memory: Record<string, string>, opts: { includeMemory: boolean },
): string {
  const lines: string[] = [];
  if (profile.name) lines.push(`Name: ${profile.name}`);
  if (profile.about) lines.push(`About them: ${profile.about}`);
  if (TONES[profile.tone]?.rule) lines.push(`Style: ${TONES[profile.tone].rule}`);
  if (profile.instructions) lines.push(`Their standing instructions: ${profile.instructions}`);
  let out = lines.length ? `\n\n--- ABOUT THE USER ---\n${lines.join('\n')}` : '';

  const entries = opts.includeMemory ? Object.entries(memory) : [];
  if (entries.length) {
    out += '\n\n--- LONG TERM MEMORY ---\nFacts and preferences the user asked you to remember:\n'
      + entries.map(([k, v]) => `- [${k}]: ${v}`).join('\n')
      + '\nUse these when relevant. Never type them into a website unless the user asked for that.';
  }
  return out;
}

export async function personalContext(opts: { includeMemory: boolean }): Promise<string> {
  const profile = await getProfile();
  const memory = profile.memoryEnabled && opts.includeMemory ? await getMemories() : {};
  return buildPersonalContext(profile, memory, { includeMemory: profile.memoryEnabled && opts.includeMemory });
}
