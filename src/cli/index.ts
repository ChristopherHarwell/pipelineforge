#!/usr/bin/env node

import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileAsync } from "@utils/process.ts";
import { createInterface } from "node:readline/promises";
import type { DagGraph, DagNode } from "@pftypes/Graph.ts";
import type { Blueprint } from "@pftypes/Blueprint.ts";
import type {
  NodeState,
  PipelineState,
  PipelineConfig,
  ReviewTiming,
  PipelineSummary,
} from "@pftypes/Pipeline.ts";
import type { ExecutionResult } from "@core/DagExecutor.ts";
import { BlueprintRegistry } from "@core/BlueprintRegistry.ts";
import { DagBuilder } from "@core/DagBuilder.ts";
import { DagExecutor } from "@core/DagExecutor.ts";
import { DockerManager } from "@core/DockerManager.ts";
import { GateEvaluator } from "@core/GateEvaluator.ts";
import { StateManager } from "@core/StateManager.ts";
import { WorktreeManager } from "@core/WorktreeManager.ts";
import { PromptBuilder } from "@utils/PromptBuilder.ts";
import { TemplateEngine } from "@utils/TemplateEngine.ts";
import { loadPipelineConfig } from "@core/PipelineConfigLoader.ts";
import { ConsoleLogger } from "@utils/ConsoleLogger.ts";
import type { PipelineLogger } from "@pftypes/Logger.ts";
import type { ExecutionBackend } from "@pftypes/ExecutionBackend.ts";
import { OpenClawClient } from "@core/OpenClawClient.ts";
import { NotificationRouter } from "@core/NotificationRouter.ts";
import { OpenClawConfigSchema } from "@pftypes/Discord.ts";
import type { OpenClawConfig } from "@pftypes/Discord.ts";
import { toThreadId } from "@pftypes/Discord.ts";
import type { DiscordThreadId } from "@pftypes/Discord.ts";
import type { NotificationChannel } from "@pftypes/NotificationChannel.ts";
import { ProxyContainerManager } from "@core/ProxyContainerManager.ts";
import { ProxySessionManager } from "@core/ProxySessionManager.ts";
import { ProxyConfigGenerator } from "@core/ProxyConfigGenerator.ts";
import type { ProxyContainerConfig } from "@pftypes/ProxySession.ts";
import type { InputChannel, UserInput } from "@pftypes/InputChannel.ts";
import { CliInputChannel } from "@core/CliInputChannel.ts";
import { DiscordInputChannel } from "@core/DiscordInputChannel.ts";
import { InputRacer } from "@core/InputRacer.ts";
import type { ChildProcess } from "node:child_process";
import { discoverSkills } from "@core/SkillFrontmatterParser.ts";
import type { DiscoveredSkill } from "@pftypes/SkillFrontmatter.ts";
import type { OpenClawGatewayConfig } from "@pftypes/ProxySession.ts";
import { BlueprintSyncer } from "@core/BlueprintSyncer.ts";
import { OpenClawConfigSyncer } from "@core/OpenClawConfigSyncer.ts";
import { OpenClawAgentRegistrar } from "@core/OpenClawAgentRegistrar.ts";
import { generateLobsterWorkflow } from "@core/LobsterWorkflowGenerator.ts";
import type { SyncReport, SyncEntry } from "@pftypes/SyncResult.ts";


// ── Paths ───────────────────────────────────────────────────────────

const __dirname: string = dirname(fileURLToPath(import.meta.url));
const PIPELINEFORGE_ROOT: string = resolve(__dirname, "..", "..");
const DEFAULT_BLUEPRINTS_DIR: string = resolve(
  PIPELINEFORGE_ROOT,
  "blueprints",
);
const DEFAULT_PIPELINES_DIR: string = resolve(
  PIPELINEFORGE_ROOT,
  "pipelines",
);
const DEFAULT_STATE_DIR: string = resolve(
  process.env["HOME"] ?? "/tmp",
  ".pipelineforge",
  "state",
);
const DEFAULT_CLAUDE_DIR: string = resolve(
  process.env["HOME"] ?? "/tmp",
  ".claude",
);
const DEFAULT_CLAUDE_JSON_PATH: string = resolve(
  process.env["HOME"] ?? "/tmp",
  ".claude.json",
);
const DEFAULT_IMAGE_NAME: string = "pipelineforge-claude";
const DEFAULT_GATEWAY_IMAGE_NAME: string = "pipelineforge-gateway";
const DOCKER_DIR: string = resolve(PIPELINEFORGE_ROOT, "docker");

// ── PipelineForge CLI ───────────────────────────────────────────────

const program: Command = new Command();

program
  .name("pipelineforge")
  .description(
    "DAG-based SDLC pipeline orchestrator using Claude Code in Docker",
  )
  .version("1.0.0");

// ── run command ─────────────────────────────────────────────────────

program
  .command("run")
  .description("Run a new pipeline")
  .requiredOption("--feature <description>", "Feature description")
  .option("--pipeline <name>", "Pipeline template", "full-sdlc")
  .option(
    "--notes-dir <path>",
    "Notes output directory",
    process.env["PIPELINEFORGE_NOTES_DIR"],
  )
  .option("--repo-dir <path>", "Target project repo directory (created if it does not exist)")
  .option("--max-concurrent <n>", "Max concurrent containers", "20")
  .option(
    "--review-timing <timing>",
    "When review agents run relative to merge: before, after, or both",
    "before",
  )
  .option("--blueprints-dir <path>", "Blueprints directory", DEFAULT_BLUEPRINTS_DIR)
  .option("--pipelines-dir <path>", "Pipelines directory", DEFAULT_PIPELINES_DIR)
  .option("--state-dir <path>", "State directory", DEFAULT_STATE_DIR)
  .option("--image <name>", "Docker image name", DEFAULT_IMAGE_NAME)
  .option("--proxy", "Use OpenClaw proxy container as execution backend", false)
  .option("--proxy-image <name>", "OpenClaw proxy container image", DEFAULT_GATEWAY_IMAGE_NAME)
  .option("--proxy-port <port>", "Proxy gateway port", "18789")
  .option("--docker-socket <path>", "Docker socket path", "/var/run/docker.sock")
  .option("--discord", "Enable Discord notifications via OpenClaw", false)
  .option("--discord-channel <id>", "Discord forum channel ID")
  .option("--openclaw-url <url>", "OpenClaw gateway URL", process.env["OPENCLAW_URL"] ?? "http://127.0.0.1:18789")
  .option("--openclaw-token <token>", "OpenClaw bearer token (or OPENCLAW_TOKEN env var)")
  .action(async (opts: {
    readonly feature: string;
    readonly pipeline: string;
    readonly notesDir: string | undefined;
    readonly repoDir: string | undefined;
    readonly maxConcurrent: string;
    readonly reviewTiming: string;
    readonly blueprintsDir: string;
    readonly pipelinesDir: string;
    readonly stateDir: string;
    readonly image: string;
    readonly proxy: boolean;
    readonly proxyImage: string;
    readonly proxyPort: string;
    readonly dockerSocket: string;
    readonly discord: boolean;
    readonly discordChannel: string | undefined;
    readonly openclawUrl: string;
    readonly openclawToken: string | undefined;
  }): Promise<void> => {
    const pipelineId: string = randomUUID().slice(0, 8);
    const repoDir: string = opts.repoDir !== undefined
      ? resolve(opts.repoDir)
      : resolve(opts.stateDir, pipelineId, "repo");

    // Auto-create the target repo directory if it does not exist
    await mkdir(repoDir, { recursive: true });

    const notesDir: string = opts.notesDir !== undefined
      ? resolve(opts.notesDir)
      : resolve(opts.stateDir, pipelineId, "notes");
    const reviewTiming: ReviewTiming = validateReviewTiming(opts.reviewTiming);
    const maxConcurrent: number = parseInt(opts.maxConcurrent, 10);

    console.log("╔══════════════════════════════════════════════════════╗");
    console.log("║              PipelineForge — run                    ║");
    console.log("╚══════════════════════════════════════════════════════╝");
    console.log(`  Pipeline:       ${opts.pipeline}`);
    console.log(`  Feature:        ${opts.feature}`);
    console.log(`  Repo:           ${repoDir}`);
    console.log(`  Notes:          ${notesDir}`);
    console.log(`  Max concurrent: ${String(maxConcurrent)}`);
    console.log(`  Review timing:  ${reviewTiming}`);
    console.log(`  Pipeline ID:    ${pipelineId}`);
    console.log("");

    // ── Load pipeline config ────────────────────────────────────
    console.log("Loading pipeline config...");
    const pipelineConfig: PipelineConfig = await loadPipelineConfig(
      opts.pipelinesDir,
      opts.pipeline,
    );
    console.log(
      `  Blueprints: ${pipelineConfig.blueprints.join(" → ")}`,
    );

    // ── Load blueprints ─────────────────────────────────────────
    console.log("Loading blueprints...");
    const registry: BlueprintRegistry = new BlueprintRegistry();
    await registry.loadFromDirectory(opts.blueprintsDir);
    console.log(`  Loaded ${String(registry.size)} blueprints`);

    // ── Build DAG ───────────────────────────────────────────────
    console.log("Building DAG...");
    const dagBuilder: DagBuilder = new DagBuilder();
    const graph: DagGraph = dagBuilder.build(
      registry.all(),
      pipelineConfig.blueprints,
    );
    console.log(
      `  Nodes: ${String(graph.nodes.size)} | ` +
      `Groups: ${String(graph.parallel_groups.length)}`,
    );
    for (let i = 0; i < graph.parallel_groups.length; i++) {
      const group: ReadonlyArray<string> = graph.parallel_groups[i]!;
      console.log(`  Group ${String(i)}: [${group.join(", ")}]`);
    }

    // ── Create initial state ────────────────────────────────────
    console.log("Initializing pipeline state...");
    let initialState: PipelineState = createInitialState(
      pipelineId,
      opts.pipeline,
      opts.feature,
      notesDir,
      repoDir,
      reviewTiming,
      graph,
    );

    // ── Instantiate managers ────────────────────────────────────
    const stateManager: StateManager = new StateManager(opts.stateDir);
    await stateManager.save(initialState);

    const logger: PipelineLogger = new ConsoleLogger();

    const gateEvaluator: GateEvaluator = new GateEvaluator();

    const worktreeManager: WorktreeManager = new WorktreeManager({
      repoDir,
      pipelineId,
    });

    const templateEngine: TemplateEngine = new TemplateEngine();
    const promptBuilder: PromptBuilder = new PromptBuilder(templateEngine);

    // ── Execution Backend ─────────────────────────────────────
    let executionBackend: ExecutionBackend;
    let proxyManager: ProxyContainerManager | null = null;

    if (opts.proxy) {
      // ── Path C: OpenClaw Proxy Container ────────────────────
      // Claude Max OAuth credentials in ~/.claude/ are mounted into the container.
      // ANTHROPIC_API_KEY is forwarded if set but not required.
      verifyClaudeCredentials();

      const proxyPort: number = parseInt(opts.proxyPort, 10);
      const configPath: string = resolve(opts.stateDir, pipelineId, "openclaw.json");

      // Generate openclaw.json config
      const configGenerator: ProxyConfigGenerator = new ProxyConfigGenerator({
        workerImage: opts.image,
        hostRepoDir: repoDir,
        hostNotesDir: notesDir,
        hostStateDir: opts.stateDir,
        hostClaudeDir: DEFAULT_CLAUDE_DIR,
      });

      const gatewayConfig: OpenClawGatewayConfig = configGenerator.generate(
        graph,
        registry,
        maxConcurrent,
        opts.discordChannel,
      );

      // Write openclaw.json to state directory
      const configDir: string = resolve(opts.stateDir, pipelineId);
      await mkdir(configDir, { recursive: true });
      await writeFile(configPath, configGenerator.serialize(gatewayConfig));

      // Register agents with OpenClaw CLI (deduplicate by blueprint name)
      const registrar: OpenClawAgentRegistrar = new OpenClawAgentRegistrar(
        logger,
        notesDir,
        {
          workerImage: opts.image,
          hostRepoDir: repoDir,
        },
      );
      const uniqueBlueprints: ReadonlySet<string> = new Set(
        Array.from(graph.nodes.values()).map(
          (node: DagNode): string => node.blueprint,
        ),
      );
      const blueprintMap: ReadonlyMap<string, Blueprint> = new Map(
        Array.from(uniqueBlueprints).map(
          (bpName: string): [string, Blueprint] => [
            bpName,
            registry.get(bpName),
          ],
        ),
      );
      await registrar.registerAll(blueprintMap, Array.from(uniqueBlueprints));

      console.log(`  Backend:        proxy (OpenClaw gateway)`);
      console.log(`  Proxy image:    ${opts.proxyImage}`);
      console.log(`  Proxy port:     ${String(proxyPort)}`);
      console.log(`  Config:         ${configPath}`);

      // Start proxy container
      const proxyConfig: ProxyContainerConfig = {
        pipelineId,
        containerName: `pf-proxy-${pipelineId}`,
        openclawImage: opts.proxyImage,
        gatewayPort: proxyPort,
        configPath,
        repoDir,
        notesDir,
        stateDir: opts.stateDir,
        claudeDir: DEFAULT_CLAUDE_DIR,
        claudeJsonPath: DEFAULT_CLAUDE_JSON_PATH,
        dockerSocketPath: opts.dockerSocket,
      };

      proxyManager = new ProxyContainerManager(proxyConfig, logger);
      await proxyManager.start();

      executionBackend = new ProxySessionManager(
        proxyManager.getGatewayUrl(),
        logger,
      );
    } else {
      // ── Path A: Direct Docker containers ────────────────────
      executionBackend = new DockerManager({
        pipelineId,
        imageName: opts.image,
        claudeDir: DEFAULT_CLAUDE_DIR,
        claudeJsonPath: DEFAULT_CLAUDE_JSON_PATH,
        repoDir,
        notesDir,
        stateDir: opts.stateDir,
      }, logger);

      console.log(`  Backend:        docker (direct containers)`);
    }

    // ── Notification Channel ─────────────────────────────────
    let notificationRouter: NotificationRouter | null = null;

    if (opts.discord) {
      if (opts.discordChannel === undefined) {
        console.error(
          "Discord enabled but --discord-channel not provided.",
        );
        process.exit(1);
      }

      const openclawConfig: OpenClawConfig = OpenClawConfigSchema.parse({
        forum_channel_id: opts.discordChannel,
      });

      const channel: NotificationChannel = new OpenClawClient(
        openclawConfig,
        logger,
      );

      notificationRouter = new NotificationRouter(channel, logger, null);

      // Create Discord thread and store ID in state
      const threadId: DiscordThreadId = await notificationRouter.ensureThread(
        pipelineId,
        opts.feature,
      );
      initialState = {
        ...initialState,
        discord_thread_id: String(threadId),
      };
      await stateManager.save(initialState);

      console.log(`  Discord:        enabled (thread: ${String(threadId)})`);
    }

    // ── Input Racer (streaming HITL) ─────────────────────────
    let inputRacer: InputRacer | null = null;

    if (opts.proxy) {
      const channels: InputChannel[] = [new CliInputChannel()];
      if (notificationRouter !== null) {
        channels.push(
          new DiscordInputChannel(notificationRouter, pipelineId, "pipeline"),
        );
      }
      inputRacer = new InputRacer(channels);
    }

    const executor: DagExecutor = new DagExecutor(
      executionBackend,
      gateEvaluator,
      stateManager,
      worktreeManager,
      promptBuilder,
      logger,
      { maxConcurrent, reviewTiming },
      notificationRouter,
      inputRacer,
    );

    // ── Execute ─────────────────────────────────────────────────
    console.log("");
    console.log("Executing pipeline...");
    console.log("─".repeat(56));

    try {
      const result: ExecutionResult = await executor.execute(
        graph,
        registry,
        initialState,
      );

      // ── Report ────────────────────────────────────────────────
      console.log("");
      printPipelineResult(result);
    } finally {
      // ── Input cleanup ──────────────────────────────────────────
      if (inputRacer !== null) {
        inputRacer.close();
      }
      // ── Proxy cleanup ─────────────────────────────────────────
      if (proxyManager !== null) {
        await proxyManager.stop();
      }
    }
  });

// ── resume command ──────────────────────────────────────────────────

program
  .command("resume")
  .description("Resume a paused pipeline")
  .requiredOption("--id <pipeline-id>", "Pipeline ID to resume")
  .option("--state-dir <path>", "State directory", DEFAULT_STATE_DIR)
  .option("--blueprints-dir <path>", "Blueprints directory", DEFAULT_BLUEPRINTS_DIR)
  .option("--pipelines-dir <path>", "Pipelines directory", DEFAULT_PIPELINES_DIR)
  .option("--image <name>", "Docker image name", DEFAULT_IMAGE_NAME)
  .option("--proxy", "Use OpenClaw proxy container as execution backend", false)
  .option("--proxy-image <name>", "OpenClaw proxy container image", DEFAULT_GATEWAY_IMAGE_NAME)
  .option("--proxy-port <port>", "Proxy gateway port", "18789")
  .option("--docker-socket <path>", "Docker socket path", "/var/run/docker.sock")
  .option("--discord", "Enable Discord notifications via OpenClaw", false)
  .option("--discord-channel <id>", "Discord forum channel ID")
  .option("--openclaw-url <url>", "OpenClaw gateway URL", process.env["OPENCLAW_URL"] ?? "http://127.0.0.1:18789")
  .option("--openclaw-token <token>", "OpenClaw bearer token (or OPENCLAW_TOKEN env var)")
  .action(async (opts: {
    readonly id: string;
    readonly stateDir: string;
    readonly blueprintsDir: string;
    readonly pipelinesDir: string;
    readonly image: string;
    readonly proxy: boolean;
    readonly proxyImage: string;
    readonly proxyPort: string;
    readonly dockerSocket: string;
    readonly discord: boolean;
    readonly discordChannel: string | undefined;
    readonly openclawUrl: string;
    readonly openclawToken: string | undefined;
  }): Promise<void> => {
    console.log("╔══════════════════════════════════════════════════════╗");
    console.log("║              PipelineForge — resume                 ║");
    console.log("╚══════════════════════════════════════════════════════╝");
    console.log(`  Pipeline ID: ${opts.id}`);

    // ── Load persisted state ────────────────────────────────────
    const stateManager: StateManager = new StateManager(opts.stateDir);
    const state: PipelineState = await stateManager.load(opts.id);

    if (state.status !== "paused") {
      console.error(
        `Pipeline ${opts.id} is not paused (status: ${state.status})`,
      );
      process.exit(1);
    }

    console.log(`  Feature:     ${state.feature}`);
    console.log(`  Status:      ${state.status}`);

    // ── Reload blueprints + config ──────────────────────────────
    const pipelineConfig: PipelineConfig = await loadPipelineConfig(
      opts.pipelinesDir,
      state.pipeline_name,
    );

    const registry: BlueprintRegistry = new BlueprintRegistry();
    await registry.loadFromDirectory(opts.blueprintsDir);

    const dagBuilder: DagBuilder = new DagBuilder();
    const graph: DagGraph = dagBuilder.build(
      registry.all(),
      pipelineConfig.blueprints,
    );

    // ── Rebuild executor ────────────────────────────────────────
    const resumeLogger: PipelineLogger = new ConsoleLogger();

    const resumeBackend: ExecutionBackend = buildExecutionBackend(
      opts,
      opts.id,
      state.repo_dir,
      state.notes_dir,
      resumeLogger,
    );

    // ── Notification Channel ─────────────────────────────────
    const resumeNotificationRouter: NotificationRouter | null =
      buildNotificationRouter(opts, resumeLogger, state.discord_thread_id);

    // ── Input Racer (streaming HITL) ─────────────────────────
    let resumeInputRacer: InputRacer | null = null;

    if (opts.proxy) {
      const channels: InputChannel[] = [new CliInputChannel()];
      if (resumeNotificationRouter !== null) {
        channels.push(
          new DiscordInputChannel(resumeNotificationRouter, opts.id, "pipeline"),
        );
      }
      resumeInputRacer = new InputRacer(channels);
    }

    const executor: DagExecutor = new DagExecutor(
      resumeBackend,
      new GateEvaluator(),
      stateManager,
      new WorktreeManager({ repoDir: state.repo_dir, pipelineId: opts.id }),
      new PromptBuilder(new TemplateEngine()),
      resumeLogger,
      {
        maxConcurrent: pipelineConfig.defaults.max_concurrent_containers,
        reviewTiming: state.review_timing,
      },
      resumeNotificationRouter,
      resumeInputRacer,
    );

    // ── Resume execution ────────────────────────────────────────
    console.log("");
    console.log("Resuming pipeline...");
    console.log("─".repeat(56));

    try {
      const result: ExecutionResult = await executor.execute(
        graph,
        registry,
        state,
      );

      console.log("");
      printPipelineResult(result);
    } finally {
      if (resumeInputRacer !== null) {
        resumeInputRacer.close();
      }
    }
  });

// ── retry command ───────────────────────────────────────────────────

program
  .command("retry")
  .description("Retry failed nodes in a pipeline")
  .requiredOption("--id <pipeline-id>", "Pipeline ID to retry")
  .option("--node <node-id>", "Specific node to retry (default: all failed nodes)")
  .option("--state-dir <path>", "State directory", DEFAULT_STATE_DIR)
  .option("--blueprints-dir <path>", "Blueprints directory", DEFAULT_BLUEPRINTS_DIR)
  .option("--pipelines-dir <path>", "Pipelines directory", DEFAULT_PIPELINES_DIR)
  .option("--image <name>", "Docker image name", DEFAULT_IMAGE_NAME)
  .option("--proxy", "Use OpenClaw proxy container as execution backend", false)
  .option("--proxy-image <name>", "OpenClaw proxy container image", DEFAULT_GATEWAY_IMAGE_NAME)
  .option("--proxy-port <port>", "Proxy gateway port", "18789")
  .option("--docker-socket <path>", "Docker socket path", "/var/run/docker.sock")
  .option("--discord", "Enable Discord notifications via OpenClaw", false)
  .option("--discord-channel <id>", "Discord forum channel ID")
  .option("--openclaw-url <url>", "OpenClaw gateway URL", process.env["OPENCLAW_URL"] ?? "http://127.0.0.1:18789")
  .option("--openclaw-token <token>", "OpenClaw bearer token (or OPENCLAW_TOKEN env var)")
  .action(async (opts: {
    readonly id: string;
    readonly node: string | undefined;
    readonly stateDir: string;
    readonly blueprintsDir: string;
    readonly pipelinesDir: string;
    readonly image: string;
    readonly proxy: boolean;
    readonly proxyImage: string;
    readonly proxyPort: string;
    readonly dockerSocket: string;
    readonly discord: boolean;
    readonly discordChannel: string | undefined;
    readonly openclawUrl: string;
    readonly openclawToken: string | undefined;
  }): Promise<void> => {
    console.log("╔══════════════════════════════════════════════════════╗");
    console.log("║              PipelineForge — retry                  ║");
    console.log("╚══════════════════════════════════════════════════════╝");
    console.log(`  Pipeline ID: ${opts.id}`);

    // ── Load persisted state ────────────────────────────────────
    const stateManager: StateManager = new StateManager(opts.stateDir);
    const state: PipelineState = await stateManager.load(opts.id);

    // ── Validate: pipeline must be failed or running (stuck) ────
    const failedNodes: ReadonlyArray<NodeState> = state.nodes.filter(
      (n: NodeState): boolean =>
        n.status === "failed" &&
        (opts.node === undefined || n.id === opts.node),
    );

    if (failedNodes.length === 0) {
      const scope: string = opts.node !== undefined
        ? `node "${opts.node}"`
        : "pipeline";
      console.error(`No failed nodes found in ${scope}.`);
      process.exit(1);
    }

    console.log(`  Feature:     ${state.feature}`);
    console.log(`  Status:      ${state.status}`);
    console.log(`  Retrying:    ${failedNodes.map((n: NodeState): string => n.id).join(", ")}`);

    // ── Reset failed nodes ────────────────────────────────────
    const resetState: PipelineState = stateManager.resetFailedNodes(
      state,
      opts.node,
    );
    await stateManager.save(resetState);

    // ── Reload blueprints + config ──────────────────────────────
    const pipelineConfig: PipelineConfig = await loadPipelineConfig(
      opts.pipelinesDir,
      resetState.pipeline_name,
    );

    const registry: BlueprintRegistry = new BlueprintRegistry();
    await registry.loadFromDirectory(opts.blueprintsDir);

    const dagBuilder: DagBuilder = new DagBuilder();
    const graph: DagGraph = dagBuilder.build(
      registry.all(),
      pipelineConfig.blueprints,
    );

    // ── Rebuild executor ────────────────────────────────────────
    const retryLogger: PipelineLogger = new ConsoleLogger();

    const retryBackend: ExecutionBackend = buildExecutionBackend(
      opts,
      opts.id,
      resetState.repo_dir,
      resetState.notes_dir,
      retryLogger,
    );

    // ── Notification Channel ─────────────────────────────────
    const retryNotificationRouter: NotificationRouter | null =
      buildNotificationRouter(opts, retryLogger, resetState.discord_thread_id);

    // ── Input Racer (streaming HITL) ─────────────────────────
    let retryInputRacer: InputRacer | null = null;

    if (opts.proxy) {
      const channels: InputChannel[] = [new CliInputChannel()];
      if (retryNotificationRouter !== null) {
        channels.push(
          new DiscordInputChannel(retryNotificationRouter, opts.id, "pipeline"),
        );
      }
      retryInputRacer = new InputRacer(channels);
    }

    const executor: DagExecutor = new DagExecutor(
      retryBackend,
      new GateEvaluator(),
      stateManager,
      new WorktreeManager({ repoDir: resetState.repo_dir, pipelineId: opts.id }),
      new PromptBuilder(new TemplateEngine()),
      retryLogger,
      {
        maxConcurrent: pipelineConfig.defaults.max_concurrent_containers,
        reviewTiming: resetState.review_timing,
      },
      retryNotificationRouter,
      retryInputRacer,
    );

    // ── Execute ─────────────────────────────────────────────────
    console.log("");
    console.log("Retrying pipeline...");
    console.log("─".repeat(56));

    try {
      const result: ExecutionResult = await executor.execute(
        graph,
        registry,
        resetState,
      );

      console.log("");
      printPipelineResult(result);
    } finally {
      if (retryInputRacer !== null) {
        retryInputRacer.close();
      }
    }
  });

// ── status command ──────────────────────────────────────────────────

program
  .command("status")
  .description("Show pipeline status")
  .option("--id <pipeline-id>", "Specific pipeline ID")
  .option("--state-dir <path>", "State directory", DEFAULT_STATE_DIR)
  .action(async (opts: {
    readonly id: string | undefined;
    readonly stateDir: string;
  }): Promise<void> => {
    const stateManager: StateManager = new StateManager(opts.stateDir);

    if (opts.id !== undefined) {
      // ── Single pipeline detail view ─────────────────────────
      const state: PipelineState = await stateManager.load(opts.id);
      printPipelineDetail(state);
    } else {
      // ── All pipelines summary ───────────────────────────────
      const summaries: ReadonlyArray<PipelineSummary> =
        await stateManager.list();

      if (summaries.length === 0) {
        console.log("No pipelines found.");
        return;
      }

      console.log("╔══════════════════════════════════════════════════════╗");
      console.log("║              PipelineForge — status                 ║");
      console.log("╚══════════════════════════════════════════════════════╝");
      console.log("");

      for (const s of summaries) {
        const icon: string = statusIcon(s.status);
        console.log(
          `  ${icon} ${s.id}  ${s.pipeline}  ${s.status}  "${s.feature}"`,
        );
      }
    }
  });

// ── build-image command ─────────────────────────────────────────────

program
  .command("build-image")
  .description("Build Docker images (worker and/or gateway)")
  .option("--tag <name>", "Worker image tag", DEFAULT_IMAGE_NAME)
  .option("--gateway", "Also build the OpenClaw gateway image", false)
  .option("--gateway-tag <name>", "Gateway image tag", DEFAULT_GATEWAY_IMAGE_NAME)
  .option("--gateway-only", "Only build the gateway image (skip worker)", false)
  .action(async (opts: {
    readonly tag: string;
    readonly gateway: boolean;
    readonly gatewayTag: string;
    readonly gatewayOnly: boolean;
  }): Promise<void> => {
    console.log("╔══════════════════════════════════════════════════════╗");
    console.log("║              PipelineForge — build-image            ║");
    console.log("╚══════════════════════════════════════════════════════╝");

    const buildLogger: PipelineLogger = new ConsoleLogger();

    if (!opts.gatewayOnly) {
      const workerDockerfile: string = resolve(DOCKER_DIR, "Dockerfile");
      console.log(`  Worker:     ${opts.tag}`);
      console.log(`  Dockerfile: ${workerDockerfile}`);
      const { stdout: wOut, stderr: wErr } = await DockerManager.buildImage(opts.tag, workerDockerfile);
      if (wOut.length > 0) { buildLogger.pipelineEvent("info", wOut); }
      if (wErr.length > 0) { buildLogger.pipelineEvent("warn", wErr); }
      console.log(`  ✓ Worker image built: ${opts.tag}`);
    }

    if (opts.gateway || opts.gatewayOnly) {
      const gatewayDockerfile: string = resolve(DOCKER_DIR, "Dockerfile.gateway");
      console.log(`  Gateway:    ${opts.gatewayTag}`);
      console.log(`  Dockerfile: ${gatewayDockerfile}`);
      const { stdout: gOut, stderr: gErr } = await DockerManager.buildImage(opts.gatewayTag, gatewayDockerfile);
      if (gOut.length > 0) { buildLogger.pipelineEvent("info", gOut); }
      if (gErr.length > 0) { buildLogger.pipelineEvent("warn", gErr); }
      console.log(`  ✓ Gateway image built: ${opts.gatewayTag}`);
    }
  });

// ── watch command ──────────────────────────────────────────────────

program
  .command("watch")
  .description("Attach to a running pipeline interactively")
  .requiredOption("--id <pipeline-id>", "Pipeline ID to watch")
  .option("--state-dir <path>", "State directory", DEFAULT_STATE_DIR)
  .option("--proxy-port <port>", "Proxy gateway port", "18789")
  .option("--discord", "Enable Discord input channel", false)
  .option("--discord-channel <id>", "Discord forum channel ID")
  .option("--openclaw-url <url>", "OpenClaw gateway URL", process.env["OPENCLAW_URL"] ?? "http://127.0.0.1:18789")
  .option("--openclaw-token <token>", "OpenClaw bearer token (or OPENCLAW_TOKEN env var)")
  .action(async (opts: {
    readonly id: string;
    readonly stateDir: string;
    readonly proxyPort: string;
    readonly discord: boolean;
    readonly discordChannel: string | undefined;
    readonly openclawUrl: string;
    readonly openclawToken: string | undefined;
  }): Promise<void> => {
    console.log("╔══════════════════════════════════════════════════════╗");
    console.log("║              PipelineForge — watch                  ║");
    console.log("╚══════════════════════════════════════════════════════╝");
    console.log(`  Pipeline ID: ${opts.id}`);

    // ── Load persisted state ────────────────────────────────────
    const stateManager: StateManager = new StateManager(opts.stateDir);
    const state: PipelineState = await stateManager.load(opts.id);

    console.log(`  Feature:     ${state.feature}`);
    console.log(`  Status:      ${state.status}`);
    console.log("");

    if (state.status === "completed" || state.status === "failed") {
      console.log(`Pipeline is already ${state.status}. Nothing to watch.`);
      printPipelineDetail(state);
      return;
    }

    // ── Build input channels ────────────────────────────────────
    const watchLogger: PipelineLogger = new ConsoleLogger();

    let watchNotificationRouter: NotificationRouter | null = null;
    if (opts.discord) {
      watchNotificationRouter = buildNotificationRouter(
        opts,
        watchLogger,
        state.discord_thread_id,
      );
    }

    const channels: InputChannel[] = [new CliInputChannel()];
    if (watchNotificationRouter !== null) {
      channels.push(
        new DiscordInputChannel(watchNotificationRouter, opts.id, "pipeline"),
      );
    }
    const inputRacer: InputRacer = new InputRacer(channels);

    // ── Find active and awaiting nodes ──────────────────────────
    const runningNodes: ReadonlyArray<NodeState> = state.nodes.filter(
      (n: NodeState): boolean => n.status === "running",
    );
    const awaitingNodes: ReadonlyArray<NodeState> = state.nodes.filter(
      (n: NodeState): boolean => n.status === "awaiting_answer",
    );

    console.log(
      `  Running nodes:  ${String(runningNodes.length)} | ` +
      `Awaiting answer: ${String(awaitingNodes.length)}`,
    );
    console.log("─".repeat(56));

    try {
      // ── Attach to running nodes via openclaw stream ─────────
      const streamProcesses: ChildProcess[] = [];

      for (const node of runningNodes) {
        console.log(`  Streaming output for ${node.id}...`);

        const child: ChildProcess = (await import("node:child_process")).spawn(
          "openclaw",
          ["agent", "--agent", node.id, "--json"],
        );

        streamProcesses.push(child);

        if (child.stdout !== null) {
          watchLogger.streamContainerOutput(node.id, child.stdout as import("node:stream").Readable);
        }
      }

      // ── Handle awaiting_answer nodes immediately ──────────────
      for (const node of awaitingNodes) {
        const question: string =
          node.output !== null
            ? node.output.split("\n").slice(-10).join("\n")
            : `Node ${node.id} is awaiting your answer.`;

        console.log(`\n  Node ${node.id} has a pending question:`);

        const input: UserInput = await inputRacer.race(question);

        // Inject answer via openclaw CLI
        try {
          await execFileAsync("openclaw", [
            "agent",
            "--session-id",
            node.id,
            "-m",
            input.content,
            "--json",
          ]);
          console.log(`  Answer sent to ${node.id} via ${input.source}`);
        } catch (err: unknown) {
          const message: string =
            err instanceof Error ? err.message : "Unknown error";
          console.error(`  Failed to send answer to ${node.id}: ${message}`);
        }
      }

      // ── Wait for user to Ctrl+C ──────────────────────────────
      if (runningNodes.length > 0) {
        console.log("\n  Watching pipeline output. Press Ctrl+C to detach.\n");

        await new Promise<void>((_resolve: () => void): void => {
          process.on("SIGINT", (): void => {
            console.log("\n  Detaching from pipeline...");
            for (const child of streamProcesses) {
              child.kill("SIGTERM");
            }
            _resolve();
          });
        });
      }
    } finally {
      inputRacer.close();
    }
  });

// ── sync command ───────────────────────────────────────────────────

const DEFAULT_SKILL_DIR: string = resolve(
  process.env["HOME"] ?? "/tmp",
  ".claude",
  "skills",
);

program
  .command("sync")
  .description("Sync blueprints from SKILL.md frontmatter and optionally generate OpenClaw config")
  .option("--skill-dir <path>", "Skill definitions directory", DEFAULT_SKILL_DIR)
  .option("--blueprint-dir <path>", "Blueprints output directory", DEFAULT_BLUEPRINTS_DIR)
  .option("--generate-config", "Also generate openclaw.json from synced blueprints", false)
  .option("--generate-lobster", "Also generate .lobster workflow files", false)
  .option("--pipeline <name>", "Pipeline template for config/lobster generation", "full-sdlc")
  .option("--pipelines-dir <path>", "Pipelines directory", DEFAULT_PIPELINES_DIR)
  .option("--config-output <path>", "Output path for openclaw.json")
  .option("--lobster-output <path>", "Output path for .lobster workflow file")
  .option("--image <name>", "Docker worker image name", DEFAULT_IMAGE_NAME)
  .option("--repo-dir <path>", "Host repo directory for OpenClaw mounts")
  .option("--notes-dir <path>", "Host notes directory for OpenClaw mounts")
  .option("--state-dir <path>", "State directory", DEFAULT_STATE_DIR)
  .option("--max-concurrent <n>", "Max concurrent OpenClaw sessions", "20")
  .option("--discord-channel <id>", "Discord channel ID for OpenClaw config")
  .action(async (opts: {
    readonly skillDir: string;
    readonly blueprintDir: string;
    readonly generateConfig: boolean;
    readonly generateLobster: boolean;
    readonly pipeline: string;
    readonly pipelinesDir: string;
    readonly configOutput: string | undefined;
    readonly lobsterOutput: string | undefined;
    readonly image: string;
    readonly repoDir: string | undefined;
    readonly notesDir: string | undefined;
    readonly stateDir: string;
    readonly maxConcurrent: string;
    readonly discordChannel: string | undefined;
  }): Promise<void> => {
    console.log("╔══════════════════════════════════════════════════════╗");
    console.log("║              PipelineForge — sync                   ║");
    console.log("╚══════════════════════════════════════════════════════╝");
    console.log(`  Skill dir:      ${opts.skillDir}`);
    console.log(`  Blueprint dir:  ${opts.blueprintDir}`);
    console.log("");

    // ── Discover skills ──────────────────────────────────────────
    console.log("Discovering skills...");
    const skills: ReadonlyArray<DiscoveredSkill> = await discoverSkills(opts.skillDir);
    console.log(`  Found ${String(skills.length)} skills`);

    // ── Sync blueprints ──────────────────────────────────────────
    console.log("Syncing blueprints...");
    const syncer: BlueprintSyncer = new BlueprintSyncer();
    const report: SyncReport = await syncer.sync(skills, opts.blueprintDir);

    // ── Print report ─────────────────────────────────────────────
    console.log("");
    console.log("Sync Report:");
    console.log("─".repeat(56));

    for (const entry of report.entries) {
      const icon: string = syncOutcomeIcon(entry.outcome);
      console.log(`  ${icon} ${entry.name as string} — ${entry.outcome}: ${entry.detail}`);
    }

    const created: number = report.entries.filter(
      (e: SyncEntry): boolean => e.outcome === "created",
    ).length;
    const updated: number = report.entries.filter(
      (e: SyncEntry): boolean => e.outcome === "updated",
    ).length;
    const unchanged: number = report.entries.filter(
      (e: SyncEntry): boolean => e.outcome === "unchanged",
    ).length;
    const errors: number = report.entries.filter(
      (e: SyncEntry): boolean => e.outcome === "error",
    ).length;

    console.log("");
    console.log(
      `  Created: ${String(created)} | Updated: ${String(updated)} | ` +
      `Unchanged: ${String(unchanged)} | Errors: ${String(errors)}`,
    );

    // ── Generate OpenClaw config ─────────────────────────────────
    if (opts.generateConfig) {
      console.log("");
      console.log("Generating OpenClaw config...");

      const pipelineConfig: PipelineConfig = await loadPipelineConfig(
        opts.pipelinesDir,
        opts.pipeline,
      );

      const registry: BlueprintRegistry = new BlueprintRegistry();
      await registry.loadFromDirectory(opts.blueprintDir);

      const repoDir: string = opts.repoDir ?? resolve(opts.stateDir, "repo");
      const notesDir: string = opts.notesDir ?? resolve(opts.stateDir, "notes");
      const maxConcurrent: number = parseInt(opts.maxConcurrent, 10);

      const configSyncer: OpenClawConfigSyncer = new OpenClawConfigSyncer({
        workerImage: opts.image,
        hostRepoDir: repoDir,
        hostNotesDir: notesDir,
        hostStateDir: opts.stateDir,
        hostClaudeDir: DEFAULT_CLAUDE_DIR,
        maxConcurrent,
      });

      const gatewayConfig: OpenClawGatewayConfig = configSyncer.generate(
        registry.all(),
        pipelineConfig.blueprints,
        opts.discordChannel,
      );

      const outputPath: string = opts.configOutput ?? resolve(
        opts.stateDir,
        "openclaw.json",
      );

      await configSyncer.writeConfig(gatewayConfig, outputPath);
      console.log(`  Written to: ${outputPath}`);
      console.log(`  Agents: ${String(gatewayConfig.agents.list.length)}`);

      // Register agents with OpenClaw CLI
      console.log("");
      console.log("Registering agents with OpenClaw...");
      const syncLogger: PipelineLogger = new ConsoleLogger();
      const registrar: OpenClawAgentRegistrar = new OpenClawAgentRegistrar(
        syncLogger,
        notesDir,
        {
          workerImage: opts.image,
          hostRepoDir: repoDir,
        },
      );
      await registrar.registerAll(registry.all(), pipelineConfig.blueprints);
      console.log(`  ✓ ${String(pipelineConfig.blueprints.length)} agents registered`);
    }

    // ── Generate Lobster workflow ──────────────────────────────────
    if (opts.generateLobster) {
      console.log("");
      console.log("Generating Lobster workflow...");

      // Load pipeline config if not already loaded
      const lobsterPipelineConfig: PipelineConfig = await loadPipelineConfig(
        opts.pipelinesDir,
        opts.pipeline,
      );

      const lobsterRegistry: BlueprintRegistry = new BlueprintRegistry();
      await lobsterRegistry.loadFromDirectory(opts.blueprintDir);

      const lobsterYaml: string = generateLobsterWorkflow(
        lobsterPipelineConfig,
        lobsterRegistry.all(),
      );

      const lobsterPath: string = opts.lobsterOutput ?? resolve(
        DEFAULT_PIPELINES_DIR,
        `${opts.pipeline}.lobster`,
      );

      await writeFile(lobsterPath, lobsterYaml, "utf-8");
      console.log(`  Written to: ${lobsterPath}`);
      console.log(`  Steps: ${String(lobsterPipelineConfig.blueprints.length)}`);
    }

    console.log("");
    console.log(`Timestamp: ${report.timestamp}`);
  });

// ── auto command ────────────────────────────────────────────────────

program
  .command("auto")
  .description("Interactive guided setup: prompts for inputs, checks prerequisites, syncs, builds, and runs the full pipeline")
  .option("--state-dir <path>", "State directory", DEFAULT_STATE_DIR)
  .option("--blueprints-dir <path>", "Blueprints directory", DEFAULT_BLUEPRINTS_DIR)
  .option("--pipelines-dir <path>", "Pipelines directory", DEFAULT_PIPELINES_DIR)
  .action(async (opts: {
    readonly stateDir: string;
    readonly blueprintsDir: string;
    readonly pipelinesDir: string;
  }): Promise<void> => {
    console.log("╔══════════════════════════════════════════════════════╗");
    console.log("║              PipelineForge — auto                   ║");
    console.log("╚══════════════════════════════════════════════════════╝");
    console.log("");

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    try {
      // ── Step 1: Gather user input ──────────────────────────────
      console.log("─── Configuration ─────────────────────────────────────");
      console.log("");

      const feature: string = await promptRequired(rl, "Feature description: ");

      const defaultRepoDir: string = process.cwd();
      const repoDir: string = resolve(
        await promptWithDefault(rl, "Target repo directory", defaultRepoDir),
      );

      const defaultNotesDir: string =
        process.env["PIPELINEFORGE_NOTES_DIR"] ?? resolve(opts.stateDir, "notes");
      const notesDir: string = resolve(
        await promptWithDefault(rl, "Notes directory", defaultNotesDir),
      );

      const pipeline: string = await promptWithDefault(rl, "Pipeline template", "full-sdlc");

      const maxConcurrentStr: string = await promptWithDefault(rl, "Max concurrent containers", "20");
      const maxConcurrent: number = parseInt(maxConcurrentStr, 10);

      const reviewTiming: ReviewTiming = validateReviewTiming(
        await promptWithDefault(rl, "Review timing (before/after/both)", "before"),
      );

      const enableDiscord: boolean = await promptYesNo(rl, "Enable Discord notifications?", false);
      let discordChannel: string | undefined;

      if (enableDiscord) {
        discordChannel = await promptRequired(rl, "Discord forum channel ID: ");
      }

      const skillDir: string = await promptWithDefault(
        rl,
        "Skill definitions directory",
        DEFAULT_SKILL_DIR,
      );

      console.log("");
      console.log("─── Summary ───────────────────────────────────────────");
      console.log(`  Feature:        ${feature}`);
      console.log(`  Repo:           ${repoDir}`);
      console.log(`  Notes:          ${notesDir}`);
      console.log(`  Pipeline:       ${pipeline}`);
      console.log(`  Max concurrent: ${String(maxConcurrent)}`);
      console.log(`  Review timing:  ${reviewTiming}`);
      console.log(`  Discord:        ${enableDiscord ? `yes (channel: ${discordChannel ?? "?"})` : "no"}`);
      console.log(`  Skill dir:      ${skillDir}`);
      console.log("");

      const proceed: boolean = await promptYesNo(rl, "Proceed?", true);
      if (!proceed) {
        console.log("Aborted.");
        return;
      }

      // Close readline before long-running steps (allows proxy HITL to use stdin)
      rl.close();

      console.log("");

      // ── Step 2: Check Docker is running ────────────────────────
      console.log("─── Checking prerequisites ────────────────────────────");
      console.log("");
      console.log("  Checking Docker daemon...");

      const dockerRunning: boolean = await DockerManager.isDaemonRunning();
      if (!dockerRunning) {
        console.error("  ✗ Docker is not running. Start Docker and try again.");
        process.exit(1);
      }
      console.log("  ✓ Docker is running");

      // ── Step 3: Check/build Docker images ──────────────────────
      const autoLogger: PipelineLogger = new ConsoleLogger();
      await DockerManager.ensureImage(DEFAULT_IMAGE_NAME, resolve(DOCKER_DIR, "Dockerfile"), "worker", autoLogger);
      await DockerManager.ensureImage(DEFAULT_GATEWAY_IMAGE_NAME, resolve(DOCKER_DIR, "Dockerfile.gateway"), "gateway", autoLogger);

      // ── Check Claude credentials ───────────────────────────────
      console.log("  Checking Claude credentials...");
      verifyClaudeCredentials();

      // ── Step 4: Sync blueprints + generate configs ─────────────
      console.log("");
      console.log("─── Syncing blueprints ────────────────────────────────");
      console.log("");

      console.log("  Discovering skills...");
      const skills: ReadonlyArray<DiscoveredSkill> = await discoverSkills(skillDir);
      console.log(`  Found ${String(skills.length)} skills`);

      console.log("  Syncing blueprints...");
      const syncer: BlueprintSyncer = new BlueprintSyncer();
      const report: SyncReport = await syncer.sync(skills, opts.blueprintsDir);

      for (const entry of report.entries) {
        const icon: string = syncOutcomeIcon(entry.outcome);
        console.log(`    ${icon} ${entry.name as string} — ${entry.outcome}: ${entry.detail}`);
      }

      // Generate OpenClaw config
      console.log("");
      console.log("  Generating OpenClaw config...");

      const pipelineConfig: PipelineConfig = await loadPipelineConfig(
        opts.pipelinesDir,
        pipeline,
      );

      const registry: BlueprintRegistry = new BlueprintRegistry();
      await registry.loadFromDirectory(opts.blueprintsDir);

      const configSyncer: OpenClawConfigSyncer = new OpenClawConfigSyncer({
        workerImage: DEFAULT_IMAGE_NAME,
        hostRepoDir: repoDir,
        hostNotesDir: notesDir,
        hostStateDir: opts.stateDir,
        hostClaudeDir: DEFAULT_CLAUDE_DIR,
        maxConcurrent,
      });

      const gatewayConfig: OpenClawGatewayConfig = configSyncer.generate(
        registry.all(),
        pipelineConfig.blueprints,
        discordChannel,
      );

      const pipelineId: string = randomUUID().slice(0, 8);
      const configDir: string = resolve(opts.stateDir, pipelineId);
      await mkdir(configDir, { recursive: true });
      const configPath: string = resolve(configDir, "openclaw.json");
      await configSyncer.writeConfig(gatewayConfig, configPath);
      console.log(`  ✓ Config written to ${configPath}`);
      console.log(`  ✓ Agents: ${String(gatewayConfig.agents.list.length)}`);

      // Register agents with OpenClaw CLI
      console.log("  Registering agents with OpenClaw...");
      const registrar: OpenClawAgentRegistrar = new OpenClawAgentRegistrar(
        autoLogger,
        notesDir,
        {
          workerImage: DEFAULT_IMAGE_NAME,
          hostRepoDir: repoDir,
        },
      );
      await registrar.registerAll(registry.all(), pipelineConfig.blueprints);
      console.log(`  ✓ ${String(pipelineConfig.blueprints.length)} agents registered with OpenClaw`);

      // Generate Lobster workflow
      console.log("  Generating Lobster workflow...");
      const lobsterYaml: string = generateLobsterWorkflow(pipelineConfig, registry.all());
      const lobsterPath: string = resolve(DEFAULT_PIPELINES_DIR, `${pipeline}.lobster`);
      await writeFile(lobsterPath, lobsterYaml, "utf-8");
      console.log(`  ✓ Workflow written to ${lobsterPath}`);

      // ── Step 5: Run the pipeline ───────────────────────────────
      console.log("");
      console.log("─── Running pipeline ──────────────────────────────────");
      console.log("");

      await mkdir(repoDir, { recursive: true });
      await mkdir(notesDir, { recursive: true });

      console.log(`  Pipeline ID:    ${pipelineId}`);
      console.log(`  Feature:        ${feature}`);
      console.log(`  Repo:           ${repoDir}`);
      console.log(`  Notes:          ${notesDir}`);
      console.log(`  Backend:        proxy (OpenClaw gateway)`);
      console.log("");

      // ── Build DAG ──────────────────────────────────────────────
      const dagBuilder: DagBuilder = new DagBuilder();
      const graph: DagGraph = dagBuilder.build(
        registry.all(),
        pipelineConfig.blueprints,
      );
      console.log(
        `  Nodes: ${String(graph.nodes.size)} | ` +
        `Groups: ${String(graph.parallel_groups.length)}`,
      );
      for (let i = 0; i < graph.parallel_groups.length; i++) {
        const group: ReadonlyArray<string> = graph.parallel_groups[i]!;
        console.log(`  Group ${String(i)}: [${group.join(", ")}]`);
      }

      // ── Create initial state ───────────────────────────────────
      let initialState: PipelineState = createInitialState(
        pipelineId,
        pipeline,
        feature,
        notesDir,
        repoDir,
        reviewTiming,
        graph,
      );

      const stateManager: StateManager = new StateManager(opts.stateDir);
      await stateManager.save(initialState);

      const logger: PipelineLogger = new ConsoleLogger();
      const gateEvaluator: GateEvaluator = new GateEvaluator();
      const worktreeManager: WorktreeManager = new WorktreeManager({
        repoDir,
        pipelineId,
      });
      const templateEngine: TemplateEngine = new TemplateEngine();
      const promptBuilder: PromptBuilder = new PromptBuilder(templateEngine);

      // ── Start proxy gateway ────────────────────────────────────
      // Claude Max OAuth credentials in ~/.claude/ are mounted into the container.
      // ANTHROPIC_API_KEY is forwarded if set but not required.
      verifyClaudeCredentials();

      const proxyPort: number = 18789;
      const proxyConfig: ProxyContainerConfig = {
        pipelineId,
        containerName: `pf-proxy-${pipelineId}`,
        openclawImage: DEFAULT_GATEWAY_IMAGE_NAME,
        gatewayPort: proxyPort,
        configPath,
        repoDir,
        notesDir,
        stateDir: opts.stateDir,
        claudeDir: DEFAULT_CLAUDE_DIR,
        claudeJsonPath: DEFAULT_CLAUDE_JSON_PATH,
        dockerSocketPath: "/var/run/docker.sock",
      };

      const proxyManager: ProxyContainerManager = new ProxyContainerManager(
        proxyConfig,
        logger,
      );
      await proxyManager.start();

      const executionBackend: ExecutionBackend = new ProxySessionManager(
        proxyManager.getGatewayUrl(),
        logger,
      );

      // ── Notification channel ───────────────────────────────────
      let notificationRouter: NotificationRouter | null = null;

      if (enableDiscord && discordChannel !== undefined) {
        // Ensure Discord channel is registered with OpenClaw
        await registrar.ensureDiscordChannel();

        const openclawConfig: OpenClawConfig = OpenClawConfigSchema.parse({
          forum_channel_id: discordChannel,
        });

        const channel: NotificationChannel = new OpenClawClient(
          openclawConfig,
          logger,
        );

        notificationRouter = new NotificationRouter(channel, logger, null);

        const threadId: DiscordThreadId = await notificationRouter.ensureThread(
          pipelineId,
          feature,
        );
        initialState = {
          ...initialState,
          discord_thread_id: String(threadId),
        };
        await stateManager.save(initialState);
        console.log(`  Discord:        enabled (thread: ${String(threadId)})`);
      }

      // ── Input racer ────────────────────────────────────────────
      const inputChannels: InputChannel[] = [new CliInputChannel()];
      if (notificationRouter !== null) {
        inputChannels.push(
          new DiscordInputChannel(notificationRouter, pipelineId, "pipeline"),
        );
      }
      const inputRacer: InputRacer = new InputRacer(inputChannels);

      // ── Execute ────────────────────────────────────────────────
      const executor: DagExecutor = new DagExecutor(
        executionBackend,
        gateEvaluator,
        stateManager,
        worktreeManager,
        promptBuilder,
        logger,
        { maxConcurrent, reviewTiming },
        notificationRouter,
        inputRacer,
      );

      console.log("");
      console.log("Executing pipeline...");
      console.log("─".repeat(56));

      try {
        const result: ExecutionResult = await executor.execute(
          graph,
          registry,
          initialState,
        );

        console.log("");
        printPipelineResult(result);
      } finally {
        inputRacer.close();
        await proxyManager.stop();
      }
    } finally {
      rl.close();
    }
  });

program.parse();

// ── Helpers ─────────────────────────────────────────────────────────

// ── Readline Prompt Helpers ─────────────────────────────────────────

/**
 * Strip surrounding single or double quotes from user input.
 * Users often paste shell-quoted paths like `"/path/to/dir"` or `'/path/to/dir'`.
 */
function stripQuotes(input: string): string {
  if (
    (input.startsWith('"') && input.endsWith('"')) ||
    (input.startsWith("'") && input.endsWith("'"))
  ) {
    return input.slice(1, -1);
  }
  return input;
}

async function promptRequired(
  rl: import("node:readline/promises").Interface,
  question: string,
): Promise<string> {
  let answer: string = "";
  while (answer.length === 0) {
    answer = stripQuotes((await rl.question(question)).trim());
    if (answer.length === 0) {
      console.log("  (required — please enter a value)");
    }
  }
  return answer;
}

async function promptWithDefault(
  rl: import("node:readline/promises").Interface,
  label: string,
  defaultValue: string,
): Promise<string> {
  const answer: string = stripQuotes((await rl.question(`${label} [${defaultValue}]: `)).trim());
  return answer.length > 0 ? answer : defaultValue;
}

async function promptYesNo(
  rl: import("node:readline/promises").Interface,
  question: string,
  defaultYes: boolean,
): Promise<boolean> {
  const hint: string = defaultYes ? "Y/n" : "y/N";
  const answer: string = (await rl.question(`${question} (${hint}): `)).trim().toLowerCase();
  if (answer.length === 0) {
    return defaultYes;
  }
  return answer === "y" || answer === "yes";
}



// ── Claude Credential Verification ──────────────────────────────────

/**
 * Verify that Claude Code credentials are available on the host.
 * Supports two authentication paths:
 *   1. Claude Max (OAuth) — credentials stored in ~/.claude/ after `claude login`
 *   2. API key — ANTHROPIC_API_KEY environment variable
 *
 * Both are mounted/forwarded into Docker containers. At least one must be present.
 *
 * @throws Exits the process if no credentials are found
 */
function verifyClaudeCredentials(): void {
  const hasApiKey: boolean =
    process.env["ANTHROPIC_API_KEY"] !== undefined &&
    process.env["ANTHROPIC_API_KEY"]!.length > 0;

  // Claude Max stores OAuth session tokens in ~/.claude.json.
  // The ~/.claude/ directory contains settings, history, and session data.
  const hasClaudeAuth: boolean =
    existsSync(DEFAULT_CLAUDE_JSON_PATH) ||
    existsSync(resolve(DEFAULT_CLAUDE_DIR, "statsig"));

  if (!hasApiKey && !hasClaudeAuth) {
    console.error(
      "No Claude credentials found.\n" +
      "  Option 1 (Claude Max): Run `claude login` to authenticate via OAuth\n" +
      "  Option 2 (API key):    Set ANTHROPIC_API_KEY environment variable\n" +
      "\n" +
      `  Checked: ${DEFAULT_CLAUDE_DIR}/ and $ANTHROPIC_API_KEY`,
    );
    process.exit(1);
  }

  if (hasApiKey) {
    console.log("  Auth: ANTHROPIC_API_KEY detected");
  } else {
    console.log("  Auth: Claude Max credentials detected (OAuth)");
  }
}

function syncOutcomeIcon(outcome: string): string {
  switch (outcome) {
    case "created":
      return "+";
    case "updated":
      return "~";
    case "unchanged":
      return "=";
    case "error":
      return "!";
    default:
      return "?";
  }
}

// ── Execution Backend Builder ────────────────────────────────────────

interface ProxyOpts {
  readonly proxy: boolean;
  readonly proxyPort: string;
  readonly image: string;
  readonly stateDir: string;
}

function buildExecutionBackend(
  opts: ProxyOpts,
  pipelineId: string,
  repoDir: string,
  notesDir: string,
  logger: PipelineLogger,
): ExecutionBackend {
  if (opts.proxy) {
    const proxyPort: number = parseInt(opts.proxyPort, 10);
    const gatewayUrl: string = `http://127.0.0.1:${String(proxyPort)}`;
    return new ProxySessionManager(gatewayUrl, logger);
  }

  return new DockerManager({
    pipelineId,
    imageName: opts.image,
    claudeDir: DEFAULT_CLAUDE_DIR,
    claudeJsonPath: DEFAULT_CLAUDE_JSON_PATH,
    repoDir,
    notesDir,
    stateDir: opts.stateDir,
  }, logger);
}

// ── Notification Router Builder ─────────────────────────────────────

interface DiscordOpts {
  readonly discord: boolean;
  readonly discordChannel: string | undefined;
}

function buildNotificationRouter(
  opts: DiscordOpts,
  logger: PipelineLogger,
  existingThreadId: string | null,
): NotificationRouter | null {
  if (!opts.discord) {
    return null;
  }

  if (opts.discordChannel === undefined) {
    console.error(
      "Discord enabled but --discord-channel not provided.",
    );
    process.exit(1);
  }

  const openclawConfig: OpenClawConfig = OpenClawConfigSchema.parse({
    forum_channel_id: opts.discordChannel,
  });

  const channel: NotificationChannel = new OpenClawClient(
    openclawConfig,
    logger,
  );

  const threadId: DiscordThreadId | null =
    existingThreadId !== null ? toThreadId(existingThreadId) : null;

  return new NotificationRouter(channel, logger, threadId);
}

function validateReviewTiming(timing: string): ReviewTiming {
  if (timing === "before" || timing === "after" || timing === "both") {
    return timing;
  }
  throw new Error(
    `Invalid review timing: "${timing}". Must be "before", "after", or "both".`,
  );
}

function createInitialState(
  pipelineId: string,
  pipelineName: string,
  feature: string,
  notesDir: string,
  repoDir: string,
  reviewTiming: ReviewTiming,
  graph: DagGraph,
): PipelineState {
  const now: string = new Date().toISOString();

  const nodes: ReadonlyArray<NodeState> = Array.from(
    graph.nodes.values(),
  ).map(
    (dagNode: DagNode): NodeState => ({
      id: dagNode.id,
      blueprint: dagNode.blueprint,
      instance: dagNode.instance,
      status: "pending",
      depends_on: [...dagNode.dependencies],
      started_at: null,
      completed_at: null,
      duration_ms: null,
      container_id: null,
      worktree_branch: null,
      worktree_path: null,
      dry_run_output: null,
      exit_code: null,
      output: null,
      error: null,
      gate_result: null,
      rejection_count: 0,
      rejection_history: [],
    }),
  );

  return {
    id: pipelineId,
    pipeline_name: pipelineName,
    feature,
    notes_dir: notesDir,
    repo_dir: repoDir,
    review_timing: reviewTiming,
    created_at: now,
    updated_at: now,
    status: "running",
    discord_thread_id: null,
    nodes,
  };
}

function statusIcon(status: string): string {
  switch (status) {
    case "running":
      return "▶";
    case "paused":
      return "⏸";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    default:
      return "?";
  }
}

function nodeStatusIcon(status: string): string {
  switch (status) {
    case "pending":
      return "○";
    case "ready":
      return "◎";
    case "running":
    case "implementing":
      return "▶";
    case "passed":
      return "✓";
    case "failed":
      return "✗";
    case "skipped":
      return "─";
    case "awaiting_proposal_review":
    case "awaiting_implementation_review":
    case "awaiting_human":
      return "⏸";
    case "dry_run_complete":
      return "◇";
    default:
      return "?";
  }
}

function printPipelineResult(result: ExecutionResult): void {
  const state: PipelineState = result.state;

  if (result.paused) {
    console.log("╔══════════════════════════════════════════════════════╗");
    console.log("║  ⏸  Pipeline PAUSED                                 ║");
    console.log("╚══════════════════════════════════════════════════════╝");
    console.log(`  Reason: ${result.pauseReason ?? "unknown"}`);
    console.log("");
    console.log(`  Resume with:`);
    console.log(`    pipelineforge resume --id ${state.id}`);
  } else if (state.status === "completed") {
    console.log("╔══════════════════════════════════════════════════════╗");
    console.log("║  ✓  Pipeline COMPLETED                              ║");
    console.log("╚══════════════════════════════════════════════════════╝");
  } else if (state.status === "failed") {
    console.log("╔══════════════════════════════════════════════════════╗");
    console.log("║  ✗  Pipeline FAILED                                 ║");
    console.log("╚══════════════════════════════════════════════════════╝");
  }

  console.log("");
  printPipelineDetail(state);
}

function printPipelineDetail(state: PipelineState): void {
  console.log(`Pipeline: ${state.id} (${state.pipeline_name})`);
  console.log(`Feature:  ${state.feature}`);
  console.log(`Status:   ${state.status}`);
  console.log(`Created:  ${state.created_at}`);
  console.log(`Updated:  ${state.updated_at}`);
  console.log("");
  console.log("Nodes:");

  for (const node of state.nodes) {
    const icon: string = nodeStatusIcon(node.status);
    const duration: string =
      node.duration_ms !== null
        ? ` (${String(Math.round(node.duration_ms / 1000))}s)`
        : "";
    console.log(`  ${icon} ${node.id} — ${node.status}${duration}`);

    if (node.gate_result !== null) {
      console.log(`    Gate: ${node.gate_result.details}`);
    }
    if (node.error !== null) {
      console.log(`    Error: ${node.error}`);
    }
  }
}
