import type { Blueprint } from "@pftypes/Blueprint.ts";
import type { DagGraph, DagNode } from "@pftypes/Graph.ts";
import type {
  OpenClawAgentConfig,
  OpenClawGatewayConfig,
} from "@pftypes/ProxySession.ts";
import type { BlueprintRegistry } from "@core/BlueprintRegistry.ts";

// ── Model Mapping ───────────────────────────────────────────────────
// Maps PipelineForge model names to OpenClaw/Anthropic model identifiers.

const MODEL_MAP: Readonly<Record<string, string>> = {
  opus: "anthropic/claude-opus-4-6",
  sonnet: "anthropic/claude-sonnet-4-6",
  haiku: "anthropic/claude-haiku-4-5-20251001",
};

// ── Proxy Config Generator ──────────────────────────────────────────
// Transforms a PipelineForge DAG + blueprints into an openclaw.json
// gateway configuration. Each DAG node becomes an OpenClaw agent entry
// with model, tools, sandbox, and workspace configuration derived from
// its blueprint.

export class ProxyConfigGenerator {
  private readonly workerImage: string;
  private readonly hostRepoDir: string;
  private readonly hostNotesDir: string;
  private readonly hostStateDir: string;
  private readonly hostClaudeDir: string;

  constructor(config: {
    readonly workerImage: string;
    readonly hostRepoDir: string;
    readonly hostNotesDir: string;
    readonly hostStateDir: string;
    readonly hostClaudeDir: string;
  }) {
    this.workerImage = config.workerImage;
    this.hostRepoDir = config.hostRepoDir;
    this.hostNotesDir = config.hostNotesDir;
    this.hostStateDir = config.hostStateDir;
    this.hostClaudeDir = config.hostClaudeDir;
  }

  /**
   * Generate the full openclaw.json gateway configuration from a DAG.
   *
   * @param graph - The built DAG
   * @param blueprints - Blueprint registry
   * @param maxConcurrent - Maximum concurrent sessions
   * @param discordChannelId - Optional Discord channel ID for notifications
   * @returns OpenClaw gateway configuration ready to serialize
   */
  generate(
    graph: DagGraph,
    blueprints: BlueprintRegistry,
    maxConcurrent: number,
    discordChannelId?: string,
  ): OpenClawGatewayConfig {
    const agents: ReadonlyArray<OpenClawAgentConfig> = Array.from(
      graph.nodes.values(),
    ).map(
      (node: DagNode): OpenClawAgentConfig =>
        this.nodeToAgent(node, blueprints.get(node.blueprint)),
    );

    const config: OpenClawGatewayConfig = {
      agents: { list: agents },
      sandbox: { docker: { enabled: true } },
      maxConcurrent,
      ...(discordChannelId !== undefined
        ? {
            discord: {
              enabled: true,
              channelId: discordChannelId,
            },
          }
        : {}),
    };

    return config;
  }

  /**
   * Generate a single agent config for a specific node.
   * Used for hot-reload when new nodes are added to the DAG.
   *
   * @param node - The DAG node
   * @param blueprint - The node's blueprint
   * @returns OpenClaw agent configuration
   */
  nodeToAgent(node: DagNode, blueprint: Blueprint): OpenClawAgentConfig {
    const model: string = MODEL_MAP[blueprint.execution.model] ?? blueprint.execution.model;

    const mounts: string[] = [
      `${this.hostClaudeDir}:/home/claude/.claude:ro`,
      `${this.hostNotesDir}:/notes:rw`,
      `${this.hostStateDir}:/state:ro`,
    ];

    let workingDir: string = "/notes";

    if (blueprint.requires_repo) {
      mounts.push(`${this.hostRepoDir}:/workspace:rw`);
      workingDir = "/workspace";
    }

    if (blueprint.docker?.extra_mounts !== undefined) {
      mounts.push(...blueprint.docker.extra_mounts);
    }

    const agentConfig: OpenClawAgentConfig = {
      name: node.id,
      model,
      instructions: blueprint.execution.prompt_template,
      tools: [...blueprint.execution.allowed_tools],
      ...(blueprint.review_mode.enabled
        ? { disallowedTools: [...blueprint.review_mode.dry_run_disallowed_tools] }
        : {}),
      maxTurns: blueprint.execution.max_turns,
      sandbox: {
        docker: {
          image: this.workerImage,
          mounts,
          workingDir,
        },
      },
    };

    return agentConfig;
  }

  /**
   * Serialize the gateway config to JSON string for writing to disk.
   *
   * @param config - The gateway configuration
   * @returns JSON string
   */
  serialize(config: OpenClawGatewayConfig): string {
    return JSON.stringify(config, null, 2);
  }
}
