import * as fs from 'node:fs';
import * as path from 'node:path';
import { execa } from 'execa';

export interface ConflictTestResult {
  status: 'none' | 'passed' | 'failed';
  files: string[];
  output?: string;
}

export interface VitestRunTarget {
  cwd: string;
  files: string[];
}

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[tj]sx?$/;
const SOURCE_FILE_RE = /\.[cm]?[tj]sx?$/;
const SKIP_DIRS = new Set([
  '.git',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
]);

export function findNearbyTests(file: string, cwd: string): string[] {
  if (!SOURCE_FILE_RE.test(file)) return [];

  const absoluteFile = path.resolve(cwd, file);
  if (!absoluteFile.startsWith(cwd + path.sep)) return [];

  const dir = path.dirname(absoluteFile);
  const parsed = path.parse(absoluteFile);
  const directCandidates = [
    path.join(dir, `${parsed.name}.test${parsed.ext}`),
    path.join(dir, `${parsed.name}.spec${parsed.ext}`),
  ];
  const tests = new Set<string>();

  for (const candidate of directCandidates) {
    if (fs.existsSync(candidate)) {
      tests.add(path.relative(cwd, candidate));
    }
  }

  const siblingTestsDir = path.join(dir, '__tests__');
  if (fs.existsSync(siblingTestsDir)) {
    for (const testFile of walkTestFiles(siblingTestsDir)) {
      tests.add(path.relative(cwd, testFile));
    }
  }

  for (const testFile of walkTestFiles(cwd)) {
    if (importsSourceFile(testFile, absoluteFile)) {
      tests.add(path.relative(cwd, testFile));
    }
  }

  return [...tests].sort();
}

export async function runNearbyTestsForFile(
  file: string,
  cwd: string,
): Promise<ConflictTestResult> {
  const tests = findNearbyTests(file, cwd);
  if (tests.length === 0) return { status: 'none', files: [] };
  const target = resolveVitestRunTarget(file, tests, cwd);

  try {
    await execa('pnpm', ['vitest', 'run', ...target.files], {
      cwd: target.cwd,
      all: true,
    });
    return { status: 'passed', files: tests };
  } catch (err) {
    const output =
      typeof err === 'object' && err !== null && 'all' in err
        ? String((err as { all?: string }).all ?? '')
        : err instanceof Error
          ? err.message
          : String(err);
    return { status: 'failed', files: tests, output };
  }
}

export function resolveVitestRunTarget(
  file: string,
  tests: string[],
  cwd: string,
): VitestRunTarget {
  const packageDir = findNearestVitestPackageDir(path.resolve(cwd, file), cwd);
  if (!packageDir) return { cwd, files: tests };

  return {
    cwd: packageDir,
    files: tests.map((test) =>
      path.relative(packageDir, path.resolve(cwd, test)),
    ),
  };
}

function walkTestFiles(root: string): string[] {
  const found: string[] = [];
  if (!fs.existsSync(root)) return found;

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkTestFiles(fullPath));
    } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      found.push(fullPath);
    }
  }

  return found;
}

function findNearestVitestPackageDir(
  absoluteFile: string,
  cwd: string,
): string | null {
  let current = fs.statSync(absoluteFile).isDirectory()
    ? absoluteFile
    : path.dirname(absoluteFile);

  for (;;) {
    const packageJsonPath = path.join(current, 'package.json');
    if (fs.existsSync(packageJsonPath) && packageUsesVitest(packageJsonPath)) {
      return current;
    }

    if (current === cwd || current === path.dirname(current)) return null;
    current = path.dirname(current);
  }
}

function packageUsesVitest(packageJsonPath: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(
      pkg.dependencies?.vitest ||
        pkg.devDependencies?.vitest ||
        Object.values(pkg.scripts ?? {}).some((script) =>
          script.includes('vitest'),
        ),
    );
  } catch {
    return false;
  }
}

function importsSourceFile(testFile: string, sourceFile: string): boolean {
  let content = '';
  try {
    content = fs.readFileSync(testFile, 'utf-8');
  } catch {
    return false;
  }

  const specifier = relativeImportSpecifier(path.dirname(testFile), sourceFile);
  return (
    content.includes(`'${specifier}'`) ||
    content.includes(`"${specifier}"`) ||
    content.includes(`\`${specifier}\``)
  );
}

function relativeImportSpecifier(fromDir: string, toFile: string): string {
  const parsed = path.parse(toFile);
  const withoutExtension = path.join(parsed.dir, parsed.name);
  let relative = path
    .relative(fromDir, withoutExtension)
    .replaceAll(path.sep, '/');
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return relative;
}
