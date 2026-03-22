import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { Blueprint } from "@pftypes/Blueprint.ts";
import type { PipelineLogger } from "@pftypes/Logger.ts";
import { execFileAsync } from "@utils/process.ts";
import { OPENCLAW_CLI, MODEL_MAP } from "@utils/openclaw-constants.ts";
import { isJsonObject, getStringField, getNestedObject } from "@utils/json-guards.ts";

// ── Docker Agent Config ──────────────────────────────────────────────
// Configuration for running agents inside Docker containers.
// PipelineForge manages containerization directly (via docker run)
// rather than using OpenClaw's built-in sandbox, which restricts
// filesystem access to sandbox-owned directories.

export interface DockerAgentConfig {
  readonly workerImage: string;
  readonly hostRepoDir: string;
  readonly hostNotesDir: string;
  readonly hostStateDir: string;
  readonly hostClaudeDir: string;
  readonly hostOpenClawDir: string;
}

// ── Registered Agent ─────────────────────────────────────────────────

export interface RegisteredAgent {
  readonly agentId: string;
  readonly workspace: string;
  readonly model: string;
  readonly sandboxed: boolean;
}

// ── OpenClaw Agent Registrar ─────────────────────────────────────────
// Registers PipelineForge blueprint agents with the OpenClaw CLI.
// Each blueprint becomes an OpenClaw agent entry via `openclaw agents add`,
// then sandbox config is applied via `openclaw config set` so agents run
// inside Docker containers with the correct volume mounts.

export class OpenClawAgentRegistrar {
  private readonly logger: PipelineLogger;
  private readonly workspaceBase: string;
  private readonly dockerConfig: DockerAgentConfig | null;

  /**
   * @param logger - Pipeline logger for status messages
   * @param workspaceBase - Base directory for agent workspaces (e.g., notes dir)
   * @param dockerConfig - Docker config for containerized execution; passed
   *   through to ProxySessionManager which wraps `openclaw agent` in `docker run`
   */
  constructor(
    logger: PipelineLogger,
    workspaceBase: string,
    dockerConfig?: DockerAgentConfig,
  ) {
    this.logger = logger;
    this.workspaceBase = workspaceBase;
    this.dockerConfig = dockerConfig ?? null;
  }

  /**
   * Get the Docker agent config (if provided). Used by the CLI to pass
   * containerization settings through to ProxySessionManager.
   *
   * @returns Docker config or null if not containerized
   */
  getDockerConfig(): DockerAgentConfig | null {
    return this.dockerConfig;
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Register all blueprint agents with OpenClaw. Agents that already
   * exist are deleted and re-added to pick up config changes.
   *
   * @param blueprints - Map of blueprint name to Blueprint
   * @param pipelineOrder - Ordered list of blueprint names to register
   * @returns Array of registered agent summaries
   */
  async registerAll(
    blueprints: ReadonlyMap<string, Blueprint>,
    pipelineOrder: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<RegisteredAgent>> {
    const existing: ReadonlySet<string> = await this.listExistingAgents();
    const registered: RegisteredAgent[] = [];

    for (const bpName of pipelineOrder) {
      const bp: Blueprint | undefined = blueprints.get(bpName);
      if (bp === undefined) {
        continue;
      }

      const agentId: string = bp.name;

      // Remove existing agent to ensure config is fresh
      if (existing.has(agentId)) {
        await this.deleteAgent(agentId);
      }

      const result: RegisteredAgent = await this.addAgent(bp);
      registered.push(result);

      const sandboxLabel: string = result.sandboxed ? ", sandboxed: docker" : "";
      this.logger.pipelineEvent(
        "info",
        `Registered agent: ${agentId} (model: ${result.model}${sandboxLabel})`,
      );
    }

    return registered;
  }

  /**
   * Remove all PipelineForge-registered agents from OpenClaw.
   * Only removes agents that match blueprint names in the provided list.
   *
   * @param agentIds - Agent IDs to remove
   */
  async unregisterAll(
    agentIds: ReadonlyArray<string>,
  ): Promise<void> {
    const existing: ReadonlySet<string> = await this.listExistingAgents();

    for (const agentId of agentIds) {
      if (existing.has(agentId)) {
        await this.deleteAgent(agentId);
        this.logger.pipelineEvent("info", `Unregistered agent: ${agentId}`);
      }
    }
  }

  // ── Discord Channel Registration ────────────────────────────────

  /**
   * Register Discord as a channel with OpenClaw if not already configured.
   * Reads the bot token from `DISCORD_BOT_TOKEN` env var.
   *
   * @returns true if registration succeeded or was already configured
   */
  async ensureDiscordChannel(): Promise<boolean> {
    // Check if Discord is already configured
    const isConfigured: boolean = await this.isDiscordConfigured();
    if (isConfigured) {
      this.logger.pipelineEvent("info", "Discord channel already configured");
      return true;
    }

    const botToken: string | undefined = process.env["DISCORD_BOT_TOKEN"];
    if (botToken === undefined || botToken.length === 0) {
      this.logger.pipelineEvent(
        "warn",
        "DISCORD_BOT_TOKEN not set — skipping Discord channel registration. " +
        "Set the env var and re-run, or register manually: " +
        "openclaw channels add --channel discord --token <YOUR_BOT_TOKEN>",
      );
      return false;
    }

    try {
      await execFileAsync(OPENCLAW_CLI, [
        "channels",
        "add",
        "--channel",
        "discord",
        "--token",
        botToken,
      ]);

      this.logger.pipelineEvent("info", "Discord channel registered with OpenClaw");
      return true;
    } catch (err: unknown) {
      const message: string = err instanceof Error ? err.message : "Unknown error";
      this.logger.pipelineEvent(
        "warn",
        `Failed to register Discord channel: ${message}`,
      );
      return false;
    }
  }

  /**
   * Check whether Discord is already configured in OpenClaw.
   *
   * @returns true if Discord channel exists
   */
  private async isDiscordConfigured(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(OPENCLAW_CLI, [
        "channels",
        "list",
        "--json",
      ]);

      const parsed: unknown = JSON.parse(stdout);
      if (!isJsonObject(parsed)) {
        return false;
      }

      // Check for discord key in chat object
      const chat: Record<string, unknown> | undefined = getNestedObject(parsed, "chat");
      if (chat !== undefined) {
        return "discord" in chat;
      }

      return false;
    } catch {
      return false;
    }
  }

  // ── Private Helpers ───────────────────────────────────────────────

  /**
   * List existing OpenClaw agent IDs.
   *
   * @returns Set of registered agent IDs
   */
  private async listExistingAgents(): Promise<ReadonlySet<string>> {
    try {
      const { stdout } = await execFileAsync(OPENCLAW_CLI, [
        "agents",
        "list",
        "--json",
      ]);

      const parsed: unknown = JSON.parse(stdout);
      const ids: Set<string> = new Set();

      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (isJsonObject(entry)) {
            const id: string | undefined = getStringField(entry, "id");
            if (id !== undefined) {
              ids.add(id);
            }
          }
        }
      }

      return ids;
    } catch {
      return new Set();
    }
  }

  /**
   * Add a blueprint as an OpenClaw agent, then apply Docker sandbox
   * config if a sandbox config was provided.
   *
   * @param bp - Blueprint to register
   * @returns Registered agent summary
   */
  private async addAgent(bp: Blueprint): Promise<RegisteredAgent> {
    const model: string = MODEL_MAP[bp.execution.model] ?? bp.execution.model;
    const workspace: string = this.workspaceBase;

    const args: string[] = [
      "agents",
      "add",
      bp.name,
      "--workspace",
      workspace,
      "--model",
      model,
      "--non-interactive",
      "--json",
    ];

    await execFileAsync(OPENCLAW_CLI, args);

    // Ensure OpenClaw's own sandbox is OFF — PipelineForge manages
    // containerization by wrapping `openclaw agent` in `docker run`
    // with proper volume mounts (handled by ProxySessionManager).
    await this.ensureSandboxOff(bp.name);

    return {
      agentId: bp.name,
      workspace,
      model,
      sandboxed: this.dockerConfig !== null,
    };
  }

  /**
   * Ensure OpenClaw's built-in sandbox is disabled for an agent.
   * PipelineForge handles containerization directly via `docker run`
   * so the agent inside the container has full filesystem access to
   * the mounted volumes.
   *
   * @param agentId - Agent whose sandbox to disable
   */
  private async ensureSandboxOff(agentId: string): Promise<void> {
    try {
      const { stdout } = await execFileAsync(OPENCLAW_CLI, [
        "config",
        "get",
        "agents.list",
      ]);

      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed)) {
        return;
      }

      for (let i: number = 0; i < parsed.length; i++) {
        const entry: unknown = parsed[i];
        if (isJsonObject(entry) && getStringField(entry, "id") === agentId) {
          // Unset any previous sandbox config
          try {
            await execFileAsync(OPENCLAW_CLI, [
              "config", "unset", `agents.list.${String(i)}.sandbox`,
            ]);
          } catch {
            // May not exist — that's fine
          }
          return;
        }
      }
    } catch {
      // Config read failed — sandbox may not be set
    }
  }

  /**
   * Delete an OpenClaw agent by ID and clear its stale sessions.
   * Session files from previous runs can hold locks that block
   * new agent invocations, so we remove them on re-registration.
   *
   * @param agentId - Agent to delete
   */
  private async deleteAgent(agentId: string): Promise<void> {
    try {
      await execFileAsync(OPENCLAW_CLI, [
        "agents",
        "delete",
        agentId,
        "--force",
        "--json",
      ]);
    } catch {
      // Agent may already be removed
    }

    await this.clearStaleSessions(agentId);
  }

  /**
   * Remove stale session files for an agent. OpenClaw stores sessions
   * at `~/.openclaw/agents/<id>/sessions/`. Lock files from crashed or
   * previous gateway processes block new agent invocations with
   * "session file locked" errors.
   *
   * @param agentId - Agent whose sessions to clear
   */
  private async clearStaleSessions(agentId: string): Promise<void> {
    const sessionsDir: string = resolve(
      homedir(),
      ".openclaw",
      "agents",
      agentId,
      "sessions",
    );

    try {
      const entries: ReadonlyArray<string> = await readdir(sessionsDir);

      for (const entry of entries) {
        try {
          await rm(resolve(sessionsDir, entry), { force: true });
        } catch {
          // File may already be removed or still locked
        }
      }

      this.logger.pipelineEvent(
        "info",
        `Cleared ${String(entries.length)} stale session file(s) for ${agentId}`,
      );
    } catch {
      // Sessions directory may not exist yet — that's fine
    }
  }
}
