# Multi-arch compatible (AMD64/ARM64) — inspired by archon-images pattern
# Build: docker buildx build --platform linux/amd64,linux/arm64 -t pipelineforge-claude .
FROM node:22-slim

# ── Install system dependencies ─────────────────────────────────────
RUN apt-get update && apt-get install -y curl git jq ripgrep && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# ── Install Claude Code globally ───────────────────────────────────
# npm install -g puts the binary in /usr/local/bin, accessible to all users
RUN npm install -g @anthropic-ai/claude-code

# ── Create non-root user ────────────────────────────────────────────
RUN useradd -m -s /bin/bash claude

# ── Seed Claude Code config ──────────────────────────────────────────
# Claude Code expects ~/.claude.json to exist; create a minimal default
# so the container doesn't emit "configuration file not found" warnings.
RUN echo '{}' > /home/claude/.claude.json && \
    mkdir -p /home/claude/.claude && \
    chown -R claude:claude /home/claude/.claude /home/claude/.claude.json

USER claude
WORKDIR /workspace

# ── Default entrypoint ──────────────────────────────────────────────
# Overridden per-container by the orchestrator
ENTRYPOINT ["claude"]
