/**
 * Generic validation middleware
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

/**
 * Generic validation middleware factory
 *
 * Validates request body against a Zod schema and returns 400 if invalid.
 * Replaces req.body with validated data on success.
 */
export function validateRequest(schema: z.ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const result = schema.safeParse(req.body);

      if (!result.success) {
        // Format Zod errors into readable format
        const errors = result.error.issues.map((err) => ({
          field: err.path.join('.'),
          message: err.message,
        }));

        res.status(400).json({
          error: 'Validation Error',
          message: 'Request validation failed',
          details: errors,
        });
        return;
      }

      // Replace req.body with validated data
      req.body = result.data;
      next();
    } catch (error) {
      res.status(500).json({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };
}
