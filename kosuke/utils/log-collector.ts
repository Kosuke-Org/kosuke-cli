/**
 * Log Collector - Collect logs from multiple sources
 *
 * Collects and aggregates logs from:
 * - Browser console (errors, warnings)
 * - Network requests (failed requests, status codes)
 * - Docker Compose logs (backend logs)
 * - Playwright traces
 */

import { execSync } from 'child_process';
import type { Page, Response } from '@playwright/test';

export interface ConsoleLog {
  type: 'error' | 'warning' | 'info';
  message: string;
  timestamp: Date;
  location?: string;
}

export interface NetworkLog {
  url: string;
  method: string;
  status: number;
  statusText: string;
  timestamp: Date;
  responseBody?: string;
  requestBody?: string;
}

export interface DockerLog {
  service: string;
  message: string;
  timestamp: Date;
}

export interface CollectedLogs {
  console: ConsoleLog[];
  network: NetworkLog[];
  docker: DockerLog[];
}

/**
 * Log collector class that attaches to a Playwright page
 */
export class LogCollector {
  private consoleLogs: ConsoleLog[] = [];
  private networkLogs: NetworkLog[] = [];
  private dockerLogs: DockerLog[] = [];
  private page: Page | null = null;

  /**
   * Attach log collectors to a Playwright page
   */
  attach(page: Page): void {
    this.page = page;
    this.attachConsoleListener(page);
    this.attachNetworkListener(page);
  }

  /**
   * Attach console listener
   */
  private attachConsoleListener(page: Page): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page.on('console', (msg: any) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning' || type === 'info') {
        this.consoleLogs.push({
          type: type as 'error' | 'warning' | 'info',
          message: msg.text(),
          timestamp: new Date(),
          location: msg.location()?.url,
        });
      }
    });

    // Also capture page errors
    page.on('pageerror', (error: Error) => {
      this.consoleLogs.push({
        type: 'error',
        message: error.message,
        timestamp: new Date(),
      });
    });
  }

  /**
   * Attach network listener
   */
  private attachNetworkListener(page: Page): void {
    page.on('response', async (response: Response) => {
      const status = response.status();

      // Only log failed requests or important status codes
      if (status >= 400 || status === 0) {
        let responseBody: string | undefined;
        let requestBody: string | undefined;

        try {
          // Try to get response body (might fail for non-text responses)
          responseBody = await response.text();
        } catch {
          // Ignore if we can't get the body
        }

        try {
          // Try to get request body
          const request = response.request();
          const postData = request.postData();
          if (postData) {
            requestBody = postData;
          }
        } catch {
          // Ignore if we can't get request data
        }

        this.networkLogs.push({
          url: response.url(),
          method: response.request().method(),
          status,
          statusText: response.statusText(),
          timestamp: new Date(),
          responseBody,
          requestBody,
        });
      }
    });

    // Capture request failures
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page.on('requestfailed', (request: any) => {
      this.networkLogs.push({
        url: request.url(),
        method: request.method(),
        status: 0,
        statusText: request.failure()?.errorText || 'Request failed',
        timestamp: new Date(),
      });
    });
  }

  /**
   * Collect Docker Compose logs
   */
  async collectDockerLogs(since: string = '30s'): Promise<void> {
    try {
      // Check if docker compose is available
      try {
        execSync('docker compose version', { stdio: 'ignore' });
      } catch {
        console.log('   ℹ️  Docker Compose not available, skipping backend logs');
        return;
      }

      // Get logs from all services
      const logs = execSync(`docker compose logs --tail=100 --since=${since} --no-color`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'], // Ignore stderr
      });

      // Parse logs
      const lines = logs.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;

        // Docker compose log format: service-name | message
        const match = line.match(/^([a-zA-Z0-9_-]+)\s+\|\s+(.+)$/);
        if (match) {
          const [, service, message] = match;
          this.dockerLogs.push({
            service: service.trim(),
            message: message.trim(),
            timestamp: new Date(),
          });
        } else {
          // Fallback: just store the line as-is
          this.dockerLogs.push({
            service: 'unknown',
            message: line,
            timestamp: new Date(),
          });
        }
      }
    } catch (error) {
      console.log('   ⚠️  Failed to collect Docker logs:', error);
      // Don't throw - backend logs are optional
    }
  }

  /**
   * Get all collected logs
   */
  getLogs(): CollectedLogs {
    return {
      console: this.consoleLogs,
      network: this.networkLogs,
      docker: this.dockerLogs,
    };
  }

  /**
   * Get only error logs
   */
  getErrors(): CollectedLogs {
    return {
      console: this.consoleLogs.filter((log) => log.type === 'error'),
      network: this.networkLogs.filter((log) => log.status >= 400 || log.status === 0),
      docker: this.dockerLogs.filter(
        (log) =>
          log.message.toLowerCase().includes('error') ||
          log.message.toLowerCase().includes('exception') ||
          log.message.toLowerCase().includes('failed')
      ),
    };
  }

  /**
   * Check if there are any errors
   */
  hasErrors(): boolean {
    const errors = this.getErrors();
    return errors.console.length > 0 || errors.network.length > 0 || errors.docker.length > 0;
  }

  /**
   * Format logs as human-readable text
   */
  formatLogs(logs: CollectedLogs): string {
    const sections: string[] = [];

    // Console logs
    if (logs.console.length > 0) {
      sections.push('=== Console Logs ===');
      for (const log of logs.console) {
        const location = log.location ? ` (${log.location})` : '';
        sections.push(`[${log.type.toUpperCase()}]${location} ${log.message}`);
      }
    }

    // Network logs
    if (logs.network.length > 0) {
      sections.push('\n=== Network Logs ===');
      for (const log of logs.network) {
        sections.push(`[${log.method}] ${log.url} - ${log.status} ${log.statusText}`);
        if (log.requestBody) {
          sections.push(`  Request: ${log.requestBody.substring(0, 200)}`);
        }
        if (log.responseBody) {
          sections.push(`  Response: ${log.responseBody.substring(0, 200)}`);
        }
      }
    }

    // Docker logs
    if (logs.docker.length > 0) {
      sections.push('\n=== Docker Compose Logs ===');
      for (const log of logs.docker) {
        sections.push(`[${log.service}] ${log.message}`);
      }
    }

    return sections.join('\n');
  }

  /**
   * Clear all collected logs
   */
  clear(): void {
    this.consoleLogs = [];
    this.networkLogs = [];
    this.dockerLogs = [];
  }
}
