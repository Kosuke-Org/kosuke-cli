/**
 * Plan command validation schemas
 */

import { z } from 'zod';

/**
 * Plan request validation schema
 *
 */
export const planRequestSchema = z.object({
  query: z.string().min(1, 'Query cannot be empty'),
  cwd: z.string().min(1, 'Working directory is required'),
  noTest: z.boolean().optional(),
  resume: z.string().optional(),
});

export type PlanRequest = z.infer<typeof planRequestSchema>;
