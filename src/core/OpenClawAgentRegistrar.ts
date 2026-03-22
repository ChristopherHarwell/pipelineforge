import { execFile } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { Blueprint } from "@pftypes/Blueprint.ts";
import type { PipelineLogger } from "@pftypes/Logger.ts";

const execFileAsync: typeof execFile.__promisify__ = promisify(execFile);

// ── Constants ────────────────────────────────────────────────────────

const OPENCLAW_CLI: string = "openclaw";

// ── Model Mapping ────────────────────────────────────────────────────

const MODEL_MAP: Readonly<Record<string, string>> = {
  opus: "anthropic/claude-opus-4-6",
  sonnet: "anthropic/claude-sonnet-4-6",
  haiku: "anthropic/claude-haiku-4-5-20251001",
} as const;

// ── Sandbox Config ──────────────────────────────────────────────────
// Host-absolute paths needed to build Docker bind mounts for each agent.

export interface AgentSandboxConfig {
  readonly workerImage: string;
  readonly hostRepoDir: string;
  readonly hostNotesDir: string;
  readonly hostStateDir: string;
  readonly hostClaudeDir: string;
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
  private readonly sandbox: AgentSandboxConfig | null;

  /**
   * @param logger - Pipeline logger for status messages
   * @param workspaceBase - Base directory for agent workspaces (e.g., notes dir)
   * @param sandbox - Docker sandbox config; when provided, agents run in containers
   */
  constructor(
    logger: PipelineLogger,
    workspaceBase: string,
    sandbox?: AgentSandboxConfig,
  ) {
    this.logger = logger;
    this.workspaceBase = workspaceBase;
    this.sandbox = sandbox ?? null;
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
      if (parsed === null || typeof parsed !== "object") {
        return false;
      }

      const obj: Record<string, unknown> = parsed as Record<string, unknown>;

      // Check for discord key in chat object
      if (obj["chat"] !== null && typeof obj["chat"] === "object") {
        const chat: Record<string, unknown> = obj["chat"] as Record<string, unknown>;
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
          if (
            entry !== null &&
            typeof entry === "object" &&
            "id" in entry &&
            typeof (entry as Record<string, unknown>)["id"] === "string"
          ) {
            ids.add((entry as Record<string, unknown>)["id"] as string);
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

    // Apply Docker sandbox config via `openclaw config set`
    let sandboxed: boolean = false;
    if (this.sandbox !== null) {
      sandboxed = await this.applySandboxConfig(bp);
    }

    return {
      agentId: bp.name,
      workspace,
      model,
      sandboxed,
    };
  }

  // ── Sandbox Configuration ────────────────────────────────────────

  /**
   * Find the index of an agent in the OpenClaw config list by ID.
   *
   * @param agentId - Agent ID to locate
   * @returns Zero-based index in `agents.list`, or -1 if not found
   */
  private async findAgentIndex(agentId: string): Promise<number> {
    try {
      const { stdout } = await execFileAsync(OPENCLAW_CLI, [
        "config",
        "get",
        "agents.list",
      ]);

      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed)) {
        return -1;
      }

      for (let i: number = 0; i < parsed.length; i++) {
        const entry: unknown = parsed[i];
        if (
          entry !== null &&
          typeof entry === "object" &&
          Object.hasOwn(entry as object, "id") &&
          (entry as Record<string, unknown>)["id"] === agentId
        ) {
          return i;
        }
      }
    } catch {
      // Config read failed
    }

    return -1;
  }

  /**
   * Build Docker bind mounts for a blueprint, mirroring the mount
   * strategy from OpenClawConfigSyncer.blueprintToAgent.
   *
   * @param bp - Blueprint to build mounts for
   * @returns Array of "host:container:mode" bind strings
   */
  private buildBindMounts(bp: Blueprint): ReadonlyArray<string> {
    if (this.sandbox === null) {
      return [];
    }

    const binds: string[] = [
      `${this.sandbox.hostClaudeDir}:/home/claude/.claude:ro`,
      `${this.sandbox.hostNotesDir}:/notes:rw`,
      `${this.sandbox.hostStateDir}:/state:ro`,
    ];

    if (bp.requires_repo) {
      binds.push(`${this.sandbox.hostRepoDir}:/workspace:rw`);
    }

    if (bp.docker?.extra_mounts !== undefined) {
      binds.push(...bp.docker.extra_mounts);
    }

    return binds;
  }

  /**
   * Apply Docker sandbox configuration to a registered agent via
   * `openclaw config set`. Sets sandbox.mode, docker.image, and
   * docker.binds on the agent entry in ~/.openclaw/openclaw.json.
   *
   * @param bp - Blueprint whose agent should be sandboxed
   * @returns true if sandbox config was applied successfully
   */
  private async applySandboxConfig(bp: Blueprint): Promise<boolean> {
    if (this.sandbox === null) {
      return false;
    }

    const idx: number = await this.findAgentIndex(bp.name);
    if (idx < 0) {
      this.logger.pipelineEvent(
        "warn",
        `Could not find agent ${bp.name} in config — sandbox not applied`,
      );
      return false;
    }

    const prefix: string = `agents.list.${String(idx)}`;
    const binds: ReadonlyArray<string> = this.buildBindMounts(bp);

    try {
      // Set sandbox mode to "all" — sandbox every command the agent runs
      await execFileAsync(OPENCLAW_CLI, [
        "config", "set", `${prefix}.sandbox.mode`, '"all"',
      ]);

      // Set Docker image
      await execFileAsync(OPENCLAW_CLI, [
        "config", "set", `${prefix}.sandbox.docker.image`,
        JSON.stringify(this.sandbox.workerImage),
      ]);

      // Set Docker bind mounts
      await execFileAsync(OPENCLAW_CLI, [
        "config", "set", `${prefix}.sandbox.docker.binds`,
        JSON.stringify(binds),
      ]);

      return true;
    } catch (err: unknown) {
      const message: string = err instanceof Error ? err.message : "Unknown error";
      this.logger.pipelineEvent(
        "warn",
        `Failed to apply sandbox config for ${bp.name}: ${message}`,
      );
      return false;
    }
  }

  /**
   * Delete an OpenClaw agent by ID.
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
  }
}
