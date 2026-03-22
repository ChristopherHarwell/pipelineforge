import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Blueprint } from "@pftypes/Blueprint.ts";
import type {
  OpenClawAgentConfig,
  OpenClawGatewayConfig,
} from "@pftypes/ProxySession.ts";
import { blueprintToAgentConfig } from "@core/BlueprintMountBuilder.ts";
import type { WorkspaceDirs } from "@core/BlueprintMountBuilder.ts";

// ── OpenClaw Config Syncer ──────────────────────────────────────────
// Generates openclaw.json gateway configurations from synced blueprint
// definitions. Feeds into the existing proxy pipeline infrastructure
// (ProxyContainerManager → ProxySessionManager → DAG executor).

/**
 * Configuration for the OpenClawConfigSyncer.
 */
export interface OpenClawSyncerConfig {
  readonly workerImage: string;
  readonly hostRepoDir: string;
  readonly hostNotesDir: string;
  readonly hostStateDir: string;
  readonly hostClaudeDir: string;
  readonly maxConcurrent: number;
}

/**
 * Generates OpenClaw gateway configurations from PipelineForge
 * blueprint definitions. Each blueprint becomes an OpenClaw agent
 * entry with model, tools, sandbox, and workspace configuration.
 *
 * Unlike ProxyConfigGenerator (which operates on a built DagGraph),
 * this syncer operates directly on blueprint definitions — enabling
 * config generation from synced blueprints without requiring a full
 * DAG build.
 *
 * @example
 * ```ts
 * const syncer = new OpenClawConfigSyncer(config);
 * const gateway = syncer.generate(blueprints, pipelineOrder);
 * await syncer.writeConfig(gateway, "./openclaw.json");
 * ```
 */
export class OpenClawConfigSyncer {
  private readonly config: OpenClawSyncerConfig;

  constructor(config: OpenClawSyncerConfig) {
    this.config = config;
  }

  /**
   * Generate an OpenClaw gateway config from blueprints and a pipeline order.
   *
   * @param blueprints - Map of blueprint name → Blueprint
   * @param pipelineOrder - Ordered list of blueprint names to include
   * @param discordChannelId - Optional Discord channel ID for notifications
   * @returns OpenClaw gateway configuration
   */
  generate(
    blueprints: ReadonlyMap<string, Blueprint>,
    pipelineOrder: ReadonlyArray<string>,
    discordChannelId?: string,
  ): OpenClawGatewayConfig {
    const agents: OpenClawAgentConfig[] = [];

    for (const bpName of pipelineOrder) {
      const bp: Blueprint | undefined = blueprints.get(bpName);
      if (bp === undefined) {
        continue;
      }
      agents.push(this.blueprintToAgent(bp));
    }

    const gatewayConfig: OpenClawGatewayConfig = {
      agents: { list: agents },
      sandbox: { docker: { enabled: true } },
      maxConcurrent: this.config.maxConcurrent,
      ...(discordChannelId !== undefined
        ? {
            discord: {
              enabled: true,
              channelId: discordChannelId,
            },
          }
        : {}),
    };

    return gatewayConfig;
  }

  /**
   * Write a gateway config to disk as formatted JSON.
   *
   * @param config - The gateway configuration
   * @param outputPath - Filesystem path for the output file
   */
  async writeConfig(
    config: OpenClawGatewayConfig,
    outputPath: string,
  ): Promise<void> {
    const dir: string = dirname(outputPath);
    await mkdir(dir, { recursive: true });
    await writeFile(outputPath, this.serialize(config), "utf-8");
  }

  /**
   * Serialize the gateway config to a JSON string.
   *
   * @param config - The gateway configuration
   * @returns Formatted JSON string with 2-space indentation
   */
  serialize(config: OpenClawGatewayConfig): string {
    return JSON.stringify(config, null, 2);
  }

  // ── Private Helpers ─────────────────────────────────────────────

  private blueprintToAgent(bp: Blueprint): OpenClawAgentConfig {
    const dirs: WorkspaceDirs = {
      hostClaudeDir: this.config.hostClaudeDir,
      hostNotesDir: this.config.hostNotesDir,
      hostStateDir: this.config.hostStateDir,
      hostRepoDir: this.config.hostRepoDir,
    };

    return blueprintToAgentConfig(bp.name, bp, this.config.workerImage, dirs);
  }
}
