import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addSkills, removeSkills } from '../../src/commands/skills';
import { DubError } from '../../src/lib/errors';

const execaMock = vi.hoisted(() => vi.fn());

vi.mock('execa', () => ({
  execa: execaMock,
}));

describe('skills command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('addSkills', () => {
    it('should add a specific skill', async () => {
      await addSkills(['dub-flow']);
      expect(execaMock).toHaveBeenCalledWith(
        'npx',
        ['skills', 'add', 'wiseiodev/dubstack/skills/dub-flow'],
        { stdio: 'inherit' },
      );
    });

    it('should add all skills if none specified', async () => {
      await addSkills([]);
      expect(execaMock).toHaveBeenCalledTimes(2);
      expect(execaMock).toHaveBeenCalledWith(
        'npx',
        ['skills', 'add', 'wiseiodev/dubstack/skills/dubstack'],
        { stdio: 'inherit' },
      );
      expect(execaMock).toHaveBeenCalledWith(
        'npx',
        ['skills', 'add', 'wiseiodev/dubstack/skills/dub-flow'],
        { stdio: 'inherit' },
      );
    });

    it('should support global flag', async () => {
      await addSkills(['dubstack'], { global: true });
      expect(execaMock).toHaveBeenCalledWith(
        'npx',
        ['skills', 'add', 'wiseiodev/dubstack/skills/dubstack', '--global'],
        { stdio: 'inherit' },
      );
    });

    it('should support dry-run', async () => {
      await addSkills(['dubstack'], { dryRun: true });
      expect(execaMock).not.toHaveBeenCalled();
    });

    it('should throw on invalid skill', async () => {
      await expect(addSkills(['invalid-skill'])).rejects.toThrow(DubError);
    });
  });

  describe('removeSkills', () => {
    it('should remove a specific skill', async () => {
      await removeSkills(['dub-flow']);
      expect(execaMock).toHaveBeenCalledWith(
        'npx',
        ['skills', 'remove', 'dub-flow'],
        { stdio: 'inherit' },
      );
    });

    it('should remove all skills if none specified', async () => {
      await removeSkills([]);
      expect(execaMock).toHaveBeenCalledTimes(2);
      expect(execaMock).toHaveBeenCalledWith(
        'npx',
        ['skills', 'remove', 'dubstack'],
        { stdio: 'inherit' },
      );
      expect(execaMock).toHaveBeenCalledWith(
        'npx',
        ['skills', 'remove', 'dub-flow'],
        { stdio: 'inherit' },
      );
    });

    it('should support global flag', async () => {
      await removeSkills(['dubstack'], { global: true });
      expect(execaMock).toHaveBeenCalledWith(
        'npx',
        ['skills', 'remove', 'dubstack', '--global'],
        { stdio: 'inherit' },
      );
    });

    it('should support dry-run', async () => {
      await removeSkills(['dubstack'], { dryRun: true });
      expect(execaMock).not.toHaveBeenCalled();
    });

    it('should throw on invalid skill', async () => {
      await expect(removeSkills(['invalid-skill'])).rejects.toThrow(DubError);
    });
  });
});
