// The eight avatars as OpenClaw agents, and the browser tools each may use.
//
// OpenClaw forwards a tool call to ECHO with only the command and arguments,
// never the calling session, so each avatar has its own command names
// (echo.<slug>.<tool>) and each agent is allowed only its own tools. Every
// command is declared up front: changing this list makes the gateway ask the
// user to approve ECHO's command surface again.

import { CHARACTERS, REACTOR } from '../../characters';

export interface AvatarAgent {
  /** Character id in src/characters (or 'reactor'); also the ECHO scope id. */
  character: string;
  /** Short name used in tool and command names. */
  slug: string;
  /** Agent id in the OpenClaw gateway. */
  agentId: string;
  tagline: string;
}

export const AVATAR_AGENTS: AvatarAgent[] = [
  ...CHARACTERS.map(c => ({ character: c.id, slug: c.id === 'echo' ? 'echo' : c.id.replace(/^echo-/, ''), agentId: c.id, tagline: c.tagline })),
  { character: REACTOR, slug: 'core', agentId: 'echo-core', tagline: 'Core' },
];

/** Every browser tool name, in the order agents see them. Some ship later; all are declared now. */
export const TOOL_NAMES = [
  'observe', 'read', 'act', 'navigate', 'tabs', 'find', 'extract', 'verify', 'transcript', 'workflow', 'watch', 'screenshot',
] as const;
export type ToolName = typeof TOOL_NAMES[number];

export const toolNameFor = (slug: string, tool: ToolName) => `${slug}_${tool}`;
export const commandFor = (slug: string, tool: ToolName) => `echo.${slug}.${tool}`;

export function avatarByCharacter(character: string): AvatarAgent | null {
  return AVATAR_AGENTS.find(a => a.character === character) || null;
}
export function avatarBySlug(slug: string): AvatarAgent | null {
  return AVATAR_AGENTS.find(a => a.slug === slug) || null;
}

/** The whole command surface ECHO's node declares when it connects. */
export function allCommands(): string[] {
  return AVATAR_AGENTS.flatMap(a => TOOL_NAMES.map(t => commandFor(a.slug, t)));
}
