#!/usr/bin/env node

import { Command } from "commander";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DagGraph, DagNode } from "../types/Graph.js";
import type {
  NodeState,
  PipelineState,
  PipelineConfig,
  ReviewTiming,
  PipelineSummary,
} from "../types/Pipeline.js";
import type { ExecutionResult } from "../core/DagExecutor.js";
import { BlueprintRegistry } from "../core/BlueprintRegistry.js";
import { DagBuilder } from "../core/DagBuilder.js";
import { DagExecutor } from "../core/DagExecutor.js";
import { DockerManager } from "../core/DockerManager.js";
import { GateEvaluator } from "../core/GateEvaluator.js";
import { StateManager } from "../core/StateManager.js";
import { WorktreeManager } from "../core/WorktreeManager.js";
import { PromptBuilder } from "../utils/PromptBuilder.js";
import { TemplateEngine } from "../utils/TemplateEngine.js";
import { loadPipelineConfig } from "../core/PipelineConfigLoader.js";

const execFileAsync: typeof execFile.__promisify__ = promisify(execFile);

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
const DEFAULT_IMAGE_NAME: string = "pipelineforge-claude";

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
  .option("--repo-dir <path>", "Project repo directory", process.cwd())
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
  .action(async (opts: {
    readonly feature: string;
    readonly pipeline: string;
    readonly notesDir: string | undefined;
    readonly repoDir: string;
    readonly maxConcurrent: string;
    readonly reviewTiming: string;
    readonly blueprintsDir: string;
    readonly pipelinesDir: string;
    readonly stateDir: string;
    readonly image: string;
  }): Promise<void> => {
    const pipelineId: string = randomUUID().slice(0, 8);
    const repoDir: string = resolve(opts.repoDir);
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
    const initialState: PipelineState = createInitialState(
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

    const dockerManager: DockerManager = new DockerManager({
      pipelineId,
      imageName: opts.image,
      claudeDir: DEFAULT_CLAUDE_DIR,
      repoDir,
      notesDir,
      stateDir: opts.stateDir,
    });

    const gateEvaluator: GateEvaluator = new GateEvaluator();

    const worktreeManager: WorktreeManager = new WorktreeManager({
      repoDir,
      pipelineId,
    });

    const templateEngine: TemplateEngine = new TemplateEngine();
    const promptBuilder: PromptBuilder = new PromptBuilder(templateEngine);

    const executor: DagExecutor = new DagExecutor(
      dockerManager,
      gateEvaluator,
      stateManager,
      worktreeManager,
      promptBuilder,
      { maxConcurrent, reviewTiming },
    );

    // ── Execute ─────────────────────────────────────────────────
    console.log("");
    console.log("Executing pipeline...");
    console.log("─".repeat(56));

    const result: ExecutionResult = await executor.execute(
      graph,
      registry,
      initialState,
    );

    // ── Report ──────────────────────────────────────────────────
    console.log("");
    printPipelineResult(result);
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
  .action(async (opts: {
    readonly id: string;
    readonly stateDir: string;
    readonly blueprintsDir: string;
    readonly pipelinesDir: string;
    readonly image: string;
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
    const dockerManager: DockerManager = new DockerManager({
      pipelineId: opts.id,
      imageName: opts.image,
      claudeDir: DEFAULT_CLAUDE_DIR,
      repoDir: state.repo_dir,
      notesDir: state.notes_dir,
      stateDir: opts.stateDir,
    });

    const executor: DagExecutor = new DagExecutor(
      dockerManager,
      new GateEvaluator(),
      stateManager,
      new WorktreeManager({ repoDir: state.repo_dir, pipelineId: opts.id }),
      new PromptBuilder(new TemplateEngine()),
      {
        maxConcurrent: pipelineConfig.defaults.max_concurrent_containers,
        reviewTiming: state.review_timing,
      },
    );

    // ── Resume execution ────────────────────────────────────────
    console.log("");
    console.log("Resuming pipeline...");
    console.log("─".repeat(56));

    const result: ExecutionResult = await executor.execute(
      graph,
      registry,
      state,
    );

    console.log("");
    printPipelineResult(result);
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
  .action(async (opts: {
    readonly id: string;
    readonly node: string | undefined;
    readonly stateDir: string;
    readonly blueprintsDir: string;
    readonly pipelinesDir: string;
    readonly image: string;
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
    const dockerManager: DockerManager = new DockerManager({
      pipelineId: opts.id,
      imageName: opts.image,
      claudeDir: DEFAULT_CLAUDE_DIR,
      repoDir: resetState.repo_dir,
      notesDir: resetState.notes_dir,
      stateDir: opts.stateDir,
    });

    const executor: DagExecutor = new DagExecutor(
      dockerManager,
      new GateEvaluator(),
      stateManager,
      new WorktreeManager({ repoDir: resetState.repo_dir, pipelineId: opts.id }),
      new PromptBuilder(new TemplateEngine()),
      {
        maxConcurrent: pipelineConfig.defaults.max_concurrent_containers,
        reviewTiming: resetState.review_timing,
      },
    );

    // ── Execute ─────────────────────────────────────────────────
    console.log("");
    console.log("Retrying pipeline...");
    console.log("─".repeat(56));

    const result: ExecutionResult = await executor.execute(
      graph,
      registry,
      resetState,
    );

    console.log("");
    printPipelineResult(result);
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
  .description("Build the Claude Code Docker image")
  .option("--tag <name>", "Image tag", DEFAULT_IMAGE_NAME)
  .action(async (opts: { readonly tag: string }): Promise<void> => {
    const dockerfilePath: string = resolve(PIPELINEFORGE_ROOT, "docker");

    console.log("╔══════════════════════════════════════════════════════╗");
    console.log("║              PipelineForge — build-image            ║");
    console.log("╚══════════════════════════════════════════════════════╝");
    console.log(`  Dockerfile: ${dockerfilePath}/Dockerfile`);
    console.log(`  Tag:        ${opts.tag}`);
    console.log("");

    try {
      const { stdout, stderr } = await execFileAsync("docker", [
        "build",
        "-t",
        opts.tag,
        dockerfilePath,
      ]);

      if (stdout.length > 0) {
        console.log(stdout);
      }
      if (stderr.length > 0) {
        console.error(stderr);
      }

      console.log(`Image built successfully: ${opts.tag}`);
    } catch (err: unknown) {
      const message: string =
        err instanceof Error ? err.message : "Unknown error";
      console.error(`Failed to build image: ${message}`);
      process.exit(1);
    }
  });

program.parse();

// ── Helpers ─────────────────────────────────────────────────────────

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
