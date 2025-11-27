# Kosuke CLI - Command Dependencies Map

## Command Dependency Graph

```text
┌──────────────────────────────────────────────────────────────────────────┐
│                        STANDALONE COMMANDS                               │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  analyse    getcode    sync-rules    requirements    tickets            │
│     │          │            │              │             │              │
│     └──────────┴────────────┴──────────────┴─────────────┘              │
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
│       ├─► review (conditional)             ├─► ship (loop)              │
│       ├─► test (conditional)               │   ├─► review (always)      │
│       └─► lint (always)                    │   ├─► test (frontend only) │
│                                            │   ├─► lint (always)        │
│                                            │   └─► commit (per ticket)  │
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

| Command          | Dependencies                            | Called By           | Core/Wrapper | Description                                     |
| ---------------- | --------------------------------------- | ------------------- | ------------ | ----------------------------------------------- |
| **analyse**      | -                                       | -                   | Core         | Analyze code quality issues                     |
| **getcode**      | repository-manager, repository-resolver | -                   | Core         | Explore GitHub repositories                     |
| **sync-rules**   | -                                       | -                   | Core         | Sync CLAUDE.md rules from template              |
| **requirements** | -                                       | -                   | Core         | Interactive requirements gathering              |
| **tickets**      | -                                       | -                   | Core         | Generate tickets from requirements              |
| **lint**         | validator.ts                            | review, ship, build | Core         | Fix linting errors with Claude                  |
| **review**       | reviewCore, lint                        | ship (conditional)  | Wrapper      | Review git diff against CLAUDE.md               |
| **test**         | testCore, log-collector, browser-agent  | ship (conditional)  | Core         | E2E testing with automated fixing               |
| **ship**         | reviewCore, testCore, lint              | build               | Orchestrator | Implement a single ticket (no commit)           |
| **build**        | ship, git commit                        | -                   | Orchestrator | Build entire project from tickets, commits each |

## Utility Dependencies

| Utility                    | Used By                   | Purpose                            |
| -------------------------- | ------------------------- | ---------------------------------- |
| **claude-agent.ts**        | All commands              | Centralized Claude SDK integration |
| **validator.ts**           | lint, review, ship, build | Comprehensive linting              |
| **git.ts**                 | review, build             | Git operations                     |
| **github.ts**              | sync-rules, build         | GitHub API integration             |
| **repository-manager.ts**  | getcode                   | Clone/update repos                 |
| **repository-resolver.ts** | getcode                   | Infer repo from queries            |
| **tickets-manager.ts**     | ship, build, test         | Load/update tickets.json           |
| **error-analyzer.ts**      | ship, test                | Analyze test/runtime failures      |
| **log-collector.ts**       | ship, test                | Collect Docker/test logs           |
| **browser-agent.ts**       | test                      | Playwright browser automation      |
| **pr-orchestrator.ts**     | ship, build, test         | Create PRs                         |
| **prompt-generator.ts**    | ship, test                | Generate prompts for Claude        |
| **batch-creator.ts**       | analyse                   | Create file batches for processing |
| **file-discovery.ts**      | analyse, lint             | File scanning with .kosukeignore   |
| **logger.ts**              | All commands              | Execution logging to Kosuke API    |

## Call Graph (Nested)

```text
build
├── ship (loop for each ticket)
│   ├── reviewCore (ALWAYS runs, WITH ticket context)
│   ├── testCore (conditional, auto-runs for frontend tickets)
│   └── lint
└── git commit (per ticket, auto or ask with --ask-commit)

ship
├── reviewCore (conditional via --review flag, WITH ticket context)
├── testCore (conditional via --test flag)
└── lint (always)
(Note: Ship does NOT commit - commits only through build command)

review
├── reviewCore (standalone, no ticket context)
└── lint

lint
└── validator.ts

test
├── browser-agent.ts (Playwright automation)
├── error-analyzer.ts (analyze failures)
├── log-collector.ts (collect logs)
└── claude-agent.ts (fix issues)

requirements
└── Anthropic SDK directly (custom tools for docs.md)

tickets
├── claude-agent.ts (generate scaffold tickets: schema, backend, frontend)
└── claude-agent.ts (generate logic tickets: schema, backend, frontend)
```

## External Dependencies

| Command               | External Services        | Environment Variables                                              |
| --------------------- | ------------------------ | ------------------------------------------------------------------ |
| All commands          | Anthropic Claude API     | `ANTHROPIC_API_KEY` (required)                                     |
| All commands          | Kosuke API (optional)    | `KOSUKE_BASE_URL`, `KOSUKE_API_KEY`, `KOSUKE_PROJECT_ID` (logging) |
| build (default)       | GitHub API               | `GITHUB_TOKEN` (required for git commits)                          |
| sync-rules (--pr)     | GitHub API               | `GITHUB_TOKEN` (required)                                          |
| analyse (--pr)        | GitHub API               | `GITHUB_TOKEN` (required)                                          |
| lint (--pr)           | GitHub API               | `GITHUB_TOKEN` (required)                                          |
| test (--pr)           | GitHub API               | `GITHUB_TOKEN` (required)                                          |
| getcode               | GitHub API (optional)    | `GITHUB_TOKEN` (optional, for cloning)                             |
| ship (schema tickets) | PostgreSQL               | `POSTGRES_URL` (from --db-url)                                     |
| test                  | Web browser (Playwright) | -                                                                  |

## Command Workflow Overview

### Development Workflow (Full Cycle)

```text
1. requirements          → Interactive requirements gathering
   └─► Creates: docs.md

2. tickets               → Generate structured tickets from requirements
   └─► Creates: tickets.json (6 phases: Scaffold + Logic for Schema/Backend/Frontend)
       Claude analyzes requirements vs template baseline during ticket generation

3. build                 → Batch process all tickets
   ├─► For each ticket:
   │   ├─► ship --ticket=ID (implements)
   │   ├─► review (always, with ticket context)
   │   ├─► lint (always)
   │   ├─► test (auto for frontend tickets)
   │   └─► git commit (auto, or ask with --ask-commit)
   └─► Creates: Fully implemented feature with commits

Alternative: ship --ticket=ID [--review] [--test]  → Implement individual tickets manually (no commits)
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

| Option               | Commands                         | Description                           |
| -------------------- | -------------------------------- | ------------------------------------- |
| `--pr`               | sync-rules, analyse, lint, test  | Create pull request with changes      |
| `--base-branch=NAME` | sync-rules, analyse, lint, test  | Base branch for PR (default: current) |
| `--directory=PATH`   | lint, tickets, ship, build, test | Working directory (default: cwd)      |
| `--dir=PATH`         | tickets, ship, build, test       | Alias for --directory                 |
| `--tickets=FILE`     | ship, build, test                | Path to tickets.json file             |
| `--no-logs`          | All commands                     | Disable logging to Kosuke API         |

### Command-Specific Options

#### requirements

- No options (fully interactive)

#### tickets

- `--path=FILE` - Path to requirements document (default: docs.md)
- `--directory=PATH` - Directory for Claude to explore (default: cwd)
- `--output=FILE` - Output file for tickets (default: tickets.json)

#### ship

- `--ticket=ID` - Ticket ID to implement (required)
- `--review` - Review git diff with ticket context
- `--test` - Run E2E tests
- `--db-url=URL` - Database URL for migrations

Note: Ship implements tickets but does NOT commit. Use build command for commits.

#### build

- `--reset` - Reset all tickets to "Todo" before processing
- `--ask-confirm` - Ask for confirmation before each ticket
- `--ask-commit` - Ask before committing each ticket (default: auto-commit)
- `--db-url=URL` - Database URL for migrations

Note: Build always enables `--review` for quality assurance on all tickets.
Build commits each ticket individually to current branch (auto or interactive with --ask-commit).

#### test

- `--ticket=ID` - Test ticket from tickets.json
- `--prompt="..."` - Custom test prompt (alternative to --ticket)
- `--url=URL` - Base URL (default: <http://localhost:3000>)
- `--headed` - Show browser window
- `--debug` - Enable Playwright inspector
- `--update-baseline` - Update visual baselines
- `--max-retries=N` - Max fix attempts (default: 3)

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

### Cached Files (Git Ignored)

| Directory/File  | Created By | Purpose                                    |
| --------------- | ---------- | ------------------------------------------ |
| `.tmp/repos/`   | getcode    | Cached GitHub repositories (owner\_\_repo) |
| `test-results/` | test       | Playwright test results and screenshots    |
