/**
 * Playwright MCP Client
 * Connects to Playwright MCP server and provides tools to Claude SDK
 */

import type Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

interface PlaywrightMCPConfig {
  port?: number;
  verbose?: boolean;
  trace?: boolean; // Enable tracing capability (--caps=tracing)
}

interface MCPToolCall {
  name: string;
  input: Record<string, unknown>;
  timestamp: number;
}

export class PlaywrightMCPClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private mcpTools: Anthropic.Tool[] = [];
  private toolCalls: MCPToolCall[] = [];

  /**
   * Initialize connection to Playwright MCP server
   */
  async connect(config: PlaywrightMCPConfig = {}): Promise<void> {
    const { port, verbose, trace } = config;

    try {
      // Start MCP client with stdio transport
      const args: string[] = [];
      if (port) {
        args.push('--port', port.toString());
      }
      if (trace) {
        args.push('--caps=tracing');
      }

      this.transport = new StdioClientTransport({
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest', ...args],
      });

      this.client = new Client(
        {
          name: 'kosuke-playwright-mcp-client',
          version: '1.0.0',
        },
        {
          capabilities: {},
        }
      );

      await this.client.connect(this.transport);

      if (verbose) {
        console.log('✅ Connected to Playwright MCP server');
      }

      // Get available tools from MCP server
      const toolsResponse = await this.client.listTools();

      // Convert MCP tools to Anthropic SDK format
      this.mcpTools = toolsResponse.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
      }));

      if (verbose) {
        console.log(`📦 Loaded ${this.mcpTools.length} MCP tools`);
      }
    } catch (error) {
      throw new Error(
        `Failed to connect to Playwright MCP server.\n\n` +
          `Make sure the server is running:\n` +
          `  npx @playwright/mcp@latest\n\n` +
          `Error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get MCP tools in Anthropic SDK format
   */
  getTools(): Anthropic.Tool[] {
    return this.mcpTools;
  }

  /**
   * Execute MCP tool call
   */
  async executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    if (!this.client) {
      throw new Error('MCP client not connected');
    }

    // Track tool call
    this.toolCalls.push({
      name,
      input,
      timestamp: Date.now(),
    });

    // Execute via MCP
    const response = await this.client.callTool({
      name,
      arguments: input,
    });

    return response.content;
  }

  /**
   * Get tool usage statistics
   */
  getToolUsage(): {
    navigations: number;
    clicks: number;
    types: number;
    extracts: number;
    other: number;
    total: number;
  } {
    const usage = {
      navigations: 0,
      clicks: 0,
      types: 0,
      extracts: 0,
      other: 0,
    };

    for (const call of this.toolCalls) {
      if (call.name.includes('navigate')) {
        usage.navigations++;
      } else if (call.name.includes('click')) {
        usage.clicks++;
      } else if (call.name.includes('type') || call.name.includes('fill')) {
        usage.types++;
      } else if (call.name.includes('extract') || call.name.includes('get')) {
        usage.extracts++;
      } else {
        usage.other++;
      }
    }

    return {
      ...usage,
      total: this.toolCalls.length,
    };
  }

  /**
   * Close MCP connection
   */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
    }
    this.client = null;
    this.transport = null;
  }
}
