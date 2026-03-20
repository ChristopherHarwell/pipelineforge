# PipelineForge

DAG-based SDLC pipeline orchestrator that coordinates OpenClaw agents inside containers via Lobster workflows.

## Problem

Modern software projects that use Claude Code follow a structured SDLC: requirements (TRD) -> architecture (HLD/DLD) -> ticket decomposition -> implementation -> QA review -> type review -> security review -> staff review -> VP review. Each step is defined as a Claude Code skill (`~/.claude/skills/*/SKILL.md`) and invoked manually via slash commands, one at a time.

This has three problems:

1. **No parallelism** -- QA review runs 6 independent agents, type review runs 6, security review runs 6. Today these 18 reviews execute sequentially. They could run concurrently.
2. **No automation** -- Gate conditions (e.g., "6/6 QA approvals required") are checked manually. Rejection routing (send feedback back to the implementer and re-run) is manual. Resuming after a pause is manual.
3. **No isolation** -- Implementation steps write directly to the working tree. There is no dry-run preview, no worktree isolation, and no merge gate.

PipelineForge solves all three by turning the SDLC into a declarative, executable pipeline.

## How It Works

Each SDLC skill becomes a **blueprint** -- a YAML file declaring what to run, what it depends on, how to evaluate its output, and how many parallel instances to spawn. PipelineForge reads these blueprints, builds a directed acyclic graph (DAG) of dependencies, and executes nodes by spawning OpenClaw agents inside Docker containers. Lobster workflow files act as the orchestration layer, sequencing steps, piping data, and pausing at approval gates.

```
pipelineforge run --feature "Add rate limiting to API"

+----------------+
| project-init   |    Phase 1: TRD (human gate)
+-------+--------+
        v
+----------------+
|assign-tickets  |    Phase 2: Decompose into tickets
+-------+--------+
        v (fan-out: N tickets)
+----------------+  +----------------+  +----------------+
|implement-001   |  |implement-002   |  |implement-003   |  Worktree isolation
+-------+--------+  +-------+--------+  +-------+--------+
        v                    v                    v (fan-out: 18 reviews each)
  +----------+         +----------+         +----------+
  |QA x 6   |         |QA x 6   |         |QA x 6   |
  |Type x 6 |         |Type x 6 |         |Type x 6 |   All run in parallel
  |Sec x 6  |         |Sec x 6  |         |Sec x 6  |
  +----+-----+         +----+-----+         +----+-----+
       v                    v                    v (fan-in)
  +----------+         +----------+         +----------+
  | scan-1   |         | scan-2   |         | scan-3   |
  +----+-----+         +----+-----+         +----+-----+
       +--------+-------+                        |
                v                                 |
         +----------------+                       |
         | staff-review   |<----------------------+
         +-------+--------+
                 v
         +----------------+
         |  vp-review     |    Final human gate
         +----------------+
```

**Key constraint: no direct Claude API usage.** PipelineForge never imports `@anthropic-ai/sdk` or `claude_agent_sdk`. All AI execution is delegated to OpenClaw agents running inside Docker containers. OpenClaw handles container lifecycle, model selection, and tool access. PipelineForge only handles scheduling, gating, and state.

## Architecture

```
pipelineforge sync --generate-config --generate-lobster
       |
       +-- ~/.claude/skills/*/SKILL.md  -->  blueprints/*.yaml
       +-- blueprints/*.yaml + pipeline config  -->  openclaw.json (agent configs)
       +-- pipeline config + blueprints  -->  full-sdlc.lobster (workflow)

lobster run full-sdlc.lobster
       |
       +-- Step: openclaw sessions spawn --agent project-init --message "..."
       |         --> OpenClaw gateway reads openclaw.json agent config
       |         --> spawns container with model/tools/sandbox from config
       |         --> agent runs, returns output
       |
       +-- Step: openclaw sessions spawn --agent assign-tickets --message "..."
       |         (receives prior step stdout as context)
       |
       +-- Approval gate: approve-tickets
       |
       +-- ... (implement --> qa --> type --> security --> staff --> vp --> summary)
```

See [docs/running-the-pipeline.md](docs/running-the-pipeline.md) for a quick-start guide to running the pipeline with Docker orchestration, and [docs/adding-a-skill.md](docs/adding-a-skill.md) for adding new skills.

### Three-Layer Stack

| Layer | Technology | Role |
|-------|-----------|------|
| **Orchestration** | Lobster `.lobster` files | Workflow sequencing, approval gates, inter-step data piping |
| **Agent Management** | OpenClaw gateway + `openclaw.json` | Agent configs (model, tools, sandbox), container lifecycle |
| **Scheduling** | PipelineForge DAG executor | Dependency resolution, parallel dispatch, state persistence |

### Core Components

| Component | File | Purpose |
|-----------|------|---------|
| **Skill Parser** | `src/core/SkillFrontmatterParser.ts` | Discovers skills, extracts YAML frontmatter from SKILL.md |
| **Blueprint Syncer** | `src/core/BlueprintSyncer.ts` | Merges derivable fields into blueprint YAML, preserves manual config |
| **OpenClaw Config Syncer** | `src/core/OpenClawConfigSyncer.ts` | Generates `openclaw.json` gateway configs from blueprints |
| **Lobster Generator** | `src/core/LobsterWorkflowGenerator.ts` | Generates `.lobster` workflow files with `openclaw sessions spawn` steps |
| **Blueprint Registry** | `src/core/BlueprintRegistry.ts` | Loads and validates blueprint YAML files from `blueprints/` |
| **DAG Builder** | `src/core/DagBuilder.ts` | Resolves dependencies into a topologically sorted execution graph with cycle detection |
| **DAG Executor** | `src/core/DagExecutor.ts` | Pure FSM-driven scheduler -- walks the graph, dispatches ready nodes, handles pause/resume |
| **Gate Evaluator** | `src/core/GateEvaluator.ts` | Evaluates gate conditions (approval, quality, human, composite) and produces FSM events |
| **State Manager** | `src/core/StateManager.ts` | Persists pipeline state to JSON for resume-after-interruption |
| **Proxy Session Manager** | `src/core/ProxySessionManager.ts` | ExecutionBackend via `openclaw` CLI (spawn, poll, stream) |
| **Proxy Container Manager** | `src/core/ProxyContainerManager.ts` | Manages OpenClaw gateway Docker container lifecycle |
| **Docker Manager** | `src/core/DockerManager.ts` | Direct Docker container execution (fallback path) |
| **Worktree Manager** | `src/core/WorktreeManager.ts` | Creates/merges/cleans up git worktrees for isolated implementation execution |
| **Prompt Builder** | `src/utils/PromptBuilder.ts` | Reads SKILL.md files and renders them into prompts |

### Finite State Machines

All state transitions are modeled as pure FSMs with hex-encoded state IDs and typed transition maps.

**Node FSM** -- 11 states, 15 event types:
```
PENDING(0x0) -> READY(0x1) -> RUNNING(0x2)
                                |
         +----------------------+------------------+
         v                      v                  v
   GATE_PASSED             DRY_RUN_DONE        HUMAN_GATE
   -> PASSED(0x7)          -> AWAITING_PROPOSAL  -> AWAITING_HUMAN(0xA)
                              -> IMPLEMENTING       -> PASSED / FAILED
   GATE_FAILED                -> AWAITING_IMPL
   -> FAILED(0x8)             -> PASSED / FAILED
```

**Pipeline FSM** -- 4 states: `RUNNING(0x0)`, `PAUSED(0x1)`, `COMPLETED(0x2)`, `FAILED(0x3)`

### Implementation Review Flow

Implementation blueprints go through a 5-phase review process:

1. **Dry-run** -- Claude Code runs with `--disallowedTools "Edit,Write,NotebookEdit"` to produce a proposal without modifying files
2. **Human reviews proposal** -- Pipeline pauses for approval
3. **Worktree execution** -- On approval, a git worktree is created and Claude Code runs with full write access, isolated from the main branch
4. **Human reviews implementation** -- Pipeline pauses again for code review
5. **Merge** -- On final approval, the worktree branch merges into main

Review timing is configurable: `--review-timing before|after|both` controls when automated review agents (QA, type, security) run relative to the merge.

### Gate Types

| Type | Behavior |
|------|----------|
| **Approval** | Count N/M approval markers in sibling node outputs (e.g., 6/6 QA agents must output "APPROVED") |
| **Quality** | Check exit codes, pattern match stdout against expected output |
| **Human** | Pause the pipeline and wait for user input via `pipelineforge resume` |
| **Composite** | Approval AND quality must both pass |

## How to Run

### 1. Sync blueprints from SKILL.md files

```bash
# Basic sync -- just updates blueprint YAML from skill frontmatter
pipelineforge sync

# Full sync -- also generates openclaw.json + .lobster workflow
pipelineforge sync \
  --generate-config \
  --generate-lobster \
  --repo-dir /path/to/target/repo \
  --notes-dir /path/to/notes
```

This does three things:
- **Discovers** all `*/SKILL.md` files under `~/.claude/skills/`
- **Syncs** derivable fields (name, description, skill_path, allowed_tools) into `blueprints/*.yaml`
- **Generates** `openclaw.json` (agent configs) and `full-sdlc.lobster` (workflow)

Only 4 blueprint fields are derived from SKILL.md:
- `name` -- from frontmatter `name`
- `description` -- from frontmatter `description`
- `skill_path` -- directory path containing the SKILL.md
- `execution.allowed_tools` -- from frontmatter `allowed-tools` array

All other fields (`model`, `max_turns`, `gate`, `depends_on`, `parallel`, `timeout_minutes`, `docker`, `review_mode`, `requires_repo`) require manual config and are never overwritten during sync.

### 2. Start the OpenClaw gateway and run the pipeline

**Option A: Via PipelineForge DAG executor (proxy mode)**

```bash
pipelineforge run \
  --feature "Your feature description" \
  --proxy \
  --repo-dir /path/to/target/repo \
  --notes-dir /path/to/notes
```

This starts an OpenClaw gateway container, generates agent configs from the DAG, and orchestrates execution through the proxy session manager.

**Option B: Via Lobster workflow (standalone orchestration)**

```bash
lobster run --mode tool --file pipelines/full-sdlc.lobster \
  --args-json '{
    "feature": "Add audit logging",
    "repo_dir": "/path/to/repo",
    "notes_dir": "/path/to/notes",
    "gateway_url": "http://127.0.0.1:18789"
  }'
```

Each Lobster step invokes `openclaw sessions spawn --agent <name>` which:
1. Reads the agent config from `openclaw.json` (model, tools, sandbox)
2. Spawns a Docker container with the configured image and mounts
3. Runs the Claude Code agent inside the container
4. Returns output to the Lobster orchestrator for piping to the next step

Resume after an approval gate:

```bash
lobster resume --token <resumeToken> --approve yes
```

### 3. Set up automatic sync cron (optional)

```bash
openclaw cron add --name sync-blueprints --every 5h \
  --message "sync blueprints"
```

Or run the sync pipeline directly:

```bash
lobster run --mode tool --file pipelines/sync-blueprints.lobster
```

### 4. Build the Docker image

```bash
pipelineforge build-image
# Or manually:
docker build -t pipelineforge-claude docker/
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `pipelineforge auto` | Interactive guided setup: prompts, checks, syncs, builds, and runs everything |
| `pipelineforge run` | Start a new pipeline |
| `pipelineforge resume --id <id>` | Resume a paused pipeline |
| `pipelineforge retry --id <id>` | Retry failed nodes |
| `pipelineforge status [--id <id>]` | Show pipeline status |
| `pipelineforge build-image` | Build the Claude Code Docker image |
| `pipelineforge watch --id <id>` | Attach to a running pipeline interactively |
| `pipelineforge sync` | Sync blueprints and generate configs/workflows |

### Run Options

| Flag | Default | Description |
|------|---------|-------------|
| `--feature <desc>` | (required) | Feature description |
| `--pipeline <name>` | `full-sdlc` | Pipeline template name |
| `--notes-dir <path>` | `$PIPELINEFORGE_NOTES_DIR` | Where to write SDLC artifacts (TRDs, tickets, reviews) |
| `--repo-dir <path>` | auto-created | Project repository path |
| `--max-concurrent <n>` | `20` | Max simultaneous containers |
| `--review-timing <t>` | `before` | When review agents run: `before`, `after`, or `both` merge |
| `--proxy` | `false` | Use OpenClaw proxy container as execution backend |
| `--discord` | `false` | Enable Discord notifications via OpenClaw |

### Sync Options

```
--skill-dir <path>        Skill definitions directory (default: ~/.claude/skills)
--blueprint-dir <path>    Blueprints output directory (default: ./blueprints)
--generate-config         Also generate openclaw.json from synced blueprints
--generate-lobster        Also generate .lobster workflow files
--pipeline <name>         Pipeline template (default: full-sdlc)
--config-output <path>    Output path for openclaw.json
--lobster-output <path>   Output path for .lobster workflow file
--image <name>            Docker worker image name
--repo-dir <path>         Host repo directory for OpenClaw mounts
--notes-dir <path>        Host notes directory for OpenClaw mounts
--state-dir <path>        State directory
--max-concurrent <n>      Max concurrent OpenClaw sessions (default: 20)
--discord-channel <id>    Discord channel ID for OpenClaw config
```

## Development

### Scripts

```bash
npm install               # Install dependencies
npm test                  # Run all tests (vitest)
npm run test:watch        # Watch mode
npm run test:coverage     # Tests with V8 coverage
npm run build             # Compile TypeScript -> dist/
npm run dev               # Run CLI directly via tsx (no build step)
npm run lint              # Type-check without emitting
```

### Project Structure

```
pipelineforge/
+-- src/
|   +-- cli/
|   |   +-- index.ts                    # Commander CLI (run/resume/retry/status/build-image/watch/sync)
|   +-- core/
|   |   +-- BlueprintRegistry.ts        # YAML blueprint loading and validation
|   |   +-- BlueprintSyncer.ts          # Merge SKILL.md frontmatter into blueprint YAML
|   |   +-- DagBuilder.ts               # Dependency graph construction + cycle detection
|   |   +-- DagExecutor.ts              # Pure FSM-driven DAG scheduler
|   |   +-- DockerManager.ts            # Docker container lifecycle (dockerode)
|   |   +-- GateEvaluator.ts            # Gate condition evaluation -> FSM events
|   |   +-- LobsterWorkflowGenerator.ts # Generate .lobster with openclaw sessions spawn
|   |   +-- NodeFSM.ts                  # 11-state node lifecycle FSM
|   |   +-- OpenClawConfigSyncer.ts     # Generate openclaw.json from blueprints
|   |   +-- PipelineFSM.ts              # 4-state pipeline lifecycle FSM
|   |   +-- ProxyContainerManager.ts    # OpenClaw gateway container lifecycle
|   |   +-- ProxySessionManager.ts      # ExecutionBackend via openclaw CLI
|   |   +-- SkillFrontmatterParser.ts   # SKILL.md frontmatter extraction + discovery
|   |   +-- StateManager.ts             # JSON state persistence for pause/resume
|   |   +-- WorktreeManager.ts          # Git worktree create/merge/cleanup
|   +-- types/
|   |   +-- Blueprint.ts                # Zod schema + types for blueprints
|   |   +-- Gate.ts                     # GateResult, RejectionRecord types
|   |   +-- Graph.ts                    # DagNode, DagGraph types
|   |   +-- Pipeline.ts                 # NodeState, PipelineState, ContainerResult
|   |   +-- ProxySession.ts             # OpenClaw agent/gateway config types
|   |   +-- SkillFrontmatter.ts         # Zod schema for SKILL.md, branded SkillName
|   |   +-- SyncResult.ts               # SyncOutcome, SyncEntry, SyncReport types
|   +-- utils/
|       +-- PromptBuilder.ts            # SKILL.md -> rendered prompt
|       +-- TemplateEngine.ts           # Variable substitution engine
|       +-- deepfreeze.ts               # DeepReadonly type + deepFreeze()
+-- tests/
|   +-- unit/                           # 17 test files, 292 tests
|   +-- integration/                    # Streaming HITL tests
|   +-- utils/
|       +-- mock-data.ts                # StableTestId, deepFreeze, scenario factories
+-- blueprints/                         # Blueprint YAML definitions
+-- pipelines/                          # Pipeline YAML + .lobster workflow files
+-- docker/
|   +-- Dockerfile                      # Claude Code Docker image
+-- package.json
+-- tsconfig.json                       # Strict TypeScript config
+-- vitest.config.ts
```

### Test Suite

292 tests across 17 test files. All tests use `createStableTestId()` for randomized test data -- no hardcoded magic values.

- **StableTestId** -- randomized test identifiers prevent coupling to magic values
- **Scenario factories** -- `createApprovalScenario()`, `createExecutorScenario()` for reusable test setups
- **`deepFreeze`** -- all test data is recursively frozen to verify immutability
- **`it.each`** with full type annotations for parameterized tests
- **Section dividers** (`// ===` and `// ---`) for visual test organization

```bash
$ npm test

 17 test files, 292 tests passed
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
| js-yaml 4.x | YAML parsing (read) |
| yaml 2.x | YAML round-trip (read/write with comment preservation) |

## Prerequisites

- **Node.js** >= 22.0.0
- **Docker** installed and running
- **OpenClaw CLI** (`openclaw`) for agent container management
- **Lobster CLI** (`lobster`) for standalone workflow orchestration
- **Claude Code** CLI with valid authentication (`claude login`)

## License

Private project -- not currently licensed for redistribution.
