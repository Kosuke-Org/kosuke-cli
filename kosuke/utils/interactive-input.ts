/**
 * Interactive CLI input utilities
 *
 * Provides consistent multi-line input handling across commands.
 * Works reliably in Docker and all terminal environments.
 */

/**
 * Ask a question with multi-line support
 *
 * Controls:
 * - Enter: Submit input
 * - Ctrl+J: New line (works in Docker)
 * - Ctrl+C: Exit
 * - Ctrl+D: Exit if empty
 * - Backspace: Delete character
 * - Tab: Insert 2 spaces
 *
 * @param prompt - The prompt to display (e.g., "You: ")
 * @returns The user's input (trimmed)
 */
export function askQuestion(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    let currentLine = '';
    let escapeBuffer = '';

    console.log('(Enter to submit, Ctrl+J for new line, Ctrl+C to exit)\n');
    process.stdout.write(prompt);

    // Store original stdin state
    const wasRaw = process.stdin.isRaw;

    // Enable raw mode to capture key combinations
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    // Remove existing listeners
    process.stdin.removeAllListeners('data');
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    const onData = (key: string) => {
      // Handle escape sequences (for Shift+Enter and other special keys)
      if (escapeBuffer.length > 0 || key === '\x1b') {
        escapeBuffer += key;

        // Check for Shift+Enter sequences
        // Common sequences: \x1b[13;2~ or \x1b\r or \x1bOM
        if (
          escapeBuffer === '\x1b\r' ||
          escapeBuffer === '\x1b\n' ||
          escapeBuffer.match(/\x1b\[13;2~/)
        ) {
          // Shift+Enter - add new line
          lines.push(currentLine);
          currentLine = '';
          process.stdout.write('\n' + ' '.repeat(prompt.length));
          escapeBuffer = '';
          return;
        }

        // If escape sequence is incomplete, wait for more
        if (escapeBuffer.length < 6) {
          return;
        }

        // Unknown escape sequence, ignore it
        escapeBuffer = '';
        return;
      }

      // Ctrl+C - exit
      if (key === '\u0003') {
        cleanup();
        process.exit(0);
      }

      // Ctrl+D (EOF)
      if (key === '\u0004') {
        if (currentLine === '' && lines.length === 0) {
          cleanup();
          resolve('');
          return;
        }
      }

      // Ctrl+J (linefeed) - new line (works in Docker)
      if (key === '\n') {
        lines.push(currentLine);
        currentLine = '';
        process.stdout.write('\n' + ' '.repeat(prompt.length));
        return;
      }

      // Regular Enter key (without Shift) - submit
      if (key === '\r') {
        if (currentLine.length > 0) {
          lines.push(currentLine);
        }
        process.stdout.write('\n');
        cleanup();
        resolve(lines.join('\n').trim());
        return;
      }

      // Backspace
      if (key === '\u007f' || key === '\b' || key === '\x08') {
        if (currentLine.length > 0) {
          currentLine = currentLine.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }

      // Tab - insert 2 spaces
      if (key === '\t') {
        currentLine += '  ';
        process.stdout.write('  ');
        return;
      }

      // Ignore other control characters (except printable ones)
      if (key.charCodeAt(0) < 32) {
        return;
      }

      // Regular character
      currentLine += key;
      process.stdout.write(key);
    };

    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(wasRaw || false);
      }
      process.stdin.pause();
    };

    process.stdin.on('data', onData);
  });
}
