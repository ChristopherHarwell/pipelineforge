# Running the SDLC Pipeline

Quick-start guide for running the full SDLC pipeline with Docker container orchestration and verifying it's working.

## Fastest path: `pipelineforge auto`

The `auto` command walks you through everything interactively — checks prerequisites, builds the Docker image if needed, syncs blueprints, generates configs, and runs the pipeline:

```bash
pipelineforge auto
# or via npm
npm run auto
```

It will prompt you for:
- **Feature description** (required) — what you're building
- **Target repo directory** — where the project code lives (default: current directory)
- **Notes directory** — where SDLC artifacts (TRDs, tickets, reviews) are written
- **Pipeline template** — which pipeline to run (default: `full-sdlc`)
- **Max concurrent containers** — parallelism limit (default: 20)
- **Review timing** — when reviews run relative to merge (`before`/`after`/`both`)
- **Discord notifications** — optionally enable Discord thread notifications
- **Skill definitions directory** — where `SKILL.md` files live (default: `~/.claude/skills`)

After confirming the summary, it automatically:
1. Verifies Docker is running
2. Builds `pipelineforge-claude` (worker) and `pipelineforge-gateway` (gateway) images if they don't exist
3. Verifies Claude credentials (Claude Max OAuth or `ANTHROPIC_API_KEY`)
4. Syncs blueprints from `SKILL.md` frontmatter
5. Generates `openclaw.json` and `.lobster` workflow
6. Starts the OpenClaw gateway container
7. Executes the full pipeline with streaming HITL support

**Authentication**: Either Claude Max (run `claude login`) or `ANTHROPIC_API_KEY` env var. Claude Max OAuth credentials in `~/.claude/` are mounted into containers automatically.

---

If you need more control over individual steps, read on for the manual workflow.

## Prerequisites

| Requirement | How to verify |
|-------------|---------------|
| **Node.js** >= 22 | `node --version` |
| **Docker** running | `docker info` |
| **OpenClaw CLI** installed | `openclaw --version` |
| **Lobster CLI** installed | `lobster --version` |
| **Claude Code** authenticated | `claude login` |

Environment variables (or pass as CLI flags):

```bash
export OPENCLAW_URL="http://127.0.0.1:18789"   # gateway URL
export OPENCLAW_TOKEN="<your-token>"             # bearer token
```

## 1. Build Docker images (one-time)

```bash
# Build both worker and gateway images
pipelineforge build-image --gateway

# Or build individually
pipelineforge build-image                # worker only
pipelineforge build-image --gateway-only # gateway only
```

This builds two images:
- **`pipelineforge-claude`** (worker) from `docker/Dockerfile` -- Node 22 slim + Claude Code CLI, git, ripgrep, jq
- **`pipelineforge-gateway`** from `docker/Dockerfile.gateway` -- Node 22 slim + OpenClaw CLI + Docker CLI

Verify:

```bash
docker images pipelineforge-claude pipelineforge-gateway
```

## 2. Sync blueprints and generate configs

```bash
pipelineforge sync \
  --generate-config \
  --generate-lobster \
  --repo-dir /path/to/target/repo \
  --notes-dir /path/to/sdlc/notes
```

This reads `~/.claude/skills/*/SKILL.md` files and produces:
- `blueprints/*.yaml` -- updated blueprint definitions
- `openclaw.json` -- agent configs (model, tools, sandbox mounts)
- `pipelines/full-sdlc.lobster` -- orchestration workflow

## 3. Run the pipeline

### Option A: Proxy mode (recommended)

Proxy mode starts the OpenClaw gateway container, spawns agent containers through it, and supports real-time streaming output with human-in-the-loop interaction.

```bash
pipelineforge run \
  --feature "Add rate limiting to API" \
  --proxy \
  --repo-dir /path/to/target/repo \
  --notes-dir /path/to/sdlc/notes
```

With Discord notifications (see [docs/discord-setup.md](discord-setup.md) for full setup guide):

```bash
export DISCORD_BOT_TOKEN="your-bot-token"  # one-time setup

pipelineforge run \
  --feature "Add rate limiting to API" \
  --proxy \
  --repo-dir /path/to/target/repo \
  --notes-dir /path/to/sdlc/notes \
  --discord \
  --discord-channel 1234567890
```

What happens:
1. OpenClaw gateway container starts on port 18789
2. DAG is built from blueprint dependencies
3. Nodes execute as Docker containers spawned by the gateway
4. Parallel review agents (QA, Type, Security) run concurrently -- up to 20 containers
5. Pipeline pauses at human gates (staff-review, vp-review) for your approval
6. State persists to `~/.pipelineforge/state/<pipeline-id>/state.json`

### Option B: Lobster standalone

If you want to use Lobster as the orchestration layer directly:

```bash
lobster run --mode tool --file pipelines/full-sdlc.lobster \
  --args-json '{
    "feature": "Add rate limiting to API",
    "repo_dir": "/path/to/target/repo",
    "notes_dir": "/path/to/sdlc/notes",
    "gateway_url": "http://127.0.0.1:18789"
  }'
```

Each Lobster step invokes `openclaw agent --agent <name> -m "<prompt>" --json` which reads agent config from `openclaw.json`, spawns a container, and returns output for piping to the next step.

Resume after an approval gate:

```bash
lobster resume --token <resumeToken> --approve yes
```

## 4. Verify it's working

### Watch a running pipeline

Attach interactively to see real-time streaming output from agent containers:

```bash
pipelineforge watch --id <pipeline-id>
```

### Check pipeline status

```bash
# All pipelines
pipelineforge status

# Specific pipeline
pipelineforge status --id <pipeline-id>
```

### See running containers

```bash
docker ps --filter "ancestor=pipelineforge-claude"
```

You should see containers spawned for the current DAG nodes -- `project-init` first, then `assign-tickets`, then parallel `implement-ticket` instances, then the review fan-out.

### Check state on disk

```bash
cat ~/.pipelineforge/state/<pipeline-id>/state.json | jq '.nodes[] | {id, status}'
```

Example output for a pipeline mid-execution:

```json
{"id": "project-init", "status": "passed"}
{"id": "assign-tickets", "status": "passed"}
{"id": "implement-ticket-1", "status": "running"}
{"id": "implement-ticket-2", "status": "running"}
{"id": "qa-review-1", "status": "pending"}
```

### Check the gateway

```bash
# Gateway container should be running
docker ps --filter "ancestor=openclaw/gateway:latest"

# List active sessions
openclaw sessions list
```

## 5. Resume and retry

### Resume after a human gate

When the pipeline pauses at a human gate (staff-review or vp-review), resume it:

```bash
pipelineforge resume --id <pipeline-id>
```

You'll be prompted to approve or reject. With Discord enabled, you can also approve via thread reactions.

### Retry failed nodes

If a node fails (container crash, timeout, gate rejection):

```bash
pipelineforge retry --id <pipeline-id>
```

This restarts only the failed nodes -- passed nodes are not re-executed.

## Execution flow

```
pipelineforge run --proxy
       |
       v
  ProxyContainerManager starts OpenClaw gateway container
  (mounts: /repo, /notes, /state, /.claude -- port 18789)
       |
       v
  ProxyConfigGenerator writes openclaw.json with agent definitions
       |
       v
  DagExecutor walks the DAG:
       |
       +-- For each ready node:
       |     ProxySessionManager calls: openclaw agent --agent <name> -m "<prompt>" --json
       |     Gateway reads openclaw.json -> spawns pipelineforge-claude container
       |     Container runs Claude Code with prompt + allowed tools
       |     Output is polled/streamed back
       |
       +-- GateEvaluator checks gate conditions
       |     Approval: count markers in sibling outputs (e.g., 3/3)
       |     Quality: exit code, test results, pattern match
       |     Human: pause pipeline, wait for input
       |
       +-- NodeFSM transitions: pending -> ready -> running -> passed/failed
       |
       +-- On human gate: pipeline pauses, state persists, notification sent
       |
       v
  All nodes passed -> pipeline COMPLETED
  (worktree branches merged, final summary written)
```

## Useful flags

| Flag | Default | Description |
|------|---------|-------------|
| `--feature <desc>` | (required) | Feature description driving the pipeline |
| `--pipeline <name>` | `full-sdlc` | Pipeline template to use |
| `--max-concurrent <n>` | `20` | Max simultaneous agent containers |
| `--review-timing <t>` | `before` | When reviews run relative to merge: `before`, `after`, `both` |
| `--proxy` | `false` | Use OpenClaw proxy gateway as execution backend |
| `--proxy-port <port>` | `18789` | Gateway port |
| `--image <name>` | `pipelineforge-claude` | Worker container image |
| `--discord` | `false` | Enable Discord notifications |
| `--discord-channel <id>` | -- | Discord forum channel for thread creation |
| `--state-dir <path>` | `~/.pipelineforge/state` | Where pipeline state is persisted |

## Troubleshooting

### Gateway won't start

```bash
# Check if the port is already in use
lsof -i :18789

# Check gateway logs
docker logs $(docker ps -q --filter "ancestor=openclaw/gateway:latest")
```

### Agent container exits immediately

```bash
# Check container logs for the last exited container
docker logs $(docker ps -aq --filter "ancestor=pipelineforge-claude" --latest)

# Verify Claude Code auth inside the image
docker run --rm -it pipelineforge-claude --version
```

### Pipeline stuck in PAUSED state

The pipeline pauses at human gates. Check which node is waiting:

```bash
pipelineforge status --id <pipeline-id>
```

Then resume:

```bash
pipelineforge resume --id <pipeline-id>
```

### Node failed with gate rejection

Check the gate result in state:

```bash
cat ~/.pipelineforge/state/<pipeline-id>/state.json | jq '.nodes[] | select(.status == "failed") | {id, gate_result}'
```

For approval gates, the output of sibling review agents didn't contain enough approval markers. Check the agent outputs for rejection reasons and re-run.
