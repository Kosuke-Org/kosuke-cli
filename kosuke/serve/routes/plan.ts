/**
 * Plan command SSE route
 */

import type { Request, Response } from 'express';
import type { PlanOptions } from '../../types.js';
import { planCoreStream } from '../../commands/plan.js';
import { parseToolAction } from '../../utils/claude-agent.js';
import type { PlanRequest } from '../validation/plan.js';
import { existsSync } from 'fs';

export async function planRoute(req: Request, res: Response): Promise<void> {
  // Request body is already validated by middleware
  const { query, cwd, noTest, resume } = req.body as PlanRequest;

  // Verify directory exists
  if (!existsSync(cwd)) {
    res.status(400).json({
      error: 'Invalid directory',
      message: `Directory does not exist: ${cwd}`,
    });
    return;
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const options: PlanOptions = {
      prompt: query,
      directory: cwd,
      noTest,
      resume,
    };

    const stream = planCoreStream(options);

    // Stream polished events (filter verbose content)
    for await (const event of stream) {
      if (event.type === 'message') {
        const msg = event.data;

        // Skip verbose tool results (file contents, grep results)
        if (msg.type === 'user' && 'tool_use_result' in msg) {
          continue; // Don't send file contents to client
        }

        // Skip system init (too verbose)
        if (msg.type === 'system' && msg.subtype === 'init') {
          continue;
        }

        // Send assistant messages (text and tool usage)
        if (msg.type === 'assistant') {
          const polishedMsg: Record<string, unknown> = {
            type: msg.type,
            session_id: msg.session_id,
          };

          // Extract text content
          const msgData = msg.message as {
            content?: Array<{
              type: string;
              text?: string;
              name?: string;
              input?: unknown;
            }>;
            usage?: unknown;
          };

          if (msgData.content && Array.isArray(msgData.content)) {
            for (const block of msgData.content) {
              if (block.type === 'text' && block.text) {
                polishedMsg.text = block.text;
              }
              if (block.type === 'tool_use' && block.name) {
                // Parse tool usage into structured action and params
                const toolInput = block.input as Record<string, unknown>;
                const parsed = parseToolAction(block.name, toolInput);

                polishedMsg.action = parsed.action;
                polishedMsg.params = parsed.params;
              }
            }
          }

          // Include token usage
          if (msgData.usage) {
            polishedMsg.usage = msgData.usage;
          }

          sendEvent('message', polishedMsg);
        }

        // Send result messages (final output with usage stats)
        if (msg.type === 'result') {
          const resultMsg = msg as {
            type: string;
            subtype?: string;
            result?: string;
            usage?: unknown;
          };

          sendEvent('message', {
            type: resultMsg.type,
            subtype: resultMsg.subtype,
            usage: resultMsg.usage,
          });
        }
      } else if (event.type === 'done') {
        // Send final result
        sendEvent('done', {
          status: event.data.status,
          ticketsFile: event.data.ticketsFile,
          tokensUsed: event.data.tokensUsed,
          cost: event.data.cost,
          sessionId: event.data.sessionId,
          error: event.data.error,
        });
      }
    }
  } catch (error) {
    sendEvent('done', {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    res.end();
  }
}
