/**
 * Granular Test Executor - Execute standalone Stagehand test scripts
 *
 * Executes complete, self-contained TypeScript scripts that include
 * their own imports, initialization, and cleanup logic.
 */

import { spawn } from 'child_process';

interface ExecutionResult {
  success: boolean;
  output: string;
  errors: string[];
  extractedData: Record<string, unknown>[];
  logs?: string; // Full stdout/stderr logs for error analysis
}

/**
 * Execute standalone test script via tsx subprocess
 *
 * Runs the script with tsx and captures all stdout/stderr output.
 * This allows us to capture Stagehand's verbose logs for error analysis.
 */
export async function executeGranularScript(
  scriptPath: string,
  verbose: boolean
): Promise<ExecutionResult> {
  return new Promise((resolve) => {
    console.log('🎬 Executing test script...\n');

    if (verbose) {
      console.log(`📄 Script: ${scriptPath}\n`);
    }

    // Capture all output (stdout + stderr)
    let allLogs = '';
    let stdoutOutput = '';
    let stderrOutput = '';

    // Run script via tsx (TypeScript executor)
    const child = spawn('npx', ['tsx', scriptPath], {
      env: process.env,
      cwd: process.cwd(),
    });

    // Capture stdout
    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdoutOutput += text;
      allLogs += text;

      // Echo to console for real-time visibility
      process.stdout.write(text);
    });

    // Capture stderr
    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderrOutput += text;
      allLogs += text;

      // Echo to console for real-time visibility
      process.stderr.write(text);
    });

    // Handle completion
    child.on('close', (code) => {
      const success = code === 0;

      if (success) {
        console.log('\n✅ Script execution completed successfully\n');
        resolve({
          success: true,
          output: stdoutOutput,
          errors: [],
          extractedData: [],
          logs: allLogs,
        });
      } else {
        // Extract error from logs
        const errorLines = stderrOutput
          .split('\n')
          .filter(
            (line) => line.includes('Error:') || line.includes('❌') || line.includes('failed')
          );

        const errorMessage =
          errorLines.length > 0 ? errorLines.join('\n') : `Script exited with code ${code}`;

        console.error(`\n❌ Script execution failed (exit code ${code})\n`);

        resolve({
          success: false,
          output: stdoutOutput,
          errors: [errorMessage],
          extractedData: [],
          logs: allLogs,
        });
      }
    });

    // Handle spawn errors
    child.on('error', (error) => {
      console.error(`\n❌ Failed to spawn test script: ${error.message}\n`);
      resolve({
        success: false,
        output: '',
        errors: [error.message],
        extractedData: [],
        logs: allLogs || error.message,
      });
    });
  });
}
