/**
 * Migrate command - Apply database migrations with automatic validation
 *
 * Uses Claude Code Agent to:
 * 1. Apply Drizzle migrations to database (db:migrate)
 * 2. Seed database with initial data (db:seed)
 * 3. Validate migrations applied successfully
 *
 * NOTE: This command does NOT generate migrations (ship handles that)
 *
 * Usage:
 *   kosuke migrate                                 # Apply migrations in current dir
 *   kosuke migrate --directory=./my-app           # Apply in specific project
 *   kosuke migrate --db-url=postgres://...        # Custom database URL
 *
 * Programmatic (from build):
 *   const result = await migrateCore({
 *     directory: cwd,
 *     dbUrl,
 *     context: { ticketId, ticketTitle, ticketDescription }
 *   });
 */

import { existsSync, statSync } from 'fs';
import { resolve } from 'path';
import type { MigrateOptions, MigrateResult } from '../types.js';
import { formatCostBreakdown, runAgent } from '../utils/claude-agent.js';
import { logger, setupCancellationHandler } from '../utils/logger.js';

/**
 * Build system prompt for database migration and validation
 */
function buildMigrationPrompt(dbUrl: string, context?: MigrateOptions['context']): string {
  return `You are a database migration specialist.

**Your Task:**
Apply database migrations and validate schema changes.

${context ? `**Context:**\nApplying migrations for ticket ${context.ticketId}: ${context.ticketTitle}\n` : ''}

**Migration Process (Execute in Order):**

1. **Apply Migrations to Database**
   - Run: \`POSTGRES_URL="${dbUrl}" bun run db:migrate\`
   - This applies pending migrations to the database
   - ⚠️ CRITICAL: Migrations MUST succeed - fail immediately if errors occur
   - Report any migration errors clearly

2. **Seed Database**
   - Run: \`POSTGRES_URL="${dbUrl}" bun run db:seed\`
   - Seeds initial data if seed file exists
   - If seed file doesn't exist, this is OK (not an error)

3. **Validate Migration Success**
   - Connect to the database using the POSTGRES_URL
   - Query the database to verify expected tables exist
   - Check that schema changes were applied correctly
   - Use: \`POSTGRES_URL="${dbUrl}" psql -c "\\dt"\` to list tables
   - Or write a Node.js script to validate schema

**Success Criteria:**
- db:migrate completes without errors
- db:seed runs (success if no seed file is also OK)
- Database validation confirms tables exist and schema is correct

**Failure Handling:**
- If db:migrate fails → Report error and STOP immediately
- If validation fails → Report which tables/schema are missing

Begin by applying migrations and validating the results.`;
}

/**
 * Core migrate logic (reusable)
 * Applies migrations, seeds database, and validates schema changes
 */
export async function migrateCore(options: MigrateOptions): Promise<MigrateResult> {
  const {
    directory,
    dbUrl = 'postgres://postgres:postgres@localhost:5432/postgres',
    context,
  } = options;

  // 1. Validate and resolve directory
  const cwd = directory ? resolve(directory) : process.cwd();

  if (directory) {
    if (!existsSync(cwd)) {
      throw new Error(
        `Directory not found: ${cwd}\n` +
          `Please provide a valid directory using --directory=<path>\n` +
          `Example: migrateCore({ directory: './my-project' })`
      );
    }

    const stats = statSync(cwd);
    if (!stats.isDirectory()) {
      throw new Error(
        `Path is not a directory: ${cwd}\n` + `Please provide a valid directory path.`
      );
    }

    console.log(`📁 Using project directory: ${cwd}\n`);
  }

  console.log(`🗄️  Applying database migrations...\n`);
  console.log(`📊 Database URL: ${dbUrl.replace(/:[^:@]+@/, ':****@')}\n`); // Hide password

  try {
    // 2. Run migration and validation with Claude Code Agent
    const systemPrompt = buildMigrationPrompt(dbUrl, context);

    const result = await runAgent('Apply database migrations and validate schema', {
      systemPrompt,
      cwd,
      maxTurns: 20,
      verbosity: 'normal',
    });

    console.log(`\n✨ Migration process completed`);
    console.log(`💰 Migration cost: ${formatCostBreakdown(result)}`);

    // 3. Parse agent output to determine success
    // Success indicators: "migration" + "success" or "applied" in response
    const response = result.response.toLowerCase();
    const migrationsApplied = response.includes('migrat') && response.includes('success');
    const seedingCompleted = response.includes('seed');
    const validationPassed = response.includes('validat') && !response.includes('failed');

    const success = migrationsApplied && validationPassed;

    return {
      success,
      migrationsApplied,
      seedingCompleted,
      validationPassed,
      tokensUsed: result.tokensUsed,
      cost: result.cost,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Migration failed: ${errorMessage}`);

    return {
      success: false,
      migrationsApplied: false,
      seedingCompleted: false,
      validationPassed: false,
      tokensUsed: {
        input: 0,
        output: 0,
        cacheCreation: 0,
        cacheRead: 0,
      },
      cost: 0,
      error: errorMessage,
    };
  }
}

/**
 * Main migrate command
 */
export async function migrateCommand(options: MigrateOptions): Promise<void> {
  console.log('🗄️  Starting Database Migration...\n');

  // Initialize logging context
  const logContext = logger.createContext('migrate', { noLogs: options.noLogs });
  const cleanupHandler = setupCancellationHandler(logContext);

  try {
    // Validate environment
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    // Execute core logic
    const result = await migrateCore(options);

    // Track metrics
    logger.trackTokens(logContext, result.tokensUsed);

    // Display summary
    displayMigrationSummary(result);

    // Log execution (success or error based on result)
    await logger.complete(
      logContext,
      result.success ? 'success' : 'error',
      result.error ? new Error(result.error) : undefined
    );
    cleanupHandler();

    if (!result.success) {
      throw new Error(result.error || 'Migration failed');
    }
  } catch (error) {
    console.error('\n❌ Migration command failed:', error);

    // Log failed execution
    await logger.complete(logContext, 'error', error as Error);
    cleanupHandler();

    throw error;
  }
}

/**
 * Display migration summary
 */
function displayMigrationSummary(result: MigrateResult): void {
  console.log(`\n${'='.repeat(60)}`);
  console.log('📊 Migration Summary');
  console.log('='.repeat(60));

  if (result.success) {
    console.log('✅ Status: Migration successful');
  } else {
    console.log('❌ Status: Migration failed');
  }

  console.log(`   ✓ Migrations applied: ${result.migrationsApplied ? 'Yes' : 'No'}`);
  console.log(`   ✓ Seeding completed: ${result.seedingCompleted ? 'Yes' : 'No'}`);
  console.log(`   ✓ Validation passed: ${result.validationPassed ? 'Yes' : 'No'}`);
  console.log(`💰 Cost: $${result.cost.toFixed(4)}`);

  console.log('='.repeat(60));

  if (result.success) {
    console.log('\n✅ Database migrations applied and validated successfully!');
  } else {
    console.log(`\n❌ Migration failed: ${result.error || 'See output above for details'}`);
  }
}
