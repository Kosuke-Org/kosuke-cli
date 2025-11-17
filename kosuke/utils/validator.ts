/**
 * Code validation utilities (lint, typecheck)
 */

import { execSync } from 'child_process';

interface ValidationResult {
  success: boolean;
  output?: string;
  error?: string;
}

/**
 * Run ESLint with auto-fix
 */
export async function runLint(): Promise<ValidationResult> {
  try {
    // First try with --fix flag to auto-fix issues
    const output = execSync('bun run lint -- --fix', {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return { success: true, output };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const errorMessage = err.stdout || err.stderr || err.message || '';

    // Check if this is just an eslint command not found issue
    if (errorMessage.includes('eslint: command not found')) {
      return {
        success: false,
        error: `$ bun run lint -- --fix\n\n${errorMessage}\n\n⚠️  Hint: Your project's lint script should use 'npx eslint' instead of just 'eslint'.\nExample: "lint": "npx eslint . --ext .js,.jsx,.ts,.tsx --max-warnings 0"`,
      };
    }

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Run TypeScript type checking
 */
export async function runTypecheck(): Promise<ValidationResult> {
  try {
    const output = execSync('bun run typecheck', {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return { success: true, output };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      error: err.stdout || err.stderr || err.message,
    };
  }
}

/**
 * Run formatting
 */
export async function runFormat(): Promise<ValidationResult> {
  try {
    const output = execSync('bun run format', {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return { success: true, output };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      error: err.stdout || err.stderr || err.message,
    };
  }
}
