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

Before using Kosuke CLI, set up the required environment variables:

```bash
# Required for Claude API access
export ANTHROPIC_API_KEY="your-api-key-here"

# Required for creating pull requests
export GITHUB_TOKEN="your-github-token-here"
```

You can also create a `.env` file in your project root:

```
ANTHROPIC_API_KEY=your-api-key-here
GITHUB_TOKEN=your-github-token-here
```

## Commands

### `kosuke sync-rules`

Sync rules and documentation from kosuke-template repository.

**Options:**

- `--force` - Compare files regardless of recent commit history

**Examples:**

```bash
kosuke sync-rules
kosuke sync-rules --force
```

### `kosuke analyse`

Analyze and fix code quality issues against CLAUDE.md rules. Creates a single PR with all fixes from multiple isolated Claude runs.

**Options:**

- `--dry-run` - Report violations only, don't create PR
- `--scope=<dirs>` - Analyze specific directories (comma-separated)
- `--types=<exts>` - Analyze specific file types (comma-separated)

**Examples:**

```bash
# Analyze entire project
kosuke analyse

# Analyze specific directories
kosuke analyse --scope=hooks,lib/trpc

# Analyze specific file types
kosuke analyse --types=ts,tsx

# Dry run (report only)
kosuke analyse --dry-run
```

### `kosuke lint`

Use Claude AI to automatically fix linting errors in your codebase. Runs the lint command from package.json, analyzes the errors, and applies fixes.

**Options:**

- `--dry-run` - Report errors only, don't fix them
- `--no-pr` - Fix locally without creating PR

**Examples:**

```bash
# Fix all linting errors and create PR
kosuke lint

# Preview what errors would be fixed
kosuke lint --dry-run

# Fix errors locally without creating PR
kosuke lint --no-pr
```

**Requirements:**

- Your `package.json` must have a `lint` script (e.g., `"lint": "eslint . --fix"`)
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

```
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
