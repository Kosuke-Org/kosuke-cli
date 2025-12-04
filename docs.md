# Kosuke CLI - Command Dependencies Map

## Command Dependency Graph

```text
┌──────────────────────────────────────────────────────────────────────────┐
│                        STANDALONE COMMANDS                               │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  analyse    getcode    sync-rules    requirements    tickets   migrate  │
│     │          │            │              │             │        │     │
│     └──────────┴────────────┴──────────────┴─────────────┴────────┘     │
│                              │                                          │
│                        (independent)                                    │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│                      ORCHESTRATOR COMMANDS                               │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────┐                          ┌─────────┐                       │
│  │  ship   │                          │  build  │                       │
│  └────┬────┘                          └────┬────┘                       │
│       │                                    │                            │
│       ├─► review (conditional)             ├─► ship (for impl tickets)  │
│       └─► lint (always)                    │   ├─► review (conditional) │
│                                            │   └─► lint (always)        │
│                                            ├─► migrate (after SCHEMA)   │
│                                            ├─► test (for test tickets)  │
│                                            │   └─► ship (if test fails) │
│                                            └─► commit (per batch)       │
│                                                                          │
│  ┌─────────┐                                                            │
│  │ review  │                                                            │
│  └────┬────┘                                                            │
│       │                                                                 │
│       └─► lint (always)                                                │
│                                                                          │
│  ┌─────────┐                                                            │
│  │  lint   │                                                            │
│  └────┬────┘                                                            │
│       │                                                                 │
│       └─► (uses validator.ts utility)                                  │
│                                                                          │
│  ┌─────────┐                                                            │
│  │  test   │                                                            │
│  └─────────┘                                                            │
│       │                                                                 │
│       └─► (independent, used by ship)                                  │
└──────────────────────────────────────────────────────────────────────────┘
```

## Command Details Table

| Command          | Dependencies                            | Called By            | Core/Wrapper | Description                               |
| ---------------- | --------------------------------------- | -------------------- | ------------ | ----------------------------------------- |
| **analyse**      | -                                       | -                    | Core         | Analyze code quality issues               |
| **getcode**      | repository-manager, repository-resolver | -                    | Core         | Explore GitHub repositories               |
| **sync-rules**   | -                                       | -                    | Core         | Sync CLAUDE.md rules from template        |
| **requirements** | -                                       | -                    | Core         | Interactive requirements gathering        |
| **plan**         | ticket-writer.ts                        | tickets (--prompt)   | Core         | Interactive ticket planning with Q&A      |
| **tickets**      | plan (--prompt), ticket-writer.ts       | -                    | Core         | Generate tickets from doc or prompt       |
| **lint**         | validator.ts                            | review, ship, build  | Core         | Fix linting errors with Claude            |
| **migrate**      | claude-agent.ts                         | build (after SCHEMA) | Core         | Apply migrations, seed DB, validate       |
| **review**       | reviewCore, lint                        | ship (conditional)   | Wrapper      | Review git diff against CLAUDE.md         |
| **test**         | testCore, Playwright MCP                | build                | Core         | Web E2E testing (atomic)                  |
| **ship**         | reviewCore, lint                        | build                | Orchestrator | Implement a single ticket (no commit)     |
| **build**        | ship, migrate, test, git commit         | -                    | Orchestrator | Build project from tickets, batch commits |

## Utility Dependencies

| Utility                      | Used By                   | Purpose                               |
| ---------------------------- | ------------------------- | ------------------------------------- |
| **claude-agent.ts**          | All commands              | Centralized Claude SDK integration    |
| **validator.ts**             | lint, review, ship, build | Comprehensive linting                 |
| **git.ts**                   | review, build             | Git operations                        |
| **github.ts**                | sync-rules, build         | GitHub API integration                |
| **repository-manager.ts**    | getcode                   | Clone/update repos                    |
| **repository-resolver.ts**   | getcode                   | Infer repo from queries               |
| **ticket-writer.ts**         | plan, tickets             | Shared ticket validation and writing  |
| **tickets-manager.ts**       | ship, build, test         | Load/update tickets.json              |
| **error-analyzer.ts**        | test                      | Analyze test/runtime failures         |
| **log-collector.ts**         | test                      | Collect Docker/test logs              |
| **pr-orchestrator.ts**       | sync-rules, analyse, lint | Create PRs                            |
| **prompt-generator.ts**      | test                      | Generate web-test and db-test prompts |
| **test-runner.ts**           | build                     | Iterative test+fix loop               |
| **playwright-mcp-client.ts** | test                      | Playwright MCP server integration     |
| **batch-creator.ts**         | analyse                   | Create file batches for processing    |
| **file-discovery.ts**        | analyse, lint             | File scanning with .kosukeignore      |
| **logger.ts**                | All commands              | Execution logging to Kosuke API       |

## Call Graph (Nested)

```text
build
├── ship (for implementation tickets: schema, backend, frontend)
│   ├── reviewCore (conditional via build --review flag)
│   └── lint (always)
├── migrate (after SCHEMA tickets, automatic)
│   ├── claude-agent.ts (runs db:migrate and db:seed)
│   └── validation (verifies schema changes applied)
├── test (for test tickets: web-test only)
│   ├── Playwright MCP (web E2E testing)
│   └── ship (if test fails, retry up to 3 times)
└── git commit (per batch: after web-test completion)

ship
├── reviewCore (conditional via --review flag, WITH ticket context)
└── lint (always)
(Note: Ship does NOT commit - commits only through build command)

review
├── reviewCore (standalone, no ticket context)
└── lint

lint
└── validator.ts

test
└── web-test (only web E2E testing supported)
    └── Playwright MCP mode (default and only mode):
        ├── playwright-mcp-client.ts (Playwright MCP server integration)
        ├── Anthropic SDK (Claude AI for test execution)
        └── Single atomic execution (no retries)

migrate (standalone or called by build after SCHEMA tickets)
├── claude-agent.ts (applies migrations and seeds DB)
├── db:migrate (apply pending migrations)
├── db:seed (seed database with initial data)
└── validation (verify schema changes applied correctly)

requirements
└── Anthropic SDK directly (custom tools for docs.md)

plan (interactive ticket planning)
├── Anthropic SDK directly (custom tools for exploration)
├── Interactive Q&A with clarification questions
└── ticket-writer.ts (validation and writing)
    └─► Creates: tickets.json with PLAN-* prefixed tickets

tickets (three modes)
├── PROMPT MODE (--prompt flag):
│   └── plan (delegates to plan command)
│       ├── Interactive Q&A with clarification questions
│       └── ticket-writer.ts (validation and writing)
│           └─► Creates: tickets.json with PLAN-* prefixed tickets
├── SCAFFOLD MODE (--scaffold flag, document mode):
│   ├── Scaffold batch:
│   │   ├── claude-agent.ts (schema scaffold, auto-validated by migrate)
│   │   ├── claude-agent.ts (backend scaffold)
│   │   ├── claude-agent.ts (frontend scaffold)
│   │   └── claude-agent.ts (web-tests 1..N)
│   └── Logic batch:
│       ├── claude-agent.ts (schema logic, auto-validated by migrate)
│       ├── claude-agent.ts (backend logic)
│       ├── claude-agent.ts (frontend logic)
│       └── claude-agent.ts (web-tests N+1..M)
└── LOGIC-ONLY MODE (default):
    ├── claude-agent.ts (layer analysis: schema/backend/frontend)
    ├── claude-agent.ts (schema logic, if needed, auto-validated by migrate)
    ├── claude-agent.ts (backend logic, if needed)
    ├── claude-agent.ts (frontend logic, if needed)
    └── claude-agent.ts (web-tests, if implementation)
```

## External Dependencies

| Command               | External Services     | Environment Variables                                              |
| --------------------- | --------------------- | ------------------------------------------------------------------ |
| All commands          | Anthropic Claude API  | `ANTHROPIC_API_KEY` (required)                                     |
| All commands          | Kosuke API (optional) | `KOSUKE_BASE_URL`, `KOSUKE_API_KEY`, `KOSUKE_PROJECT_ID` (logging) |
| build (default)       | GitHub API            | `GITHUB_TOKEN` (required for git commits)                          |
| migrate               | PostgreSQL            | `POSTGRES_URL` (default: postgres://postgres:postgres@localhost)   |
| sync-rules (--pr)     | GitHub API            | `GITHUB_TOKEN` (required)                                          |
| analyse (--pr)        | GitHub API            | `GITHUB_TOKEN` (required)                                          |
| lint (--pr)           | GitHub API            | `GITHUB_TOKEN` (required)                                          |
| getcode               | GitHub API (optional) | `GITHUB_TOKEN` (optional, for cloning)                             |
| ship (schema tickets) | PostgreSQL            | `POSTGRES_URL` (from --db-url)                                     |
| test                  | Playwright MCP        | -                                                                  |

## Command Workflow Overview

### Development Workflow (Full Cycle)

```text
NEW PROJECT (with Kosuke Template):

1. requirements          → Interactive requirements gathering
   └─► Creates: docs.md

2. tickets --scaffold    → Generate scaffold + logic tickets
   └─► Creates: tickets.json
       Scaffold batch: schema → db-test → backend → frontend → web-tests
       Logic batch:    schema → db-test → backend → frontend → web-tests
       Claude analyzes requirements vs Kosuke Template baseline

3. build                 → Batch process all tickets
   ├─► For each implementation ticket (schema, backend, frontend):
   │   ├─► ship --ticket=ID (implements)
   │   ├─► review (conditional via --review flag)
   │   └─► lint (always)
   ├─► For each test ticket (db-test, web-test):
   │   ├─► test --ticket=ID (runs test)
   │   └─► ship (if test fails, retry up to 3 times)
   └─► git commit (per batch: after web-test completion)
       Creates: Fully implemented feature with test coverage and batch commits

EXISTING PROJECT (add features):

Option A: Using plan directly (interactive)
1. plan --prompt="Add dark mode toggle"  → Interactive Q&A
   └─► Creates: tickets.json with PLAN-* tickets
       Asks clarification questions (non-technical)
       Reply "go with recommendations" to accept defaults

Option B: Using tickets --prompt (same as plan)
1. tickets --prompt="Add dark mode toggle"  → Delegates to plan
   └─► Creates: tickets.json with PLAN-* tickets
       Same interactive Q&A as plan command

2. build                 → Same as above (batch process tickets)

Alternative: ship --ticket=ID [--review]  → Implement individual tickets manually (no commits)
```

### Maintenance Workflow

```text
sync-rules               → Keep CLAUDE.md rules updated from kosuke-template
analyse                  → Analyze code quality and fix issues
lint                     → Fix linting errors across codebase
review                   → Review git diff against CLAUDE.md (standalone, no ticket context)
test --prompt="..."      → Run custom E2E tests with automated fixing
```

### Exploration Workflow

```text
getcode "<query>"                      → Explore kosuke-template or any GitHub repo
getcode "owner/repo" "<query>"         → Explore specific repository
getcode --template "<query>"           → Explore kosuke-template (shorthand)
```

## Command Options Summary

### Common Options (Multiple Commands)

| Option               | Commands                   | Description                                                     |
| -------------------- | -------------------------- | --------------------------------------------------------------- |
| `--pr`               | sync-rules, analyse, lint  | Create pull request with changes                                |
| `--base-branch=NAME` | sync-rules, analyse, lint  | Base branch for PR (default: current)                           |
| `--directory=PATH`   | lint, tickets, ship, build | Working directory (default: cwd)                                |
| `--dir=PATH`         | tickets, ship, build       | Alias for --directory                                           |
| `--tickets=FILE`     | ship, build                | Path to tickets.json file                                       |
| `--verbose`          | build, test                | Enable verbose output (shows Claude tool usage and exploration) |
| `--headless`         | build, test                | Run browser in headless mode for web tests                      |
| `--trace`            | build, test                | Enable Playwright trace recording (saves video/screenshots)     |
| `--no-logs`          | All commands               | Disable logging to Kosuke API                                   |

### Command-Specific Options

#### requirements

- No options (fully interactive)

#### plan

- `--prompt="..."` - Feature or bug description (required)
- `--directory=PATH` - Directory with existing code (default: cwd)
- `--dir=PATH` - Alias for --directory
- `--output=FILE` - Output file for tickets (default: tickets.json)
- `--no-test` - Skip PLAN-WEB-TEST ticket generation

**Features:**

- Interactive clarification questions (non-technical, user-focused)
- Explores codebase to understand patterns
- Reply "go with recommendations" to accept all defaults
- Generates PLAN-\* prefixed tickets

Examples:

- `kosuke plan --prompt="Add dark mode toggle"` - Interactive planning
- `kosuke plan --prompt="Fix login bug" --dir=./app` - With directory

#### tickets

- `--prompt="..."` - Feature/bug description (triggers interactive mode via plan)
- `--path=FILE` - Path to requirements document (default: docs.md)
- `--prompt="..."` - Inline requirements (alternative to --path)
- `--scaffold` - Enable scaffold mode for new projects (default: logic-only mode)
- `--directory=PATH` - Directory for Claude to explore (default: cwd)
- `--dir=PATH` - Alias for --directory
- `--output=FILE` - Output file for tickets (default: tickets.json)
- `--no-test` - Skip WEB-TEST ticket generation

**Prompt Mode (--prompt):**

- Uses `plan` command internally for interactive ticket creation
- Asks clarification questions before generating tickets
- Generates PLAN-\* prefixed tickets
- Best for: Adding features or fixing bugs in existing projects

**Logic-Only Mode (default):**

- Analyzes requirements to determine which layers (schema/backend/frontend) are needed
- Generates only required tickets (e.g., frontend-only for UI changes)
- Infers tech stack from codebase exploration
- Best for existing projects and adding features

**Scaffold Mode (--scaffold):**

- Generates scaffold batch (infrastructure setup) + logic batch (business logic)
- Analyzes requirements against Kosuke Template baseline
- Full 10-phase ticket generation with test coverage
- Best for new projects based on Kosuke Template

Examples:

- `kosuke tickets --prompt="Add dark mode toggle"` - Interactive with questions (uses plan)
- `kosuke tickets` - Document mode from docs.md
- `kosuke tickets --path=feature.md` - Document mode from custom file
- `kosuke tickets --scaffold` - Scaffold + logic from docs.md

#### ship

- `--ticket=ID` - Ticket ID to implement (required)
- `--review` - Review git diff with ticket context
- `--db-url=URL` - Database URL for migrations (default: postgres://postgres:postgres@localhost:5432/postgres)

Note: Ship implements tickets but does NOT commit. Use build command for commits.

#### build

- `--reset` - Reset all tickets to "Todo" before processing
- `--ask-confirm` - Ask for confirmation before each ticket
- `--ask-commit` - Ask before committing each batch (default: auto-commit)
- `--review` - Enable code review for implementation tickets (default: true)
- `--url=URL` - Base URL for web tests (default: http://localhost:3000)
- `--db-url=URL` - Database URL for db tests (default: postgres://postgres:postgres@localhost:5432/postgres)
- `--headless` - Run browser in headless mode for web tests
- `--verbose` - Enable verbose output for tests

Note: Build processes tickets in order (schema → db-test → backend → frontend → web-test).
Commits in batches after web-test completion. Test tickets auto-retry with fixes (max 3 attempts).

#### test

- `--ticket=ID` - Test ticket from tickets.json (WEB-TEST-X or DB-TEST-X)
- `--prompt="..."` - Custom test prompt (alternative to --ticket)
- `--type=TYPE` - Manual test type: web-test or db-test (auto-detected from ticket)
- `--url=URL` - Base URL for web tests (default: http://localhost:3000)
- `--db-url=URL` - Database URL for db tests (default: postgres://postgres:postgres@localhost:5432/postgres)
- `--headless` - Run browser in headless mode (web-test only)
- `--verbose` - Enable verbose output (shows Claude reasoning and Playwright tool usage)
- `--trace` - Enable Playwright trace recording (saves video/screenshots for debugging)

**Playwright MCP Mode:**

All tests use Playwright MCP with Claude AI:

- Claude controls the browser using Playwright MCP tools
- Single atomic execution (no retries, no automatic fixing)
- Optional trace recording with `--trace` flag (includes video playback in Playwright trace viewer)
- Trace files saved to `/tmp/playwright-mcp-output/` directory

**Examples:**

```bash
# Basic test
kosuke test --prompt="Test login flow"

# With verbose output
kosuke test --prompt="Test checkout" --verbose

# With trace recording (video/screenshots)
kosuke test --prompt="Test user dashboard" --trace

# Headless mode
kosuke test --prompt="Test signup" --headless

# View trace file (with embedded video)
npx playwright show-trace /tmp/playwright-mcp-output/.../trace.trace
```

Note: Atomic testing (no fixes, no linting). For test+fix workflow, use build command.

#### analyse

- `--scope=DIRS` - Analyze specific directories (comma-separated)
- `--types=EXTS` - Analyze specific file types (comma-separated)

#### sync-rules

- `--force` - Compare files regardless of commit history

#### getcode

- `--template, -t` - Use kosuke-template repository
- `--output=FILE` - Save output to file

## File Structure

### Generated Files

| File            | Created By   | Purpose                                 |
| --------------- | ------------ | --------------------------------------- |
| `docs.md`       | requirements | Product requirements and specifications |
| `tickets.json`  | tickets      | Structured implementation tickets       |
| `.kosukeignore` | User         | Exclude files/directories from analysis |

#### Ticket JSON Structure

Each ticket in `tickets.json` has the following structure:

```json
{
  "id": "LOGIC-BACKEND-1",
  "title": "Create user API endpoints",
  "description": "Detailed description with acceptance criteria...",
  "type": "schema" | "backend" | "frontend" | "test",
  "estimatedEffort": 5,
  "status": "Todo" | "InProgress" | "Done" | "Failed",
  "category": "users"
}
```

**Valid Ticket Types:**

- `"schema"` - Database schema changes (auto-validated after implementation)
- `"backend"` - Backend API/logic implementation
- `"frontend"` - Frontend UI implementation
- `"test"` - E2E tests (web tests, database tests, etc.)

**Important:** All test tickets use `type: "test"` regardless of the test category. The ticket ID prefix distinguishes the test type:

- `LOGIC-WEB-TEST-1` → Web E2E test (type: "test")
- `LOGIC-DB-TEST-1` → Database test (type: "test")
- `SCAFFOLD-WEB-TEST-1` → Scaffold web test (type: "test")

### Cached Files (Git Ignored)

| Directory/File                | Created By | Purpose                                    |
| ----------------------------- | ---------- | ------------------------------------------ |
| `.tmp/repos/`                 | getcode    | Cached GitHub repositories (owner\_\_repo) |
| `/tmp/playwright-mcp-output/` | test       | Playwright trace files (video/screenshots) |
