# Kosuke CLI

Development automation tool for syncing rules and analyzing code quality with Claude AI.

## Installation

Install globally via npm:

```bash
npm install -g @kosuke-ai/cli
```

Or use with npx (no installation required):

```bash
npx @kosuke-ai/cli <command>
```

## Prerequisites

Set up the required environment variable:

```bash
# Required for Claude API access
export ANTHROPIC_API_KEY="your-api-key-here"

# Optional: Only required when using --pr flag
export GITHUB_TOKEN="your-github-token-here"
```

You can also create a `.env` file in your project root:

```env
ANTHROPIC_API_KEY=your-api-key-here
GITHUB_TOKEN=your-github-token-here
```

## Workflow

By default, all commands apply changes **locally** without git operations. This allows you to:

- Review changes before committing
- Test fixes in your local environment
- Iterate quickly without creating PRs

Use the `--pr` flag to automatically create a pull request with the changes.

## Commands

### `kosuke sync-rules`

Sync rules and documentation from kosuke-template repository.

**Options:**

- `--force` - Compare files regardless of recent commit history
- `--pr` - Create a pull request with the changes
- `--base-branch=<name>` - Base branch for PR (default: current branch)

**Examples:**

```bash
# Sync locally
kosuke sync-rules

# Force comparison and sync locally
kosuke sync-rules --force

# Create PR with synced changes
kosuke sync-rules --pr

# Create PR with custom base branch
kosuke sync-rules --pr --base-branch=develop
```

### `kosuke analyse`

Analyze and fix code quality issues against CLAUDE.md rules. Applies fixes locally by default.

**Options:**

- `--pr` - Create a pull request with fixes
- `--base-branch=<name>` - Base branch for PR (default: current branch)
- `--scope=<dirs>` - Analyze specific directories (comma-separated)
- `--types=<exts>` - Analyze specific file types (comma-separated)

**Examples:**

```bash
# Analyze and fix locally
kosuke analyse

# Analyze specific directories
kosuke analyse --scope=hooks,lib/trpc

# Analyze specific file types
kosuke analyse --types=ts,tsx

# Create PR with fixes
kosuke analyse --pr

# Create PR with custom base branch
kosuke analyse --pr --base-branch=main
```

### `kosuke lint`

Use Claude AI to automatically fix linting errors. Applies fixes locally by default.

**Options:**

- `--pr` - Create a pull request with fixes
- `--base-branch=<name>` - Base branch for PR (default: current branch)

**Examples:**

```bash
# Fix linting errors locally
kosuke lint

# Create PR with fixes
kosuke lint --pr

# Create PR with custom base branch
kosuke lint --pr --base-branch=main
```

**Requirements:**

- Your `package.json` must have a `lint` script (e.g., `"lint": "eslint ."`)
- The lint script should support the `--fix` flag for auto-fixing

### `kosuke requirements`

Interactive requirements gathering tool powered by Claude AI. Creates a comprehensive `docs.md` file through a conversational workflow.

**How it works:**

1. You describe your web application
2. Claude analyzes and extracts core functionalities
3. Claude asks clarification questions
4. You answer iteratively until requirements are clear
5. Claude generates a detailed `docs.md` with:
   - Product Overview
   - Core Functionalities
   - Technical Architecture
   - User Flows
   - Database Schema
   - API Endpoints
   - Implementation Notes

**Example:**

```bash
kosuke requirements
```

**Features:**

- ✨ Fully interactive conversation workflow
- 💰 Real-time cost tracking (shows token usage)
- 🔄 Iterative refinement until requirements are comprehensive
- 📝 Structured markdown output in `docs.md`
- 🌐 Optimized for web application projects

## Configuration

### `.kosukeignore`

Create a `.kosukeignore` file in your project root to exclude files and directories from analysis. Uses the same syntax as `.gitignore`.

Example:

```gitignore
# Ignore build outputs
dist/
build/

# Ignore specific files
*.test.ts
**/*.spec.ts

# Ignore directories
node_modules/
.git/
```

## Development

If you want to contribute or run from source:

```bash
# Clone the repository
git clone https://github.com/Kosuke-Org/kosuke-cli.git
cd kosuke-cli

# Install dependencies
npm install

# Build the project
npm run build

# Run in development mode
npm run dev <command>

# Link for local testing
npm link
kosuke <command>
```
