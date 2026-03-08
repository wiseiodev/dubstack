import chalk from 'chalk';
import { execa } from 'execa';
import { DubError } from '../lib/errors';
import {
  AVAILABLE_SKILLS,
  getSkillRemote,
  type SkillName,
} from '../lib/skills';

interface SkillsOptions {
  global?: boolean;
  dryRun?: boolean;
}

function validateSkills(skills: string[]): SkillName[] {
  const invalidSkills = skills.filter((s) => !(s in AVAILABLE_SKILLS));

  if (invalidSkills.length > 0) {
    throw new DubError(
      `Unknown skill(s): ${invalidSkills.join(', ')}. Available skills: ${Object.keys(AVAILABLE_SKILLS).join(', ')}`,
    );
  }

  return skills as SkillName[];
}

export async function addSkills(skills: string[], options: SkillsOptions = {}) {
  const targets =
    skills.length > 0
      ? validateSkills(skills)
      : (Object.keys(AVAILABLE_SKILLS) as SkillName[]);

  console.log(chalk.blue(`Adding ${targets.length} skill(s)...`));

  for (const skill of targets) {
    const remote = getSkillRemote(skill);
    const args = ['skills', 'add', remote];
    if (options.global) args.push('--global');

    const command = `npx ${args.join(' ')}`;
    console.log(chalk.dim(`Running: ${command}`));

    if (!options.dryRun) {
      try {
        await execa('npx', args, { stdio: 'inherit' });
        console.log(chalk.green(`✔ Added skill: ${skill}`));
      } catch (error) {
        console.error(chalk.red(`✖ Failed to add skill: ${skill}`));
        throw error;
      }
    }
  }
}

export async function removeSkills(
  skills: string[],
  options: SkillsOptions = {},
) {
  const targets =
    skills.length > 0
      ? validateSkills(skills)
      : (Object.keys(AVAILABLE_SKILLS) as SkillName[]);

  console.log(chalk.blue(`Removing ${targets.length} skill(s)...`));

  for (const skill of targets) {
    const args = ['skills', 'remove', skill];
    if (options.global) args.push('--global');

    const command = `npx ${args.join(' ')}`;
    console.log(chalk.dim(`Running: ${command}`));

    if (!options.dryRun) {
      try {
        await execa('npx', args, { stdio: 'inherit' });
        console.log(chalk.green(`✔ Removed skill: ${skill}`));
      } catch (error) {
        console.error(chalk.red(`✖ Failed to remove skill: ${skill}`));
        throw error;
      }
    }
  }
}
