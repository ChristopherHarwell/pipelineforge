# ── Blueprint Sync Pipeline ──────────────────────────────────────────
# Single-step Lobster workflow that syncs blueprints from SKILL.md
# frontmatter, generates openclaw.json agent configs, and regenerates
# .lobster workflow files.
#
# Cron setup:
#   openclaw cron add --name sync-blueprints --every 5h \
#     --message "sync blueprints"
#
# Manual run:
#   lobster run --mode tool --file pipelines/sync-blueprints.lobster
# ─────────────────────────────────────────────────────────────────────

name: sync-blueprints
description: "Sync blueprints from SKILL.md, generate openclaw.json and .lobster workflows"

args:
  skill_dir:
    default: "~/.claude/skills"
    description: "Path to Claude Code skill definitions"
  blueprint_dir:
    default: "./blueprints"
    description: "Blueprints output directory"
  pipeline:
    default: "full-sdlc"
    description: "Pipeline template for generation"

steps:
  - id: sync
    run: >
      pipelineforge sync
      --skill-dir ${skill_dir}
      --blueprint-dir ${blueprint_dir}
      --generate-config
      --generate-lobster
      --pipeline ${pipeline}
