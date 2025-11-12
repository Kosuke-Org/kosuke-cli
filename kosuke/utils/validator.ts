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
    const output = execSync('bun run lint --fix', {
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
