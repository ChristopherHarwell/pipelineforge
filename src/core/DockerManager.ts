import type Docker from "dockerode";
import type { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import type { Blueprint } from "@pftypes/Blueprint.ts";
import type { DagNode } from "@pftypes/Graph.ts";
import type { ContainerResult } from "@pftypes/Pipeline.ts";
import type { PipelineLogger } from "@pftypes/Logger.ts";
import type { ExecutionBackend, SpawnOptions } from "@pftypes/ExecutionBackend.ts";

// ── Docker Config ───────────────────────────────────────────────────

export interface DockerConfig {
  readonly pipelineId: string;
  readonly imageName: string;
  readonly claudeDir: string;
  readonly claudeJsonPath: string;
  readonly repoDir: string;
  readonly notesDir: string;
  readonly stateDir: string;
}

// ── Docker Manager ──────────────────────────────────────────────────
// Manages Docker container lifecycle for blueprint execution.
// Uses dockerode for programmatic Docker API access.
// Implements ExecutionBackend for use as a pluggable execution layer.

export class DockerManager implements ExecutionBackend {
  private readonly config: DockerConfig;
  private readonly logger: PipelineLogger | null;
  private readonly activeContainers: Map<string, string> = new Map();

  constructor(config: DockerConfig, logger?: PipelineLogger) {
    this.config = config;
    this.logger = logger ?? null;
  }

  /**
   * Spawn a Claude Code container for a blueprint execution.
   * Supports worktree isolation and dry-run mode for the implementation review flow.
   *
   * @param options - Spawn configuration including node, blueprint, prompt, and optional worktree/dry-run flags
   * @returns Container result (stdout, stderr, exit code)
   */
  async spawnContainer(options: SpawnOptions): Promise<ContainerResult> {
    const { node, blueprint, prompt, worktreePath, dryRun } = options;
    const containerName: string = `pf-${this.config.pipelineId}-${node.id}`;
    const startTime: number = Date.now();

    const args: ReadonlyArray<string> = this.buildClaudeArgs(
      blueprint,
      prompt,
      dryRun,
    );
    const binds: ReadonlyArray<string> = this.buildBindMounts(
      blueprint,
      worktreePath,
    );
    const workingDir: string = blueprint.requires_repo ? "/workspace" : "/notes";
    const env: ReadonlyArray<string> = this.buildEnv(node, blueprint);

    // Dynamically import dockerode to allow testing without Docker
    const Docker = (await import("dockerode")).default;
    const docker = new Docker();

    const container = await docker.createContainer({
      Image: this.config.imageName,
      name: containerName,
      Cmd: [...args],
      HostConfig: {
        Binds: [...binds],
        Memory: this.parseMemory(blueprint.docker?.memory ?? "2g"),
        NanoCpus: this.parseCpus(blueprint.docker?.cpus ?? "1.0"),
      },
      WorkingDir: workingDir,
      Env: [...env],
    });

    this.activeContainers.set(node.id, container.id);

    await container.start();

    // Wait for completion with timeout
    const timeoutMs: number =
      blueprint.execution.timeout_minutes * 60 * 1000;
    const result: ContainerResult = await this.waitForCompletion(
      container,
      containerName,
      timeoutMs,
      startTime,
    );

    this.activeContainers.delete(node.id);

    try {
      await container.remove();
    } catch {
      // Container may already be removed
    }

    return result;
  }

  /**
   * Kill all active containers (cleanup on pipeline abort).
   */
  async killAll(): Promise<void> {
    const Docker = (await import("dockerode")).default;
    const docker = new Docker();

    const kills: ReadonlyArray<Promise<void>> = Array.from(
      this.activeContainers.entries(),
    ).map(async ([_nodeId, containerId]: [string, string]): Promise<void> => {
      try {
        const container = docker.getContainer(containerId);
        await container.kill();
        await container.remove();
      } catch {
        // Container may already be stopped
      }
    });

    await Promise.all(kills);
    this.activeContainers.clear();
  }

  /**
   * Build the claude CLI argument array.
   * When dryRun is true, adds --disallowedTools to prevent file writes.
   *
   * @param blueprint - Blueprint configuration
   * @param prompt - Rendered prompt string
   * @param dryRun - If true, block write tools for proposal-only execution
   */
  private buildClaudeArgs(
    blueprint: Blueprint,
    prompt: string,
    dryRun?: boolean,
  ): string[] {
    const args: string[] = [
      "-p",
      prompt,
      "--model",
      blueprint.execution.model,
      "--output-format",
      blueprint.execution.output_format,
      "--max-turns",
      String(blueprint.execution.max_turns),
      "--allowedTools",
      blueprint.execution.allowed_tools.join(","),
      "--dangerously-skip-permissions",
    ];

    if (dryRun === true) {
      args.push(
        "--disallowedTools",
        blueprint.review_mode.dry_run_disallowed_tools.join(","),
      );
    }

    return args;
  }

  /**
   * Build Docker bind mount array.
   * When worktreePath is provided, the worktree is mounted as /workspace (rw)
   * and the main repo is mounted as /repo (ro) for reference.
   *
   * @param blueprint - Blueprint configuration
   * @param worktreePath - Optional path to git worktree directory
   */
  private buildBindMounts(
    blueprint: Blueprint,
    worktreePath?: string,
  ): string[] {
    const mounts: string[] = [
      `${this.config.claudeDir}:/home/claude/.claude:ro`,
      `${this.config.claudeJsonPath}:/home/claude/.claude.json:ro`,
      `${this.config.notesDir}:/notes:rw`,
      `${this.config.stateDir}:/state:ro`,
    ];

    if (blueprint.requires_repo) {
      if (worktreePath !== undefined) {
        // Worktree mode: worktree is /workspace (rw), main repo is /repo (ro)
        mounts.push(`${worktreePath}:/workspace:rw`);
        mounts.push(`${this.config.repoDir}:/repo:ro`);
      } else {
        // Standard mode: main repo is /workspace (rw)
        mounts.push(`${this.config.repoDir}:/workspace:rw`);
      }
    }
    // Planning-only blueprints (requires_repo: false) get no repo mount —
    // they work entirely within /notes

    if (blueprint.docker?.extra_mounts !== undefined) {
      mounts.push(...blueprint.docker.extra_mounts);
    }

    return mounts;
  }

  /**
   * Build environment variable array.
   */
  private buildEnv(node: DagNode, blueprint: Blueprint): string[] {
    const env: string[] = [
      `PIPELINEFORGE_NOTES_DIR=/notes`,
      `PIPELINEFORGE_PIPELINE_ID=${this.config.pipelineId}`,
      `PIPELINEFORGE_NODE_ID=${node.id}`,
    ];

    // Forward Claude Code authentication from host environment.
    // Priority: CLAUDE_CODE_USE_BEDROCK/CLAUDE_CODE_USE_VERTEX auth tokens
    // (set by `claude setup-token`) take precedence over ANTHROPIC_API_KEY.
    const CLAUDE_AUTH_VARS: ReadonlyArray<string> = [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_API_KEY",
    ];

    for (const varName of CLAUDE_AUTH_VARS) {
      const value: string | undefined = process.env[varName];
      if (value !== undefined) {
        env.push(`${varName}=${value}`);
      }
    }

    if (blueprint.docker?.env !== undefined) {
      for (const [k, v] of Object.entries(blueprint.docker.env)) {
        env.push(`${k}=${v}`);
      }
    }

    return env;
  }

  /**
   * Wait for a container to complete, with timeout.
   * Streams container logs live when a logger is available.
   */
  private async waitForCompletion(
    container: Docker.Container,
    containerName: string,
    timeoutMs: number,
    startTime: number,
  ): Promise<ContainerResult> {
    const timeoutPromise: Promise<never> = new Promise(
      (_resolve, reject) => {
        setTimeout(() => {
          reject(new Error(`Container timed out after ${String(timeoutMs / 1000)}s`));
        }, timeoutMs);
      },
    );

    // ── Attach live log stream ─────────────────────────────────
    const outputChunks: Buffer[] = [];

    if (this.logger !== null) {
      try {
        const rawStream: NodeJS.ReadableStream = await container.logs({
          stdout: true,
          stderr: true,
          follow: true,
        }) as unknown as NodeJS.ReadableStream;

        // dockerode returns a multiplexed stream — pipe through
        // a PassThrough to normalize into a standard Readable
        const passthrough: PassThrough = new PassThrough();
        rawStream.pipe(passthrough);

        // Capture output for the final ContainerResult
        passthrough.on("data", (chunk: Buffer): void => {
          outputChunks.push(chunk);
        });

        // Stream live to the user
        this.logger.streamContainerOutput(
          containerName,
          passthrough as unknown as Readable,
        );
      } catch {
        // Fall back to post-mortem log fetch if attach fails
      }
    }

    try {
      const waitResult: { readonly StatusCode: number } = await Promise.race([
        container.wait(),
        timeoutPromise,
      ]);

      // If we captured live output, use that; otherwise fetch post-mortem
      let logOutput: string;
      if (outputChunks.length > 0) {
        logOutput = Buffer.concat(outputChunks).toString("utf-8");
      } else {
        const logs: Buffer = await container.logs({
          stdout: true,
          stderr: true,
          follow: false,
        }) as unknown as Buffer;
        logOutput = logs.toString("utf-8");
      }

      return {
        stdout: logOutput,
        stderr: "",
        exitCode: waitResult.StatusCode,
        durationMs: Date.now() - startTime,
      };
    } catch (err: unknown) {
      // Timeout — kill the container
      try {
        await container.kill();
      } catch {
        // Already stopped
      }

      return {
        stdout: "",
        stderr: err instanceof Error ? err.message : "Unknown error",
        exitCode: 124,
        durationMs: Date.now() - startTime,
      };
    }
  }



  /**
   * Parse memory string (e.g., "2g") to bytes.
   */
  private parseMemory(memory: string): number {
    const match: RegExpMatchArray | null = memory.match(
      /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i,
    );
    if (match === null) {
      return 2 * 1024 * 1024 * 1024; // Default 2GB
    }
    const value: number = parseFloat(match[1]!);
    const unit: string = (match[2] ?? "").toLowerCase();
    switch (unit) {
      case "k":
        return value * 1024;
      case "m":
        return value * 1024 * 1024;
      case "g":
        return value * 1024 * 1024 * 1024;
      default:
        return value;
    }
  }

  /**
   * Parse CPU string (e.g., "1.0") to nanoseconds.
   */
  private parseCpus(cpus: string): number {
    return parseFloat(cpus) * 1e9;
  }
}
