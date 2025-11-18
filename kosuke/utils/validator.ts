/**
 * Code validation utilities (lint, typecheck, format)
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export interface ValidationResult {
  success: boolean;
  output?: string;
  error?: string;
  warning?: string;
}

interface PackageJson {
  scripts?: Record<string, string>;
}

/**
 * Detect package manager based on lock files
 */
export function detectPackageManager(cwd: string = process.cwd()): string {
  if (existsSync(join(cwd, 'bun.lockb'))) return 'bun';
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(cwd, 'package-lock.json'))) return 'npm';

  // Default to npm if no lock file found
  return 'npm';
}

/**
 * Read package.json and extract scripts
 */
export function readPackageJsonScripts(cwd: string = process.cwd()): PackageJson['scripts'] | null {
  const packageJsonPath = join(cwd, 'package.json');

  if (!existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const packageJson: PackageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.scripts || null;
  } catch (error) {
    console.warn(`⚠️  Failed to parse package.json: ${error}`);
    return null;
  }
}

/**
 * Run formatting using detected package manager and scripts
 */
export async function runFormat(): Promise<ValidationResult> {
  const cwd = process.cwd();
  const scripts = readPackageJsonScripts(cwd);

  if (!scripts) {
    return {
      success: false,
      error: 'package.json not found or has no scripts section',
    };
  }

  if (!scripts.format) {
    return {
      success: true,
      warning: `⚠️  No 'format' script found in package.json. Skipping formatting.\n💡 Hint: kosuke-template uses: "format": "prettier --write ."`,
    };
  }

  const packageManager = detectPackageManager(cwd);
  const command = `${packageManager} run format`;

  try {
    const output = execSync(command, {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return { success: true, output };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const errorMessage = err.stdout || err.stderr || err.message || '';

    return {
      success: false,
      error: `$ ${command}\n\n${errorMessage}`,
    };
  }
}

/**
 * Run linting using detected package manager and scripts
 */
export async function runLint(): Promise<ValidationResult> {
  const cwd = process.cwd();
  const scripts = readPackageJsonScripts(cwd);

  if (!scripts) {
    return {
      success: false,
      error: 'package.json not found or has no scripts section',
    };
  }

  if (!scripts.lint) {
    return {
      success: true,
      warning: `⚠️  No 'lint' script found in package.json. Skipping linting.\n💡 Hint: kosuke-template uses: "lint": "eslint . --ext .js,.jsx,.ts,.tsx --max-warnings 0"`,
    };
  }

  const packageManager = detectPackageManager(cwd);

  // Try to append --fix flag for auto-fixing
  // Note: This works with most linters (eslint, biome, etc.)
  const command = `${packageManager} run lint -- --fix`;

  try {
    const output = execSync(command, {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return { success: true, output };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const errorMessage = err.stdout || err.stderr || err.message || '';

    return {
      success: false,
      error: `$ ${command}\n\n${errorMessage}`,
    };
  }
}

/**
 * Run TypeScript type checking using detected package manager
 */
export async function runTypecheck(): Promise<ValidationResult> {
  const cwd = process.cwd();
  const scripts = readPackageJsonScripts(cwd);

  if (!scripts) {
    return {
      success: false,
      error: 'package.json not found or has no scripts section',
    };
  }

  if (!scripts.typecheck) {
    return {
      success: true,
      warning: `⚠️  No 'typecheck' script found in package.json. Skipping type checking.\n💡 Hint: kosuke-template uses: "typecheck": "tsc --noEmit"`,
    };
  }

  const packageManager = detectPackageManager(cwd);
  const command = `${packageManager} run typecheck`;

  try {
    const output = execSync(command, {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return { success: true, output };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const errorMessage = err.stdout || err.stderr || err.message || '';

    return {
      success: false,
      error: `$ ${command}\n\n${errorMessage}`,
    };
  }
}
