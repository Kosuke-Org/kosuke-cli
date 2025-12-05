/**
 * Error handling middleware
 */

import type { Request, Response, NextFunction } from 'express';

/**
 * 404 handler for unknown routes
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
    availableRoutes: ['GET /health', 'POST /api/plan'],
  });
}

/**
 * Global error handler (must be registered last)
 */
export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  // JSON parsing errors
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      error: 'Invalid JSON',
      message: 'Request body contains invalid JSON syntax',
      details: err.message,
    });
    return;
  }

  // Generic error handler
  console.error('Server error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message || 'An unexpected error occurred',
  });
}
