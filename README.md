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

## Publishing

This project uses GitHub Actions for automated publishing to npm.

### How to Publish a New Version

1. **Update the version** in `package.json`:
   ```bash
   npm version patch  # 0.0.1 -> 0.0.2
   npm version minor  # 0.0.1 -> 0.1.0
   npm version major  # 0.0.1 -> 1.0.0
   ```

2. **Push the version tag**:
   ```bash
   git push origin main --tags
   ```

3. **Create a GitHub Release**:
   - Go to the repository on GitHub
   - Click "Releases" → "Create a new release"
   - Select the tag you just pushed
   - Add release notes
   - Click "Publish release"

4. **Automated Publishing**:
   - GitHub Actions will automatically build and publish to npm
   - Monitor the workflow at: Actions tab in your repository

### Prerequisites for Publishing

Before the CI can publish, you need to set up an npm token:

1. Generate an npm automation token:
   - Go to https://www.npmjs.com/settings/YOUR_USERNAME/tokens
   - Click "Generate New Token" → "Automation"
   - Copy the token

2. Add it to GitHub Secrets:
   - Go to your repository → Settings → Secrets and variables → Actions
   - Click "New repository secret"
   - Name: `NPM_TOKEN`
   - Value: Your npm token
   - Click "Add secret"

### CI/CD Workflows

- **CI** (`ci.yml`): Runs on every push/PR to main, builds and tests on Node 18 & 20
- **Publish** (`publish.yml`): Runs on GitHub releases, builds and publishes to npm

## License

ISC

## Support

- Issues: https://github.com/Kosuke-Org/kosuke-cli/issues
- Homepage: https://github.com/Kosuke-Org/kosuke-cli

## Author

filippo.pedrazzini@kosuke.ai
