/**
 * Health check route
 */

import type { Request, Response } from 'express';

export function healthRoute(_req: Request, res: Response): void {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
}
