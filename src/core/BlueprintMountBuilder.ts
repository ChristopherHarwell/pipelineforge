import type { Blueprint } from "@pftypes/Blueprint.ts";
import type { OpenClawAgentConfig } from "@pftypes/ProxySession.ts";
import { MODEL_MAP } from "@utils/openclaw-constants.ts";

// ── Workspace Directories ───────────────────────────────────────────

export interface WorkspaceDirs {
  readonly hostClaudeDir: string;
  readonly hostNotesDir: string;
  readonly hostStateDir: string;
  readonly hostRepoDir: string;
}

// ── Mount Builder ───────────────────────────────────────────────────

/**
 * Build the standard Docker bind mount array for a blueprint.
 * Always includes claude, notes, and state mounts. Adds repo mount
 * when the blueprint requires a repository. Appends any extra mounts
 * defined in the blueprint's docker config.
 *
 * @param dirs - Host-absolute workspace directory paths
 * @param blueprint - Blueprint with requires_repo and optional docker.extra_mounts
 * @returns Array of Docker bind mount strings
 */
export function buildBlueprintMounts(
  dirs: WorkspaceDirs,
  blueprint: Blueprint,
): string[] {
  const mounts: string[] = [
    `${dirs.hostClaudeDir}:/home/claude/.claude:ro`,
    `${dirs.hostNotesDir}:/notes:rw`,
    `${dirs.hostStateDir}:/state:ro`,
  ];

  if (blueprint.requires_repo) {
    mounts.push(`${dirs.hostRepoDir}:/workspace:rw`);
  }

  if (blueprint.docker?.extra_mounts !== undefined) {
    mounts.push(...blueprint.docker.extra_mounts);
  }

  return mounts;
}

/**
 * Transform a blueprint into a full OpenClaw agent configuration.
 * Resolves model shortnames, builds mount arrays, and sets the
 * working directory based on requires_repo.
 *
 * @param name - Agent/node name for the config entry
 * @param blueprint - Blueprint to transform
 * @param workerImage - Docker image for the sandbox container
 * @param dirs - Host-absolute workspace directory paths
 * @returns OpenClaw agent configuration
 */
export function blueprintToAgentConfig(
  name: string,
  blueprint: Blueprint,
  workerImage: string,
  dirs: WorkspaceDirs,
): OpenClawAgentConfig {
  const model: string =
    MODEL_MAP[blueprint.execution.model] ?? blueprint.execution.model;

  const mounts: string[] = buildBlueprintMounts(dirs, blueprint);
  const workingDir: string = blueprint.requires_repo ? "/workspace" : "/notes";

  const agentConfig: OpenClawAgentConfig = {
    name,
    model,
    instructions: blueprint.execution.prompt_template,
    tools: [...blueprint.execution.allowed_tools],
    ...(blueprint.review_mode.enabled
      ? { disallowedTools: [...blueprint.review_mode.dry_run_disallowed_tools] }
      : {}),
    maxTurns: blueprint.execution.max_turns,
    sandbox: {
      docker: {
        image: workerImage,
        mounts,
        workingDir,
      },
    },
  };

  return agentConfig;
}
