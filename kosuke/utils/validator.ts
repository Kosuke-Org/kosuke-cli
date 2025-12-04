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
export async function runFormat(cwd: string = process.cwd()): Promise<ValidationResult> {
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
export async function runLint(cwd: string = process.cwd()): Promise<ValidationResult> {
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
export async function runTypecheck(cwd: string = process.cwd()): Promise<ValidationResult> {
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

/**
 * Run tests using package.json test script
 */
export async function runTests(cwd: string = process.cwd()): Promise<ValidationResult> {
  const scripts = readPackageJsonScripts(cwd);

  if (!scripts || !scripts.test) {
    return {
      success: true,
      warning: '⚠️  No test script found in package.json. Skipping tests.',
    };
  }

  const packageManager = detectPackageManager(cwd);
  const command = `${packageManager} run test`;

  try {
    const output = execSync(command, {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return { success: true, output };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      error: `$ ${command}\n\n${err.stdout || err.stderr || err.message}`,
    };
  }
}

interface ValidationStep {
  name: string;
  run: () => Promise<ValidationResult>;
}

/**
 * Run comprehensive linting and fixing
 */
export async function runComprehensiveLinting(
  cwd: string = process.cwd()
): Promise<{ success: boolean; fixCount: number }> {
  console.log('\n🔍 Running comprehensive code quality checks...\n');

  const validationSteps: ValidationStep[] = [
    { name: '🎨 Format', run: () => runFormat(cwd) },
    { name: '🔍 Lint', run: () => runLint(cwd) },
    { name: '🔎 TypeCheck', run: () => runTypecheck(cwd) },
    { name: '🧪 Tests', run: () => runTests(cwd) },
  ];

  let totalFixCount = 0;

  // Run each validation step
  for (const step of validationSteps) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Running: ${step.name}`);
    console.log(`${'='.repeat(60)}\n`);

    let result = await step.run();

    // Handle warnings (non-blocking)
    if (result.warning) {
      console.log(result.warning);
      console.log(`✅ ${step.name} - SKIPPED\n`);
      continue;
    }

    // Handle success
    if (result.success) {
      console.log(`✅ ${step.name} - PASSED\n`);
      continue;
    }

    // Handle errors - attempt to fix
    console.log(`❌ ${step.name} - FAILED:\n`);
    console.log(result.error);

    // Attempt to fix errors with Claude (max 3 attempts per step)
    let attemptCount = 0;
    const maxAttempts = 3;

    while (!result.success && attemptCount < maxAttempts) {
      attemptCount++;

      console.log(`\n${'='.repeat(60)}`);
      console.log(`🔄 ${step.name} Fix Attempt ${attemptCount}/${maxAttempts}`);
      console.log(`${'='.repeat(60)}`);

      const { fixCodeQualityErrors } = await import('../commands/lint.js');
      const fixApplied = await fixCodeQualityErrors(step.name, result.error || '', cwd);

      if (!fixApplied) {
        console.log(`\n⚠️  No fixes were applied by Claude for ${step.name}`);
        break;
      }

      totalFixCount++;

      // Verify fixes by running validation again
      console.log(`\n🔍 Verifying ${step.name} fixes...\n`);
      result = await step.run();

      if (result.success) {
        console.log(`✅ ${step.name} - All errors fixed!\n`);
        break;
      } else {
        const errorLines = result.error?.split('\n').length || 0;
        console.log(`\n⚠️  Some ${step.name} errors remain (${errorLines} lines):`);
        console.log(result.error);
      }
    }

    // Check if step still has errors after attempts
    if (!result.success) {
      throw new Error(`${step.name} errors remain after ${maxAttempts} attempts. Cannot proceed.`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ All validation steps passed!');
  console.log('='.repeat(60));

  return { success: true, fixCount: totalFixCount };
}
