export const AVAILABLE_SKILLS = {
  dubstack: 'wiseiodev/dubstack/skills/dubstack',
  'dub-flow': 'wiseiodev/dubstack/skills/dub-flow',
} as const;

export type SkillName = keyof typeof AVAILABLE_SKILLS;

export function getSkillRemote(name: SkillName): string {
  return AVAILABLE_SKILLS[name];
}
