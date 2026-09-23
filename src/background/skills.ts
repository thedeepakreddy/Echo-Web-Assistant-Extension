// Skills: saved prompts you run by typing "/shortcut" in any ECHO input (side
// panel, the in-page box, or the address bar). Stored locally.

export interface Skill {
  id: string;
  shortcut: string;   // letters, numbers, hyphens
  name: string;
  prompt: string;
}

export const DEFAULT_SKILLS: Skill[] = [
  { id: 'summarize', shortcut: 'summarize', name: 'Summarize page',
    prompt: 'Summarize this page in 5 short bullet points.' },
  { id: 'key-points', shortcut: 'key-points', name: 'Key points',
    prompt: 'List the key points of this page as short bullets.' },
  { id: 'explain', shortcut: 'explain', name: 'Explain simply',
    prompt: 'Explain this in simple terms a beginner can follow, with one short example:' },
  { id: 'improve', shortcut: 'improve', name: 'Improve writing',
    prompt: 'Improve the writing below. Keep the meaning and language; fix grammar, clarity and flow. Return only the improved text:' },
  { id: 'translate', shortcut: 'translate', name: 'Translate',
    prompt: 'Translate the following into English, or into the language I name first. Return only the translation:' },
  { id: 'reply', shortcut: 'reply', name: 'Draft a reply',
    prompt: 'Draft a polite, concise reply to this message:' },
  { id: 'social-post', shortcut: 'social-post', name: 'Social media post',
    prompt: 'Write a short, engaging social media post about this page, with 2-3 relevant hashtags.' },
];

const MAX_SKILLS = 50;
export const SHORTCUT_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export async function listSkills(): Promise<Skill[]> {
  const { echo_skills } = await chrome.storage.local.get(['echo_skills']);
  return Array.isArray(echo_skills) ? (echo_skills as Skill[]) : DEFAULT_SKILLS.map(s => ({ ...s }));
}

export function validateSkill(raw: any, existing: Skill[]): Skill {
  const shortcut = String(raw?.shortcut ?? '').trim().toLowerCase().replace(/^\//, '');
  const name = String(raw?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const prompt = String(raw?.prompt ?? '').trim().slice(0, 2000);
  if (!SHORTCUT_RE.test(shortcut)) throw new Error('Shortcuts use letters, numbers and hyphens only (max 32).');
  if (!name) throw new Error('Give the skill a name.');
  if (!prompt) throw new Error('A skill needs a prompt.');
  const id = String(raw?.id || '') || `skill_${Date.now().toString(36)}`;
  if (existing.some(s => s.shortcut === shortcut && s.id !== id)) throw new Error(`/${shortcut} is already used by another skill.`);
  return { id, shortcut, name, prompt };
}

export async function saveSkill(raw: any): Promise<Skill> {
  const skills = await listSkills();
  const skill = validateSkill(raw, skills);
  const i = skills.findIndex(s => s.id === skill.id);
  if (i >= 0) skills[i] = skill;
  else {
    if (skills.length >= MAX_SKILLS) throw new Error(`You can have up to ${MAX_SKILLS} skills.`);
    skills.push(skill);
  }
  await chrome.storage.local.set({ echo_skills: skills });
  return skill;
}

export async function deleteSkill(id: string): Promise<boolean> {
  const skills = await listSkills();
  const next = skills.filter(s => s.id !== id);
  await chrome.storage.local.set({ echo_skills: next });
  return next.length !== skills.length;
}

export async function resetSkills(): Promise<Skill[]> {
  await chrome.storage.local.remove('echo_skills');
  return listSkills();
}

export type SkillExpansion =
  | { kind: 'skill'; skill: Skill; prompt: string }
  | { kind: 'unknown'; message: string };

/** "/shortcut extra text" -> the skill's prompt plus the extra text. Pure. */
export function expandWith(skills: Skill[], input: string): SkillExpansion | null {
  const m = String(input || '').trim().match(/^\/([a-z0-9][a-z0-9-]{0,31})(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  const skill = skills.find(s => s.shortcut === m[1].toLowerCase());
  if (!skill) {
    const names = skills.map(s => `/${s.shortcut}`).join(', ');
    return { kind: 'unknown', message: `There's no skill called /${m[1]}. ${names ? `Your skills: ${names}.` : 'Add skills in Options.'}` };
  }
  const extra = (m[2] || '').trim();
  return { kind: 'skill', skill, prompt: extra ? `${skill.prompt}\n\n${extra}` : skill.prompt };
}

export async function expandSkill(input: string): Promise<SkillExpansion | null> {
  if (!String(input || '').trim().startsWith('/')) return null;
  return expandWith(await listSkills(), input);
}
