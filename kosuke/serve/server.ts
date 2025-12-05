/**
 * Express server for Kosuke CLI commands over HTTP with SSE
 */

import express from 'express';
import { healthRoute } from './routes/health.js';
import { planRoute } from './routes/plan.js';
import { validateRequest } from './middleware/validation.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { planRequestSchema } from './validation/plan.js';

export interface ServeOptions {
  port?: number;
}

/**
 * Create and configure Express server
 */
export function createServer(): express.Express {
  const app = express();

  // Middleware
  app.use(express.json());

  // Routes
  app.get('/health', healthRoute);
  app.post('/api/plan', validateRequest(planRequestSchema), planRoute);

  // Error handlers (must be last)
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Start the Kosuke server
 */
export async function startServer(options: ServeOptions = {}): Promise<never> {
  const port = options.port || 3000;

  // Validate environment
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable is required');
  }

  const app = createServer();

  return new Promise((_, reject) => {
    const server = app.listen(port, () => {
      console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                         Kosuke Server Running                                ║
╚══════════════════════════════════════════════════════════════════════════════╝

🚀 Server listening on http://localhost:${port}

📡 Available endpoints:
   GET  /health        - Health check
   POST /api/plan      - Plan command with SSE

Press Ctrl+C to stop the server.
`);
    });

    server.on('error', (error) => {
      reject(error);
    });
  });
}
