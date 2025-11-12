/**
 * Sync rules command - Syncs rules and documentation from kosuke-template
 */

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import simpleGit, { type SimpleGit } from 'simple-git';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { getCurrentRepo, isKosukeTemplateRepo } from '../utils/git';
import { createPullRequest } from '../utils/github';
import { runFormat, runLint } from '../utils/validator';
import type { RulesAdaptation } from '../types';

// Constants
const KOSUKE_TEMPLATE_REPO = 'https://github.com/Kosuke-Org/kosuke-template.git';
const KOSUKE_TEMPLATE_BRANCH = 'main';
const TEMP_DIR = '.tmp/kosuke-template';
const TARGET_BRANCH = 'main';
const RULES_FILE = '.cursor/rules/general.mdc';
const CLAUDE_MD_FILE = 'CLAUDE.md';

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

  const options: Options = {
    model: 'claude-sonnet-4-5',
    systemPrompt,
    maxTurns: 30,
    cwd: workspaceRoot,
    permissionMode: 'bypassPermissions',
    additionalDirectories: [TEMP_DIR, workspaceRoot],
  };

  try {
    const responseStream = query({ prompt: promptText, options });

    // Display Claude's reasoning and actions
    for await (const message of responseStream) {
      if (message.type === 'assistant') {
        const content = message.message.content;
        for (const block of content) {
          if (block.type === 'text' && block.text.trim()) {
            console.log(`   💭 ${block.text.trim()}`);
          } else if (block.type === 'tool_use') {
            const inputStr = JSON.stringify(block.input, null, 0);
            const shortInput = inputStr.length > 100 ? inputStr.substring(0, 97) + '...' : inputStr;
            console.log(`   🔧 ${block.name}: ${shortInput}`);
          }
        }
      }
    }

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

  const options: Options = {
    model: 'claude-sonnet-4-5',
    maxTurns: 1,
    cwd: process.cwd(),
  };

  try {
    const responseStream = query({ prompt, options });

    let summary = '';
    for await (const message of responseStream) {
      if (message.type === 'assistant') {
        const content = message.message.content;
        for (const block of content) {
          if (block.type === 'text') {
            summary += block.text;
          }
        }
      }
    }

    console.log('   ✅ Summary generated\n');
    return summary.trim();
  } catch {
    console.warn('   ⚠️  Failed to generate summary, using fallback');
    return 'Updated rules and documentation from kosuke-template';
  }
}

/**
 * Create PR with adapted rules
 */
async function createRulesSyncPR(
  adaptation: RulesAdaptation,
  claudeMdContent: string,
  changesSummary: string
): Promise<void> {
  const { owner, repo } = await getCurrentRepo();
  const git: SimpleGit = simpleGit();

  // Generate unique branch name
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('.')[0];
  const branchName = `sync/rules-${timestamp}`;

  console.log(`🌿 Creating branch: ${branchName}`);

  // Create and checkout new branch
  await git.checkout(TARGET_BRANCH);
  await git.pull('origin', TARGET_BRANCH);

  // Check if branch already exists locally and delete it
  try {
    const branches = await git.branchLocal();
    if (branches.all.includes(branchName)) {
      console.log(`   Deleting existing local branch: ${branchName}`);
      await git.deleteLocalBranch(branchName, true);
    }
  } catch {
    // Branch doesn't exist, continue
  }

  await git.checkoutLocalBranch(branchName);

  // Write adapted content to files
  const workspaceRoot = process.cwd();
  console.log('📝 Writing adapted files...');

  // Write general.mdc
  const rulesFile = join(workspaceRoot, RULES_FILE);
  const rulesDir = dirname(rulesFile);
  if (!existsSync(rulesDir)) {
    mkdirSync(rulesDir, { recursive: true });
  }
  writeFileSync(rulesFile, adaptation.adaptedContent, 'utf-8');
  console.log(`   ✅ ${RULES_FILE}`);

  // Write CLAUDE.md (stripped version)
  const claudeFile = join(workspaceRoot, CLAUDE_MD_FILE);
  writeFileSync(claudeFile, claudeMdContent, 'utf-8');
  console.log(`   ✅ ${CLAUDE_MD_FILE}`);

  // Add files to git
  await git.add([RULES_FILE, CLAUDE_MD_FILE]);

  // Run formatting and linting
  console.log('\n🔧 Running formatting and linting...');

  await runFormat();
  console.log('   ✅ Formatting completed');

  await runLint();
  console.log('   ✅ Linting completed');

  // Add any formatting/linting changes
  await git.add(['-A']);

  // Commit changes
  await git.commit('chore: sync rules and documentation from kosuke-template', ['--no-verify']);

  console.log('\n📤 Pushing branch...');
  await git.push('origin', branchName, ['--set-upstream']);

  // Create PR
  console.log('🔀 Creating pull request...');

  const date = new Date().toISOString().split('T')[0];

  // Build PR body with LLM-generated summary
  const prBody = `## 🔄 Sync Rules from Kosuke Template

${changesSummary}

---

🤖 *Auto-generated by \`bun run kosuke sync-rules\`*
`;

  const prUrl = await createPullRequest({
    owner,
    repo,
    title: `chore: sync rules & docs from kosuke-template (${date})`,
    head: branchName,
    base: TARGET_BRANCH,
    body: prBody,
  });

  console.log(`✅ Pull request created: ${prUrl}`);
}

/**
 * Main sync-rules command
 */
export async function syncRulesCommand(force: boolean = false): Promise<void> {
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
    if (!process.env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN environment variable is required');
    }

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
        return;
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
      return;
    }

    console.log(`📥 Processing ${RULES_FILE}...`);
    const adaptation = await adaptRulesWithClaude(RULES_FILE, currentContent);

    // Abort if no changes
    if (!adaptation.relevant) {
      console.log('✅ No relevant changes to sync. Aborting.');
      return;
    }

    // Generate CLAUDE.md from adapted general.mdc
    console.log(`\n📄 Generating ${CLAUDE_MD_FILE} from ${RULES_FILE}...`);
    const claudeMdContent = generateClaudeMd(adaptation.adaptedContent);

    // Generate LLM summary of changes
    const changesSummary = await generateChangesSummary(currentContent, adaptation.adaptedContent);

    // Create PR with adapted content
    console.log(`\n📋 Creating pull request...\n`);
    await createRulesSyncPR(adaptation, claudeMdContent, changesSummary);

    console.log('\n✅ Rules sync completed successfully!');
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
