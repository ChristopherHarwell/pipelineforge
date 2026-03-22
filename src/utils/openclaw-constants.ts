// ── OpenClaw Shared Constants ────────────────────────────────────────

export const OPENCLAW_CLI: string = "openclaw";

// ── Model Mapping ───────────────────────────────────────────────────
// Maps PipelineForge model shortnames to Anthropic model identifiers.

export const MODEL_MAP: Readonly<Record<string, string>> = {
  opus: "anthropic/claude-opus-4-6",
  sonnet: "anthropic/claude-sonnet-4-6",
  haiku: "anthropic/claude-haiku-4-5-20251001",
} as const;

// ── Claude Auth Environment Variables ───────────────────────────────

export const CLAUDE_AUTH_VARS: ReadonlyArray<string> = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_API_KEY",
] as const;

/**
 * Collect Claude authentication environment variables that are set
 * in the current process. Returns entries in `KEY=value` format.
 *
 * @returns Array of "KEY=value" strings for all set auth vars
 */
export function collectClaudeAuthEnv(): ReadonlyArray<string> {
  const entries: string[] = [];

  for (const varName of CLAUDE_AUTH_VARS) {
    const value: string | undefined = process.env[varName];
    if (value !== undefined) {
      entries.push(`${varName}=${value}`);
    }
  }

  return entries;
}
