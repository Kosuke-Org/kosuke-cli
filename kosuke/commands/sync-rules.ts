/**
 * Sync rules command - Syncs rules and documentation from kosuke-template
 */

import simpleGit, { type SimpleGit } from 'simple-git';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { isKosukeTemplateRepo } from '../utils/git.js';
import { runWithPR } from '../utils/pr-orchestrator.js';
import { runFormat, runLint } from '../utils/validator.js';
import { runAgent } from '../utils/claude-agent.js';
import { fixLintErrors } from './lint.js';
import type { RulesAdaptation, SyncRulesOptions } from '../types.js';

// Constants
const KOSUKE_TEMPLATE_REPO = 'https://github.com/Kosuke-Org/kosuke-template.git';
const KOSUKE_TEMPLATE_BRANCH = 'main';
const TEMP_DIR = '.tmp/kosuke-template';
const RULES_FILE = '.cursor/rules/general.mdc';
const CLAUDE_MD_FILE = 'CLAUDE.md';

interface SyncResult {
  adaptation: RulesAdaptation;
  claudeMdContent: string;
  changesSummary: string;
}

/**
 * Clone or update kosuke-template repository
 */
async function cloneOrUpdateKosukeTemplate(): Promise<SimpleGit> {
  const git: SimpleGit = simpleGit();

  if (existsSync(TEMP_DIR)) {
    console.log('📁 Updating existing kosuke-template clone...');
    const repoGit: SimpleGit = simpleGit(TEMP_DIR);
    await repoGit.fetch(['origin', KOSUKE_TEMPLATE_BRANCH, '--depth=100']);
    await repoGit.checkout(KOSUKE_TEMPLATE_BRANCH);
    await repoGit.pull('origin', KOSUKE_TEMPLATE_BRANCH);
    return repoGit;
  }

  console.log('📥 Cloning kosuke-template repository...');
  mkdirSync(TEMP_DIR, { recursive: true });
  await git.clone(KOSUKE_TEMPLATE_REPO, TEMP_DIR, [
    '--depth',
    '100',
    '--branch',
    KOSUKE_TEMPLATE_BRANCH,
  ]);
  return simpleGit(TEMP_DIR);
}

/**
 * Check if rules file changed in last 24 hours
 */
async function checkRulesChangedInLast24Hours(git: SimpleGit): Promise<boolean> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Get all commits in last 24 hours
  const log = await git.log({
    maxCount: 100,
    '--since': oneDayAgo,
  });

  for (const commit of log.all) {
    // Check if rules file was modified in this commit
    const diffSummary = await git.diffSummary([`${commit.hash}^`, commit.hash]);
    for (const file of diffSummary.files) {
      if (file.file === RULES_FILE) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Adapt rules conservatively with Claude Agent SDK
 */
async function adaptRulesWithClaude(
  fileName: string,
  currentContent: string
): Promise<RulesAdaptation> {
  console.log(`🤖 Analyzing ${fileName} with Claude Agent SDK...`);

  const workspaceRoot = process.cwd();
  const kosukeFilePath = join(TEMP_DIR, fileName); // Kosuke-template clone
  const currentFilePath = join(workspaceRoot, fileName); // Current repository

  const systemPrompt = `You are syncing rules/documentation from kosuke-template to a forked repository.

TASK:
Compare kosuke-template's version of ${fileName} with the current repository's version.

Your job is to:
1. Explore the current repository to understand its architecture, tech stack, and features
2. Read both versions of ${fileName} (kosuke-template vs current)
3. Adapt the current repository's file with conservative improvements:
   - KEEP repository-specific customizations
   - ADD generic improvements (TypeScript patterns, testing, code quality)
   - SKIP features not present in this repository (discover by exploring the codebase)
   - ADAPT examples to match the repository's domain and features

Kosuke-template clone: ${TEMP_DIR}
Current repository: ${workspaceRoot}

Take your time to explore the codebase and understand the context before making changes.`;

  const promptText = `Compare and adapt ${fileName}:
- Kosuke-template version: ${kosukeFilePath}
- Current version: ${currentFilePath}

Explore the repository, read both files, identify improvements, and update the current version conservatively.`;

  try {
    // Note: Claude Agent SDK doesn't support additionalDirectories in AgentConfig
    // The agent can access TEMP_DIR via relative paths from workspaceRoot
    await runAgent(promptText, {
      systemPrompt,
      maxTurns: 30,
      cwd: workspaceRoot,
      verbosity: 'verbose',
      settingSources: [], // Don't load CLAUDE.md when syncing it
    });

    // Read the adapted content
    const adaptedContent = existsSync(currentFilePath)
      ? readFileSync(currentFilePath, 'utf-8')
      : '';

    // Check if content actually changed
    const relevant = adaptedContent !== currentContent;

    const adaptation: RulesAdaptation = {
      relevant,
      adaptedContent,
      summary: relevant ? 'Updated with improvements from kosuke-template' : 'No changes needed',
    };

    console.log(`\n   ${relevant ? '✅ File updated' : 'ℹ️  No changes needed'}`);

    return adaptation;
  } catch (error) {
    console.error(`\n   ❌ Error during adaptation:`, error);
    throw error;
  }
}

/**
 * Generate CLAUDE.md from general.mdc (strip frontmatter)
 */
function generateClaudeMd(generalMdcContent: string): string {
  const lines = generalMdcContent.split('\n');

  // Detect frontmatter: starts with --- and ends with ---
  if (lines[0] === '---') {
    // Find the closing --- (starts from line 1, not 0)
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '---') {
        // Skip the closing --- and any empty lines after it
        let skipLines = i + 1;
        while (skipLines < lines.length && lines[skipLines].trim() === '') {
          skipLines++;
        }
        return lines.slice(skipLines).join('\n');
      }
    }
  }

  // No frontmatter detected, return as-is
  return generalMdcContent;
}

/**
 * Generate concise summary of changes using Claude
 */
async function generateChangesSummary(oldContent: string, newContent: string): Promise<string> {
  console.log('🤖 Generating changes summary...');

  const prompt = `Compare these two versions of a development rules file and provide a CONCISE summary of what changed.

OLD VERSION:
\`\`\`
${oldContent.slice(0, 5000)}${oldContent.length > 5000 ? '\n... (truncated)' : ''}
\`\`\`

NEW VERSION:
\`\`\`
${newContent.slice(0, 5000)}${newContent.length > 5000 ? '\n... (truncated)' : ''}
\`\`\`

Provide a brief summary (3-5 bullet points) highlighting:
- New features or guidelines added
- Significant updates to existing rules
- Removed or deprecated items

Keep it concise and developer-friendly. Use bullet points starting with emojis.`;

  try {
    const result = await runAgent(prompt, {
      maxTurns: 1,
      cwd: process.cwd(),
      verbosity: 'minimal',
      systemPrompt: '', // No system prompt needed for this simple task
      settingSources: [], // Don't load CLAUDE.md when syncing it
    });

    console.log('   ✅ Summary generated\n');
    return result.response.trim();
  } catch {
    console.warn('   ⚠️  Failed to generate summary, using fallback');
    return 'Updated rules and documentation from kosuke-template';
  }
}

/**
 * Core sync logic (git-agnostic)
 */
async function syncRulesCore(force: boolean): Promise<SyncResult> {
  // Clone/update kosuke-template
  const git = await cloneOrUpdateKosukeTemplate();

  if (force) {
    console.log('⚡ Force mode: Comparing rules file...\n');
  } else {
    // Check if rules file changed in last 24 hours
    console.log('📅 Checking for changes in last 24 hours...');
    const hasChanges = await checkRulesChangedInLast24Hours(git);

    if (!hasChanges) {
      console.log('✅ No changes to rules in last 24 hours. Nothing to sync.');
      console.log('   Use --force flag to compare files regardless of recent commits.');
      throw new Error('No recent changes');
    }

    console.log(`   ✅ Found changes in ${RULES_FILE}\n`);
  }

  // Read current repository versions
  const workspaceRoot = process.cwd();
  const kosukeFile = join(TEMP_DIR, RULES_FILE);
  const currentFile = join(workspaceRoot, RULES_FILE);

  if (!existsSync(kosukeFile)) {
    throw new Error(`${RULES_FILE} not found in kosuke-template`);
  }

  const kosukeContent = readFileSync(kosukeFile, 'utf-8');
  const currentContent = existsSync(currentFile) ? readFileSync(currentFile, 'utf-8') : '';

  // Check if content is actually different
  if (kosukeContent === currentContent) {
    console.log(`ℹ️  No differences detected in ${RULES_FILE}. Nothing to sync.`);
    throw new Error('No differences detected');
  }

  console.log(`📥 Processing ${RULES_FILE}...`);
  const adaptation = await adaptRulesWithClaude(RULES_FILE, currentContent);

  // Abort if no changes
  if (!adaptation.relevant) {
    console.log('✅ No relevant changes to sync. Aborting.');
    throw new Error('No relevant changes');
  }

  // Generate CLAUDE.md from adapted general.mdc
  console.log(`\n📄 Generating ${CLAUDE_MD_FILE} from ${RULES_FILE}...`);
  const claudeMdContent = generateClaudeMd(adaptation.adaptedContent);

  // Generate LLM summary of changes
  const changesSummary = await generateChangesSummary(currentContent, adaptation.adaptedContent);

  // Write files locally
  const workspaceRootPath = process.cwd();
  console.log('📝 Writing adapted files...');

  // Write general.mdc
  const rulesFile = join(workspaceRootPath, RULES_FILE);
  const rulesDir = dirname(rulesFile);
  if (!existsSync(rulesDir)) {
    mkdirSync(rulesDir, { recursive: true });
  }
  writeFileSync(rulesFile, adaptation.adaptedContent, 'utf-8');
  console.log(`   ✅ ${RULES_FILE}`);

  // Write CLAUDE.md (stripped version)
  const claudeFile = join(workspaceRootPath, CLAUDE_MD_FILE);
  writeFileSync(claudeFile, claudeMdContent, 'utf-8');
  console.log(`   ✅ ${CLAUDE_MD_FILE}`);

  // Run formatting and linting
  console.log('\n🔧 Running formatting and linting...');

  const formatResult = await runFormat();
  if (formatResult.warning) {
    console.log(`   ${formatResult.warning}`);
  } else if (!formatResult.success) {
    console.error('   ❌ Formatting failed:\n', formatResult.error);
    throw new Error('Formatting validation failed');
  } else {
    console.log('   ✅ Formatting completed');
  }

  let lintResult = await runLint();
  if (lintResult.warning) {
    console.log(`   ${lintResult.warning}`);
  } else if (!lintResult.success) {
    console.log('   ⚠️  Linting errors detected, attempting to fix...');

    // Try to fix lint errors with Claude (max 2 attempts)
    let attempts = 0;
    const maxAttempts = 2;

    while (!lintResult.success && attempts < maxAttempts) {
      attempts++;
      console.log(`\n   🔄 Lint fix attempt ${attempts}/${maxAttempts}`);

      const fixApplied = await fixLintErrors(lintResult.error || '');

      if (!fixApplied) {
        console.log(`   ⚠️  No fixes were applied by Claude`);
        break;
      }

      // Re-run lint to check if errors are fixed
      lintResult = await runLint();
    }

    if (!lintResult.success) {
      console.error('   ❌ Linting failed after attempts:\n', lintResult.error);
      throw new Error('Linting validation failed');
    }
  } else {
    console.log('   ✅ Linting completed');
  }

  return {
    adaptation,
    claudeMdContent,
    changesSummary,
  };
}

/**
 * Main sync-rules command
 */
export async function syncRulesCommand(options: SyncRulesOptions = {}): Promise<void> {
  console.log('🚀 Starting Rules & Documentation Sync...\n');

  try {
    // Check if running in kosuke-template itself
    if (await isKosukeTemplateRepo()) {
      console.log('⚠️  Detected running in kosuke-template repository itself.');
      console.log('   This script is designed to sync FROM kosuke-template TO forked repos.');
      console.log('   Skipping sync to prevent self-modification.\n');
      return;
    }

    // Validate environment
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }

    // If --pr flag is provided, wrap with PR workflow
    if (options.pr) {
      if (!process.env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN environment variable is required for --pr flag');
      }

      const date = new Date().toISOString().split('T')[0];

      try {
        const { result, prInfo } = await runWithPR(
          {
            branchPrefix: 'sync/rules',
            baseBranch: options.baseBranch,
            commitMessage: 'chore: sync rules and documentation from kosuke-template',
            prTitle: `chore: sync rules & docs from kosuke-template (${date})`,
            prBody: `## 🔄 Sync Rules from Kosuke Template

This PR syncs rules and documentation from the kosuke-template repository.

### 📝 Changes
- Updated \`.cursor/rules/general.mdc\`
- Updated \`CLAUDE.md\`

---

🤖 *Auto-generated by \`kosuke sync-rules --pr\`*`,
          },
          async () => syncRulesCore(options.force || false)
        );

        console.log('\n✅ Rules sync completed successfully!');
        console.log(`📝 Changes summary: ${result.changesSummary}`);
        console.log(`🔗 PR: ${prInfo.prUrl}`);
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === 'No recent changes' ||
            error.message === 'No differences detected' ||
            error.message === 'No relevant changes')
        ) {
          console.log('\n✅ No sync needed.');
          return;
        }
        throw error;
      }
    } else {
      // Run core logic without PR
      try {
        await syncRulesCore(options.force || false);

        console.log('\n✅ Rules sync completed successfully!');
        console.log('\nℹ️  Changes applied locally. Use --pr flag to create a pull request.');
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === 'No recent changes' ||
            error.message === 'No differences detected' ||
            error.message === 'No relevant changes')
        ) {
          console.log('\n✅ No sync needed.');
          return;
        }
        throw error;
      }
    }
  } catch (error) {
    console.error('\n❌ Sync failed:', error);
    throw error;
  } finally {
    // Cleanup temp directory
    if (existsSync(TEMP_DIR)) {
      console.log('\n🧹 Cleaning up...');
      rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  }
}
