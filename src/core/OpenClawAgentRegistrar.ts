import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Blueprint } from "@pftypes/Blueprint.ts";
import type { PipelineLogger } from "@pftypes/Logger.ts";

const execFileAsync: typeof execFile.__promisify__ = promisify(execFile);

// ── Constants ────────────────────────────────────────────────────────

const OPENCLAW_CLI: string = "openclaw";

// ── Model Mapping ────────────────────────────────────────────────────

const MODEL_MAP: Readonly<Record<string, string>> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
} as const;

// ── Registered Agent ─────────────────────────────────────────────────

export interface RegisteredAgent {
  readonly agentId: string;
  readonly workspace: string;
  readonly model: string;
}

// ── OpenClaw Agent Registrar ─────────────────────────────────────────
// Registers PipelineForge blueprint agents with the OpenClaw CLI.
// Each blueprint becomes an OpenClaw agent entry via `openclaw agents add`.
// The gateway reads agent configs from its own `~/.openclaw/openclaw.json`
// — we do NOT write a separate config file.

export class OpenClawAgentRegistrar {
  private readonly logger: PipelineLogger;
  private readonly workspaceBase: string;

  /**
   * @param logger - Pipeline logger for status messages
   * @param workspaceBase - Base directory for agent workspaces (e.g., notes dir)
   */
  constructor(logger: PipelineLogger, workspaceBase: string) {
    this.logger = logger;
    this.workspaceBase = workspaceBase;
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

      this.logger.pipelineEvent(
        "info",
        `Registered agent: ${agentId} (model: ${result.model})`,
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
   * Add a blueprint as an OpenClaw agent.
   *
   * @param bp - Blueprint to register
   * @returns Registered agent summary
   */
  private async addAgent(bp: Blueprint): Promise<RegisteredAgent> {
    const model: string = MODEL_MAP[bp.execution.model] ?? bp.execution.model;
    const workspace: string = bp.requires_repo
      ? this.workspaceBase
      : this.workspaceBase;

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

    return {
      agentId: bp.name,
      workspace,
      model,
    };
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
