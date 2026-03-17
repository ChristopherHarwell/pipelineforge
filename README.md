# PipelineForge

DAG-based SDLC pipeline orchestrator that runs Claude Code skills as parallel blueprints in Docker containers.

## Problem

Modern software projects that use Claude Code follow a structured SDLC: requirements (TRD) → architecture (HLD/DLD) → ticket decomposition → implementation → QA review → type review → security review → staff review → VP review. Each step is defined as a Claude Code skill (`~/.claude/skills/*/SKILL.md`) and invoked manually via slash commands, one at a time.

This has three problems:

1. **No parallelism** — QA review runs 6 independent agents, type review runs 6, security review runs 6. Today these 18 reviews execute sequentially. They could run concurrently.
2. **No automation** — Gate conditions (e.g., "6/6 QA approvals required") are checked manually. Rejection routing (send feedback back to the implementer and re-run) is manual. Resuming after a pause is manual.
3. **No isolation** — Implementation steps write directly to the working tree. There is no dry-run preview, no worktree isolation, and no merge gate.

PipelineForge solves all three by turning the SDLC into a declarative, executable pipeline.

## How It Works

Each SDLC skill becomes a **blueprint** — a YAML file declaring what to run, what it depends on, how to evaluate its output, and how many parallel instances to spawn. PipelineForge reads these blueprints, builds a directed acyclic graph (DAG) of dependencies, and executes nodes by spawning Docker containers running Claude Code CLI in non-interactive (`-p`) mode.

```
pipelineforge run --feature "Add rate limiting to API"

┌──────────────┐
│ project-init │    Phase 1: TRD (human gate)
└──────┬───────┘
       ▼
┌──────────────┐
│assign-tickets│    Phase 2: Decompose into tickets
└──────┬───────┘
       ▼ (fan-out: N tickets)
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│implement-001 │  │implement-002 │  │implement-003 │  Worktree isolation
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       ▼                 ▼                 ▼ (fan-out: 18 reviews each)
  ┌────────┐        ┌────────┐        ┌────────┐
  │QA × 6  │        │QA × 6  │        │QA × 6  │
  │Type × 6│        │Type × 6│        │Type × 6│   All run in parallel
  │Sec × 6 │        │Sec × 6 │        │Sec × 6 │
  └────┬───┘        └────┬───┘        └────┬───┘
       ▼                 ▼                 ▼ (fan-in)
  ┌──────────┐      ┌──────────┐      ┌──────────┐
  │  scan-1  │      │  scan-2  │      │  scan-3  │
  └────┬─────┘      └────┬─────┘      └────┬─────┘
       └─────────┬───────┘                 │
                 ▼                         │
          ┌──────────────┐                 │
          │ staff-review │◄────────────────┘
          └──────┬───────┘
                 ▼
          ┌──────────────┐
          │  vp-review   │    Final human gate
          └──────────────┘
```

**Key constraint: no direct Claude API usage.** PipelineForge never imports `@anthropic-ai/sdk` or `claude_agent_sdk`. All AI execution is delegated to Claude Code CLI running inside Docker containers. Claude Code already handles tool use, file I/O, git operations, and permission management — PipelineForge only handles scheduling, gating, and state.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  CLI                                                            │
│  pipelineforge run / resume / status / build-image              │
└───────────┬─────────────────────────────────────────────────────┘
            │
┌───────────▼─────────────────────────────────────────────────────┐
│  Orchestrator Core                                              │
│                                                                 │
│  Blueprint Registry  ─→  DAG Builder  ─→  DAG Executor         │
│                                            │    │    │          │
│                              Gate Evaluator ◄───┘    │          │
│                              State Manager  ◄────────┘          │
│                              Worktree Manager                   │
└───────────┬─────────────────────────────────────────────────────┘
            │
┌───────────▼─────────────────────────────────────────────────────┐
│  Execution Layer                                                │
│                                                                 │
│  Docker Manager  ─→  Container 1 (claude -p "...")              │
│                  ─→  Container 2 (claude -p "...")              │
│                  ─→  Container N (claude -p "...")              │
└───────────┬─────────────────────────────────────────────────────┘
            │
┌───────────▼─────────────────────────────────────────────────────┐
│  Filesystem                                                     │
│                                                                 │
│  ~/.claude/skills/    Project repo    Git worktrees              │
│  Notes directory      Pipeline state (.pipelineforge/)          │
└─────────────────────────────────────────────────────────────────┘
```

### Core Components

| Component | Purpose |
|-----------|---------|
| **Blueprint Registry** | Loads and validates blueprint YAML files from `blueprints/` |
| **DAG Builder** | Resolves dependencies into a topologically sorted execution graph with cycle detection |
| **DAG Executor** | Pure FSM-driven scheduler — walks the graph, dispatches ready nodes, handles pause/resume |
| **Gate Evaluator** | Evaluates gate conditions (approval, quality, human, composite) and produces FSM events |
| **State Manager** | Persists pipeline state to JSON for resume-after-interruption |
| **Docker Manager** | Spawns Docker containers with bind mounts, captures stdout/stderr, enforces timeouts |
| **Worktree Manager** | Creates/merges/cleans up git worktrees for isolated implementation execution |
| **Prompt Builder** | Reads SKILL.md files and renders them into prompts (slash commands aren't available in `-p` mode) |

### Finite State Machines

All state transitions are modeled as pure FSMs with hex-encoded state IDs and typed transition maps.

**Node FSM** — 11 states, 15 event types:
```
PENDING(0x0) → READY(0x1) → RUNNING(0x2)
                                │
         ┌──────────────────────┼──────────────────┐
         ▼                      ▼                  ▼
   GATE_PASSED             DRY_RUN_DONE        HUMAN_GATE
   → PASSED(0x7)           → AWAITING_PROPOSAL  → AWAITING_HUMAN(0xA)
                              → IMPLEMENTING       → PASSED / FAILED
   GATE_FAILED                → AWAITING_IMPL
   → FAILED(0x8)              → PASSED / FAILED
```

**Pipeline FSM** — 4 states: `RUNNING(0x0)`, `PAUSED(0x1)`, `COMPLETED(0x2)`, `FAILED(0x3)`

### Implementation Review Flow

Implementation blueprints go through a 5-phase review process:

1. **Dry-run** — Claude Code runs with `--disallowedTools "Edit,Write,NotebookEdit"` to produce a proposal without modifying files
2. **Human reviews proposal** — Pipeline pauses for approval
3. **Worktree execution** — On approval, a git worktree is created and Claude Code runs with full write access, isolated from the main branch
4. **Human reviews implementation** — Pipeline pauses again for code review
5. **Merge** — On final approval, the worktree branch merges into main

Review timing is configurable: `--review-timing before|after|both` controls when automated review agents (QA, type, security) run relative to the merge.

### Gate Types

| Type | Behavior |
|------|----------|
| **Approval** | Count N/M approval markers in sibling node outputs (e.g., 6/6 QA agents must output "APPROVED") |
| **Quality** | Check exit codes, pattern match stdout against expected output |
| **Human** | Pause the pipeline and wait for user input via `pipelineforge resume` |
| **Composite** | Approval AND quality must both pass |

## Prerequisites

- **Node.js** >= 22.0.0
- **Docker** installed and running
- **Claude Code** CLI with valid authentication (`claude login`)
- **Claude Teams** subscription (or API key configured)

## Installation

```bash
git clone <repo-url>
cd pipelineforge
npm install
```

## Usage

### Build the Docker image

```bash
pipelineforge build-image
# Or manually:
docker build -t pipelineforge-claude docker/
```

### Run a pipeline

```bash
# Full SDLC pipeline for a new feature
pipelineforge run \
  --feature "Add tenant-scoped rate limiting" \
  --notes-dir "/path/to/notes" \
  --repo-dir "/path/to/project" \
  --max-concurrent 20 \
  --review-timing before

# Resume a paused pipeline (after human gate approval)
pipelineforge resume --id <pipeline-id>

# Check pipeline status
pipelineforge status
pipelineforge status --id <pipeline-id>
```

### CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--feature <desc>` | (required) | Feature description |
| `--pipeline <name>` | `full-sdlc` | Pipeline template name |
| `--notes-dir <path>` | `$PIPELINEFORGE_NOTES_DIR` | Where to write SDLC artifacts (TRDs, tickets, reviews) |
| `--repo-dir <path>` | `cwd` | Project repository path |
| `--max-concurrent <n>` | `20` | Max simultaneous Docker containers |
| `--review-timing <t>` | `before` | When review agents run: `before`, `after`, or `both` merge |

## Development

### Scripts

```bash
npm test              # Run all tests (vitest)
npm run test:watch    # Watch mode
npm run test:coverage # Tests with V8 coverage
npm run build         # Compile TypeScript → dist/
npm run dev           # Run CLI directly via tsx (no build step)
npm run lint          # Type-check without emitting
```

### Type-level tests

Compile-time assertions verify FSM state encodings at the type level:

```bash
npx tsc --project tsconfig.typetest.json
```

These tests use `Assert<Equal<...>>` and `@ts-expect-error` patterns — they produce zero JavaScript output and catch type regressions at compile time.

### Project Structure

```
pipelineforge/
├── src/
│   ├── cli/
│   │   └── index.ts              # Commander CLI (run/resume/status/build-image)
│   ├── core/
│   │   ├── BlueprintRegistry.ts  # YAML blueprint loading and validation
│   │   ├── DagBuilder.ts         # Dependency graph construction + cycle detection
│   │   ├── DagExecutor.ts        # Pure FSM-driven DAG scheduler
│   │   ├── DockerManager.ts      # Docker container lifecycle (dockerode)
│   │   ├── GateEvaluator.ts      # Gate condition evaluation → FSM events
│   │   ├── NodeFSM.ts            # 11-state node lifecycle FSM
│   │   ├── PipelineFSM.ts        # 4-state pipeline lifecycle FSM
│   │   ├── StateManager.ts       # JSON state persistence for pause/resume
│   │   └── WorktreeManager.ts    # Git worktree create/merge/cleanup
│   ├── types/
│   │   ├── Blueprint.ts          # Zod schema + TypeScript types for blueprints
│   │   ├── Gate.ts               # GateResult, RejectionRecord types
│   │   ├── Graph.ts              # DagNode, DagGraph types
│   │   └── Pipeline.ts           # NodeState, PipelineState, ContainerResult
│   └── utils/
│       ├── PromptBuilder.ts      # SKILL.md → rendered prompt
│       └── TemplateEngine.ts     # Variable substitution engine
├── tests/
│   ├── unit/
│   │   ├── DagBuilder.test.ts        #   7 tests
│   │   ├── DagExecutor.test.ts       #  19 tests
│   │   ├── DockerManager.test.ts     #  20 tests
│   │   ├── GateEvaluator.test.ts     #  29 tests
│   │   ├── NodeFSM.test.ts           #  41 tests
│   │   ├── PipelineFSM.test.ts       #  16 tests
│   │   ├── StateManager.test.ts      #  13 tests
│   │   ├── TemplateEngine.test.ts    #  11 tests
│   │   └── WorktreeManager.test.ts   #  23 tests
│   ├── types/
│   │   ├── NodeFSM.typetest.ts       # Compile-time state ID assertions
│   │   └── PipelineFSM.typetest.ts   # Compile-time state ID assertions
│   └── utils/
│       └── mock-data.ts              # StableTestId, deepFreeze, scenario factories
├── blueprints/                       # Blueprint YAML definitions (TODO)
├── pipelines/                        # Pipeline template YAML definitions (TODO)
├── docker/
│   └── Dockerfile                    # Claude Code Docker image
├── package.json
├── tsconfig.json                     # Strict TypeScript config
├── tsconfig.typetest.json            # Config for compile-time type tests
└── vitest.config.ts
```

### Test Suite

179 tests across 9 test files. Tests follow these patterns:

- **StableTestId** — randomized test identifiers prevent coupling to magic values
- **Scenario factories** — `createApprovalScenario()`, `createExecutorScenario()` for reusable test setups
- **`deepFreeze`** — all test data is recursively frozen to verify immutability
- **`it.each`** with full type annotations for parameterized tests
- **Section dividers** (`// ═══` and `// ───`) for visual test organization

```bash
$ npm test

 ✓ tests/unit/TemplateEngine.test.ts      (11 tests)
 ✓ tests/unit/PipelineFSM.test.ts         (16 tests)
 ✓ tests/unit/DagBuilder.test.ts          ( 7 tests)
 ✓ tests/unit/GateEvaluator.test.ts       (29 tests)
 ✓ tests/unit/NodeFSM.test.ts             (41 tests)
 ✓ tests/unit/WorktreeManager.test.ts     (23 tests)
 ✓ tests/unit/DagExecutor.test.ts         (19 tests)
 ✓ tests/unit/StateManager.test.ts        (13 tests)
 ✓ tests/unit/DockerManager.test.ts       (20 tests)

 Test Files  9 passed (9)
      Tests  179 passed (179)
```

### Tech Stack

| Technology | Purpose |
|-----------|---------|
| TypeScript 5.8 | Language (strict mode, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`) |
| Node.js 22+ | Runtime |
| Vitest 3.x | Test framework |
| Commander 13.x | CLI argument parsing |
| dockerode 4.x | Programmatic Docker API |
| Zod 3.x | Blueprint schema validation |
| js-yaml 4.x | YAML parsing |

## Status

PipelineForge is in active development. The orchestrator core (FSMs, gate evaluation, Docker management, worktree management, state persistence) is implemented and tested. Remaining work:

- Blueprint YAML files for all 15 SDLC skills
- Pipeline template YAML files (full-sdlc, feature-only, review-only)
- CLI wiring (connect commands to orchestrator core)
- Dynamic fan-out (assign-tickets producing N implement-ticket nodes at runtime)
- DagExecutor tests for edge cases (multi-level dependency chains, rejection routing loops)

## License

Private project — not currently licensed for redistribution.
