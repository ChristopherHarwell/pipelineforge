import type { ProxyContainerConfig } from "@pftypes/ProxySession.ts";
import type { PipelineLogger } from "@pftypes/Logger.ts";
import { execFileAsync } from "@utils/process.ts";
import { sleep } from "@utils/process.ts";
import { collectClaudeAuthEnv } from "@utils/openclaw-constants.ts";

// ── Health Check Config ─────────────────────────────────────────────

const HEALTH_CHECK_INTERVAL_MS: number = 2_000;
const HEALTH_CHECK_MAX_RETRIES: number = 15;

// ── Proxy Container Manager ─────────────────────────────────────────
// Manages the lifecycle of the OpenClaw proxy Docker container.
// The proxy container runs the OpenClaw gateway as its entrypoint,
// exposing port 18789 for session management. It mounts the Docker
// socket to spawn sibling worker containers.

export class ProxyContainerManager {
  private readonly config: ProxyContainerConfig;
  private readonly logger: PipelineLogger;
  private containerId: string | null = null;

  constructor(config: ProxyContainerConfig, logger: PipelineLogger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Start the OpenClaw proxy container.
   * Waits for the gateway to become healthy before returning.
   *
   * @throws Error if the container fails to start or health check times out
   */
  async start(): Promise<void> {
    this.logger.pipelineEvent("info", "Starting OpenClaw proxy container...");

    const args: ReadonlyArray<string> = this.buildDockerRunArgs();

    const { stdout } = await execFileAsync("docker", ["run", ...args]);
    this.containerId = stdout.trim();

    this.logger.pipelineEvent(
      "info",
      `Proxy container started: ${this.containerId}`,
    );

    await this.waitForHealthy();

    this.logger.pipelineEvent("info", "Proxy gateway is healthy");
  }

  /**
   * Stop and remove the proxy container.
   */
  async stop(): Promise<void> {
    if (this.containerId === null) {
      return;
    }

    this.logger.pipelineEvent("info", "Stopping proxy container...");

    try {
      await execFileAsync("docker", ["stop", this.containerId]);
    } catch {
      // Container may already be stopped
    }

    try {
      await execFileAsync("docker", ["rm", "-f", this.containerId]);
    } catch {
      // Container may already be removed
    }

    this.containerId = null;
  }

  /**
   * Check if the proxy container is currently running.
   *
   * @returns true if the container is running
   */
  async isRunning(): Promise<boolean> {
    if (this.containerId === null) {
      return false;
    }

    try {
      const { stdout } = await execFileAsync("docker", [
        "inspect",
        "--format",
        "{{.State.Running}}",
        this.containerId,
      ]);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  /**
   * Get the gateway URL for the proxy container.
   *
   * @returns The URL to reach the OpenClaw gateway
   */
  getGatewayUrl(): string {
    return `http://127.0.0.1:${String(this.config.gatewayPort)}`;
  }

  // ── Docker Run Args ───────────────────────────────────────────────

  private buildDockerRunArgs(): string[] {
    const name: string = this.config.containerName;

    const args: string[] = [
      "--detach",
      "--name", name,
      "--publish", `${String(this.config.gatewayPort)}:18789`,
      // Mount Docker socket for sibling container spawning
      "--volume", `${this.config.dockerSocketPath}:/var/run/docker.sock`,
      // Mount openclaw.json config
      "--volume", `${this.config.configPath}:/app/openclaw.json:ro`,
      // Mount workspace directories (host-absolute paths for worker containers)
      "--volume", `${this.config.repoDir}:/workspace:rw`,
      "--volume", `${this.config.notesDir}:/notes:rw`,
      "--volume", `${this.config.stateDir}:/state:ro`,
      // Mount Claude Code credentials from host (supports Claude Max OAuth + API key auth)
      "--volume", `${this.config.claudeDir}:/home/claude/.claude:ro`,
      "--volume", `${this.config.claudeJsonPath}:/home/claude/.claude.json:ro`,
      // Pass host-absolute paths as env vars for worker container bind mounts
      "--env", `HOST_REPO_DIR=${this.config.repoDir}`,
      "--env", `HOST_NOTES_DIR=${this.config.notesDir}`,
      "--env", `HOST_STATE_DIR=${this.config.stateDir}`,
      "--env", `HOST_CLAUDE_DIR=${this.config.claudeDir}`,
    ];

    // Forward Claude Code authentication env vars from host.
    // Claude Max uses OAuth credentials stored in ~/.claude/ (mounted above).
    // API key auth uses ANTHROPIC_API_KEY. Both paths are supported.
    for (const entry of collectClaudeAuthEnv()) {
      args.push("--env", entry);
    }

    args.push(this.config.openclawImage);

    return args;
  }

  // ── Health Check ──────────────────────────────────────────────────

  private async waitForHealthy(): Promise<void> {
    const url: string = `${this.getGatewayUrl()}/health`;

    for (let attempt: number = 0; attempt < HEALTH_CHECK_MAX_RETRIES; attempt++) {
      try {
        const response: Response = await fetch(url);
        if (response.ok) {
          return;
        }
      } catch {
        // Gateway not ready yet
      }

      await sleep(HEALTH_CHECK_INTERVAL_MS);
    }

    throw new Error(
      `Proxy gateway health check failed after ${String(HEALTH_CHECK_MAX_RETRIES)} attempts`,
    );
  }

}
