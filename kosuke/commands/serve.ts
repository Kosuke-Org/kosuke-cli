/**
 * Serve command - HTTP server for Kosuke CLI commands
 */

import type { ServeOptions } from '../serve/server.js';
import { startServer } from '../serve/server.js';

/**
 * Main serve command
 */
export async function serveCommand(options: ServeOptions = {}): Promise<void> {
  try {
    await startServer(options);
  } catch (error) {
    console.error('\n❌ Serve command failed:', error);
    throw error;
  }
}
