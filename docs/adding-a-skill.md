# Adding a New Skill to the SDLC Pipeline

This guide walks through adding a new Claude Code skill that gets picked up by the blueprint sync system and flows through the Lobster SDLC pipeline as an OpenClaw agent.

## 1. Create the skill directory and SKILL.md

```bash
mkdir ~/.claude/skills/my-new-skill
```

Create `~/.claude/skills/my-new-skill/SKILL.md` with frontmatter:

```markdown
---
name: my-new-skill
description: What this skill does in one line
argument-hint: [optional-arg-hint]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(git *)
---

# My New Skill

Full prompt body goes here. This is what the agent sees.
Include instructions, constraints, output format, etc.
```

The frontmatter fields that sync picks up:
- `name` (required) -- becomes the blueprint name and OpenClaw agent name
- `description` (required) -- short description
- `argument-hint` (optional) -- hint for CLI usage
- `allowed-tools` (required-ish) -- comma-separated or YAML list

## 2. Sync to generate the blueprint

```bash
pipelineforge sync
```

This creates `blueprints/my-new-skill.yaml` with defaults. Output:

```
  + my-new-skill -- created: New blueprint scaffolded with defaults
```

## 3. Configure non-derivable fields

Edit `blueprints/my-new-skill.yaml` -- the sync only sets 4 fields. You need to manually configure:

```yaml
name: my-new-skill
description: What this skill does          # <-- synced
skill_path: ~/.claude/skills/my-new-skill/SKILL.md  # <-- synced
execution:
  prompt_template: |                       # customize this
    {{ .skill_content }}
    ## Feature
    {{ .feature }}
    ## Repository
    {{ .repo_dir }}
  model: sonnet                            # opus | sonnet | haiku
  max_turns: 50                            # adjust per complexity
  timeout_minutes: 10
  allowed_tools:                           # <-- synced from frontmatter
    - Read
    - Write
  output_format: json
parallel:
  instances: 1                             # >1 for review agents (e.g. 6)
  naming: "{name}-{i}"
depends_on:                                # wire into the DAG
  - implement-ticket                       # which step must complete first
gate:
  type: quality                            # approval | quality | human | composite
  # For approval gates:
  # required: 6
  # total: 6
requires_repo: true                        # false if it only writes to notes
```

## 4. Add it to the pipeline config

Edit `pipelines/full-sdlc.yaml`:

```yaml
blueprints:
  - project-init
  - assign-tickets
  - implement-ticket
  - my-new-skill          # <-- add it in execution order
  - qa-review
  - security-review
  - staff-review
  - vp-review

human_gates:
  - after: staff-review
  - after: vp-review
  # - after: my-new-skill  # add if it needs human approval
```

## 5. Regenerate configs and workflow

```bash
pipelineforge sync \
  --generate-config \
  --generate-lobster \
  --repo-dir /path/to/repo \
  --notes-dir /path/to/notes
```

This updates:
- `openclaw.json` -- adds a new agent entry for `my-new-skill` with model/tools/sandbox
- `full-sdlc.lobster` -- adds a new step: `openclaw sessions spawn --agent my-new-skill`

## 6. Run the pipeline

```bash
lobster run --mode tool --file pipelines/full-sdlc.lobster \
  --args-json '{"feature": "...", "repo_dir": "...", "notes_dir": "...", "gateway_url": "http://127.0.0.1:18789"}'
```

## Quick Reference -- What Goes Where

| What | Where | Synced? |
|------|-------|---------|
| Agent prompt and instructions | `~/.claude/skills/<name>/SKILL.md` | Source of truth |
| Model, turns, timeout, gate, deps | `blueprints/<name>.yaml` | Manual config, preserved on sync |
| Container image, mounts, sandbox | `openclaw.json` | Auto-generated from blueprints |
| Step order, gates, data piping | `full-sdlc.lobster` | Auto-generated from pipeline config |
| Pipeline step list, gate positions | `pipelines/full-sdlc.yaml` | Manual config |

Future syncs will update the 4 derivable fields (name, description, skill_path, allowed_tools) without touching your manual config in the blueprint.
