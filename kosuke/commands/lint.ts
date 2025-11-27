/**
 * Lint command - Comprehensive code quality validation and fixing
 *
 * Strategy: Run all validation steps (format, lint, typecheck, test, knip),
 * give errors to Claude, let it fix them
 */

import { execSync } from 'child_process';
import type { LintOptions } from '../types.js';
import { runAgent } from '../utils/claude-agent.js';
import { runWithPR } from '../utils/pr-orchestrator.js';
import {
  detectPackageManager,
  readPackageJsonScripts,
  runFormat,
  runLint,
  runTypecheck,
} from '../utils/validator.js';

interface ValidationStep {
  name: string;
  run: () => Promise<{ success: boolean; error?: string; warning?: string; output?: string }>;
  fixable: boolean; // Can Claude attempt to fix this?
}

interface LintFixResult {
  success: boolean;
  attempts: number;
  fixesApplied: number;
  stepsFixed: string[];
}

/**
 * Run tests using package.json test script
 */
async function runTests(cwd: string = process.cwd()): Promise<{
  success: boolean;
  error?: string;
  warning?: string;
  output?: string;
}> {
  const { readPackageJsonScripts, detectPackageManager } = await import('../utils/validator.js');

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

/**
 * Run knip to check for unused exports
 */
async function runKnip(cwd: string = process.cwd()): Promise<{
  success: boolean;
  error?: string;
  warning?: string;
  output?: string;
}> {
  const { readPackageJsonScripts, detectPackageManager } = await import('../utils/validator.js');

  const scripts = readPackageJsonScripts(cwd);
  if (!scripts || !scripts.knip) {
    return {
      success: true,
      warning: '⚠️  No knip script found in package.json. Skipping knip check.',
    };
  }

  const packageManager = detectPackageManager(cwd);
  const command = `${packageManager} run knip`;

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

/**
 * Build command-specific system prompt for fixing errors
 */
function buildFixSystemPrompt(stepName: string, cwd: string): string {
  const packageManager = detectPackageManager(cwd);
  const scripts = readPackageJsonScripts(cwd);

  // Map step names to commands
  const commandMap: Record<string, string> = {
    '🎨 Format': scripts?.format ? `${packageManager} run format` : 'prettier --write .',
    '🔍 Lint': scripts?.lint ? `${packageManager} run lint` : 'eslint . --fix',
    '🔎 TypeCheck': scripts?.typecheck ? `${packageManager} run typecheck` : 'tsc --noEmit',
    '🧪 Tests': scripts?.test ? `${packageManager} run test` : '',
    '🔪 Knip': scripts?.knip ? `${packageManager} run knip` : '',
  };

  const fixCommand = commandMap[stepName] || '';

  const commandGuidance = fixCommand
    ? `\n\n**Available Commands:**
- Package Manager: ${packageManager}
- Fix Command: \`${fixCommand}\`
- You can run this command to verify your fixes, but you MUST fix the issues in the code files first.
`
    : '';

  return `You are a code quality expert specialized in fixing ${stepName} errors.

Your task is to analyze errors and fix them according to the project's quality standards.
${commandGuidance}
**CRITICAL REQUIREMENTS:**
- You MUST use the search_replace or write tools to fix ALL errors
- Simply identifying issues without fixing them is NOT acceptable
- Focus ONLY on fixing the specific errors provided. Do not make unnecessary changes.
- Follow the project's coding guidelines (CLAUDE.md will be loaded automatically)
- Use ${packageManager} commands (NOT npm) if you need to run any commands
- Make minimal, surgical fixes - don't refactor unrelated code`;
}

/**
 * Run Claude to fix code quality errors
 * Exported so other commands can use it
 */
export async function fixCodeQualityErrors(
  stepName: string,
  errors: string,
  cwd: string = process.cwd()
): Promise<boolean> {
  console.log(`\n🤖 Using Claude to fix ${stepName} errors...\n`);

  // Build command-specific system prompt
  const systemPrompt = buildFixSystemPrompt(stepName, cwd);

  // User prompt
  const promptText = `The following ${stepName} errors need to be fixed:

\`\`\`
${errors}
\`\`\`

**Your task:**
1. Analyze each error carefully
2. Read the files that have errors
3. **IMMEDIATELY FIX each error using search_replace or write tools**
4. Make minimal changes - only fix what's broken
5. Ensure your fixes don't introduce new issues
6. Follow the project's coding guidelines

**IMPORTANT:**
- Don't just describe errors - FIX them!
- Every error you identify MUST be fixed
- Use the project's coding standards

Start by reading the files with errors and fixing them one by one.`;

  try {
    const result = await runAgent(promptText, {
      systemPrompt,
      maxTurns: 20,
      cwd,
      verbosity: 'normal',
    });

    console.log(`\n✨ Claude completed (${result.fixCount} fixes applied)`);
    return result.fixCount > 0;
  } catch (error) {
    console.error('\n❌ Error during Claude fixing:', error);
    return false;
  }
}

/**
 * Legacy export for backward compatibility
 */
export async function fixLintErrors(
  lintErrors: string,
  cwd: string = process.cwd()
): Promise<boolean> {
  return fixCodeQualityErrors('linting', lintErrors, cwd);
}

/**
 * Core comprehensive validation and fixing logic (git-agnostic)
 * Used internally by lintCommand
 */
async function fixLintErrorsCore(cwd: string = process.cwd()): Promise<LintFixResult> {
  console.log('🔍 Running comprehensive code quality checks...\n');

  // Define all validation steps
  const validationSteps: ValidationStep[] = [
    { name: '🎨 Format', run: () => runFormat(cwd), fixable: true },
    { name: '🔍 Lint', run: () => runLint(cwd), fixable: true },
    { name: '🔎 TypeCheck', run: () => runTypecheck(cwd), fixable: true },
    { name: '🧪 Tests', run: () => runTests(cwd), fixable: true },
    { name: '🔪 Knip', run: () => runKnip(cwd), fixable: true },
  ];

  const stepsFixed: string[] = [];
  let totalAttempts = 0;
  let totalFixes = 0;

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

    // Handle errors
    console.log(`❌ ${step.name} - FAILED:\n`);
    console.log(result.error);

    if (!step.fixable) {
      console.log(`\n⚠️  ${step.name} errors cannot be auto-fixed by Claude`);
      throw new Error(`${step.name} validation failed`);
    }

    // Attempt to fix errors with Claude (max 3 attempts per step)
    let attemptCount = 0;
    const maxAttempts = 3;

    while (!result.success && attemptCount < maxAttempts) {
      attemptCount++;
      totalAttempts++;

      console.log(`\n${'='.repeat(60)}`);
      console.log(`🔄 ${step.name} Fix Attempt ${attemptCount}/${maxAttempts}`);
      console.log(`${'='.repeat(60)}`);

      const fixApplied = await fixCodeQualityErrors(step.name, result.error || '', cwd);

      if (!fixApplied) {
        console.log(`\n⚠️  No fixes were applied by Claude for ${step.name}`);
        break;
      }

      totalFixes++;

      // Verify fixes by running validation again
      console.log(`\n🔍 Verifying ${step.name} fixes...\n`);
      result = await step.run();

      if (result.success) {
        console.log(`✅ ${step.name} - All errors fixed!\n`);
        stepsFixed.push(step.name);
        break;
      } else {
        const errorLines = result.error?.split('\n').length || 0;
        console.log(`\n⚠️  Some ${step.name} errors remain (${errorLines} lines):`);
        console.log(result.error);
      }
    }

    // Check if step still has errors after attempts
    if (!result.success) {
      console.error(`\n❌ Could not fix all ${step.name} errors after ${maxAttempts} attempts`);
      console.log('\nRemaining errors:');
      console.log(result.error);
      throw new Error(`${step.name} errors remain after maximum attempts`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ All validation steps passed!');
  console.log('='.repeat(60));

  return {
    success: true,
    attempts: totalAttempts,
    fixesApplied: totalFixes,
    stepsFixed,
  };
}

/**
 * Main lint command (now runs comprehensive validation)
 */
export async function lintCommand(options: LintOptions = {}): Promise<void> {
  console.log('🚀 Starting Kosuke Code Quality Check & Fix...\n');

  try {
    // Validate environment
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    // Resolve directory
    const { resolve } = await import('path');
    const { existsSync, statSync } = await import('fs');
    const cwd = options.directory ? resolve(options.directory) : process.cwd();

    // Validate directory if provided
    if (options.directory) {
      if (!existsSync(cwd)) {
        throw new Error(
          `Directory not found: ${cwd}\n` +
            `Please provide a valid directory using --directory=<path>\n` +
            `Example: kosuke lint --directory=./my-project`
        );
      }

      const stats = statSync(cwd);
      if (!stats.isDirectory()) {
        throw new Error(
          `Path is not a directory: ${cwd}\n` + `Please provide a valid directory path.`
        );
      }

      console.log(`📁 Using project directory: ${cwd}\n`);
    }

    // If --pr flag is provided, wrap with PR workflow
    if (options.pr) {
      const { result: fixResult, prInfo } = await runWithPR(
        {
          branchPrefix: 'fix/kosuke-quality',
          baseBranch: options.baseBranch,
          commitMessage: 'chore: fix code quality issues',
          prTitle: 'chore: Fix code quality issues',
          prBody: `## 🔧 Automated Code Quality Fixes

This PR contains automated fixes for code quality issues detected by comprehensive validation.

### 📋 Validation Steps Performed
- 🎨 **Format**: Code formatting check
- 🔍 **Lint**: ESLint validation
- 🔎 **TypeCheck**: TypeScript type checking
- 🧪 **Tests**: Unit/integration tests
- 🔪 **Knip**: Unused exports detection

### ✅ Result
All validation steps passed! Code quality issues have been automatically fixed by Claude.

---

🤖 *Generated by Kosuke CLI (\`kosuke lint --pr\`)*`,
          cwd,
        },
        () => fixLintErrorsCore(cwd)
      );

      console.log('\n✅ Code quality check complete!');
      console.log(`📊 Attempts: ${fixResult.attempts}`);
      console.log(`🔧 Fixes applied: ${fixResult.fixesApplied}`);
      if (fixResult.stepsFixed.length > 0) {
        console.log(`🎯 Steps fixed: ${fixResult.stepsFixed.join(', ')}`);
      }
      console.log(`🔗 PR: ${prInfo.prUrl}`);
    } else {
      // Run core logic without PR
      const result = await fixLintErrorsCore(cwd);

      console.log('\n✅ Code quality check complete!');
      console.log(`📊 Attempts: ${result.attempts}`);
      console.log(`🔧 Fixes applied: ${result.fixesApplied}`);
      if (result.stepsFixed.length > 0) {
        console.log(`🎯 Steps fixed: ${result.stepsFixed.join(', ')}`);
      }
      console.log('\nℹ️  Changes applied locally. Use --pr flag to create a pull request.');
    }
  } catch (error) {
    console.error('\n❌ Code quality check failed:', error);
    throw error;
  }
}
