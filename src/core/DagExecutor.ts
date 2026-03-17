import type { Blueprint } from "../types/Blueprint.js";
import type { DagGraph, DagNode } from "../types/Graph.js";
import type {
  ContainerResult,
  NodeState,
  PipelineState,
  ReviewTiming,
} from "../types/Pipeline.js";
import type { BlueprintRegistry } from "./BlueprintRegistry.js";
import type { DockerManager } from "./DockerManager.js";
import type { GateEvaluator, GateEvaluation } from "./GateEvaluator.js";
import type { StateManager } from "./StateManager.js";
import type { WorktreeManager, WorktreeInfo, MergeResult } from "./WorktreeManager.js";
import type { PromptBuilder, PromptContext } from "../utils/PromptBuilder.js";
import type { PipelineLogger, NodeLogEvent } from "../types/Logger.js";
import { NodeFSM, createNodeFSM } from "./NodeFSM.js";
import type { StateId, TransitionEvent } from "./NodeFSM.js";
import { PipelineFSM, createPipelineFSM } from "./PipelineFSM.js";
import type { PipelineEvent } from "./PipelineFSM.js";

// ── Executor Config ─────────────────────────────────────────────────

export interface ExecutorConfig {
  readonly maxConcurrent: number;
  readonly reviewTiming: ReviewTiming;
}

// ── Execution Result ────────────────────────────────────────────────

export interface ExecutionResult {
  readonly state: PipelineState;
  readonly paused: boolean;
  readonly pauseReason: string | null;
}

// ── DAG Executor ────────────────────────────────────────────────────
// Pure state machine executor. Every state change flows through
// NodeFSM.transition(event) or PipelineFSM.transition(event).
// No ad-hoc status string manipulation — the FSMs are the sole
// authority on valid state transitions.

export class DagExecutor {
  private readonly dockerManager: DockerManager;
  private readonly gateEvaluator: GateEvaluator;
  private readonly stateManager: StateManager;
  private readonly worktreeManager: WorktreeManager;
  private readonly promptBuilder: PromptBuilder;
  private readonly logger: PipelineLogger;
  private readonly config: ExecutorConfig;

  // ── FSM instances ─────────────────────────────────────────────────

  private readonly nodeFSMs: Map<string, NodeFSM> = new Map();
  private pipelineFSM: PipelineFSM | null = null;

  constructor(
    dockerManager: DockerManager,
    gateEvaluator: GateEvaluator,
    stateManager: StateManager,
    worktreeManager: WorktreeManager,
    promptBuilder: PromptBuilder,
    logger: PipelineLogger,
    config: ExecutorConfig,
  ) {
    this.dockerManager = dockerManager;
    this.gateEvaluator = gateEvaluator;
    this.stateManager = stateManager;
    this.worktreeManager = worktreeManager;
    this.promptBuilder = promptBuilder;
    this.logger = logger;
    this.config = config;
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Execute the full DAG. All state transitions are driven by FSM events.
   *
   * @param graph - The built DAG
   * @param blueprints - Blueprint registry
   * @param state - Current pipeline state (for resume support)
   * @returns ExecutionResult with final state and pause info
   */
  async execute(
    graph: DagGraph,
    blueprints: BlueprintRegistry,
    state: PipelineState,
  ): Promise<ExecutionResult> {
    this.initializeFSMs(state);

    // Resume from paused state
    if (this.pipelineFSM!.getStateName() === "paused") {
      this.logger.pipelineEvent("info", "Resuming pipeline...");
      this.applyPipelineEvent("RESUME");
      state = this.syncPipelineStatus(state);
    }

    let currentState: PipelineState = state;

    // ── Main loop: dispatch ready nodes until no more work ───────
    while (true) {
      const readyNodes: ReadonlyArray<string> = this.findReadyNodes(
        graph,
        currentState,
      );

      if (readyNodes.length === 0) {
        break;
      }

      // Dispatch batch respecting concurrency limit
      const batchSize: number = Math.min(
        readyNodes.length,
        this.config.maxConcurrent - this.countActive(currentState),
      );
      const batch: ReadonlyArray<string> = readyNodes.slice(0, batchSize);

      this.logger.pipelineEvent(
        "info",
        `Dispatching batch: ${batch.join(", ")}`,
      );

      // Execute all nodes in the batch concurrently
      const outcomes: ReadonlyArray<NodeOutcome> = await Promise.all(
        batch.map(
          (nodeId: string): Promise<NodeOutcome> =>
            this.dispatchNode(nodeId, graph, blueprints, currentState),
        ),
      );

      // Apply outcomes to state
      for (const outcome of outcomes) {
        currentState = this.applyOutcome(outcome, currentState);

        // If any node caused a pause, persist and return immediately
        if (outcome.pause !== null) {
          this.applyPipelineEvent("NODE_PAUSED");
          currentState = this.syncPipelineStatus(currentState);
          await this.stateManager.save(currentState);

          this.logger.pipelineEvent(
            "info",
            `Pipeline paused: ${outcome.pause}`,
          );

          return {
            state: currentState,
            paused: true,
            pauseReason: outcome.pause,
          };
        }
      }

      await this.stateManager.save(currentState);
    }

    // ── Resolve final pipeline status via FSM ───────────────────
    currentState = this.resolveFinalStatus(currentState);
    await this.stateManager.save(currentState);

    this.logger.pipelineEvent(
      currentState.status === "failed" ? "error" : "info",
      `Pipeline ${currentState.status}`,
    );

    return {
      state: currentState,
      paused: false,
      pauseReason: null,
    };
  }

  /**
   * Abort the pipeline — kill containers, clean up worktrees.
   * All state changes go through the FSMs.
   */
  async abort(state: PipelineState): Promise<PipelineState> {
    this.initializeFSMs(state);

    await this.dockerManager.killAll();
    await this.worktreeManager.cleanupAll();

    // Skip all non-terminal nodes
    for (const [nodeId, fsm] of this.nodeFSMs) {
      if (!fsm.isTerminal() && fsm.canTransition("SKIP")) {
        fsm.transition("SKIP");
        state = this.stateManager.updateNode(state, nodeId, {
          status: fsm.getStateName(),
        });
      }
    }

    this.applyPipelineEvent("ABORT");
    state = this.syncPipelineStatus(state);
    await this.stateManager.save(state);

    return state;
  }

  // ── FSM Initialization ────────────────────────────────────────────

  private initializeFSMs(state: PipelineState): void {
    this.pipelineFSM = createPipelineFSM(state.id, state.status);

    this.nodeFSMs.clear();
    for (const nodeState of state.nodes) {
      this.nodeFSMs.set(
        nodeState.id,
        createNodeFSM(nodeState.id, nodeState.status),
      );
    }
  }

  // ── Node Dispatch ─────────────────────────────────────────────────
  // Routes to the correct execution path based on FSM state and
  // blueprint configuration.

  private async dispatchNode(
    nodeId: string,
    graph: DagGraph,
    blueprints: BlueprintRegistry,
    state: PipelineState,
  ): Promise<NodeOutcome> {
    const fsm: NodeFSM = this.nodeFSMs.get(nodeId)!;
    const node: DagNode = graph.nodes.get(nodeId)!;
    const blueprint: Blueprint = blueprints.get(node.blueprint);

    // ── Route based on current FSM state ────────────────────────

    const currentState: string = fsm.getStateName();

    // Resuming from proposal review (user approved)
    if (currentState === "awaiting_proposal_review") {
      return this.handleProposalApproved(node, blueprint, fsm, state);
    }

    // Resuming from implementation review (user approved)
    if (currentState === "awaiting_implementation_review") {
      return this.handleImplApproved(node, blueprint, fsm, state);
    }

    // Fresh dispatch: PENDING → READY → RUNNING
    this.applyNodeEvent(fsm, "DEPS_SATISFIED");
    this.applyNodeEvent(fsm, "DISPATCH");

    this.logger.nodeEvent("info", this.toLogEvent(node), "Dispatched");

    // Branch: review mode vs standard
    if (blueprint.review_mode.enabled) {
      return this.handleDryRun(node, blueprint, fsm, state);
    }

    return this.handleStandardExecution(node, blueprint, fsm, state);
  }

  // ── Standard Execution Path ───────────────────────────────────────
  // RUNNING → (container) → GATE_PASSED | GATE_FAILED | HUMAN_GATE

  private async handleStandardExecution(
    node: DagNode,
    blueprint: Blueprint,
    fsm: NodeFSM,
    state: PipelineState,
  ): Promise<NodeOutcome> {
    const prompt: string = await this.promptBuilder.buildPrompt(
      blueprint,
      this.buildContext(node, state),
    );

    const result: ContainerResult = await this.dockerManager.spawnContainer({
      node,
      blueprint,
      prompt,
    });

    // Gate evaluation produces the FSM event
    const evaluation: GateEvaluation = this.gateEvaluator.evaluateToEvent(
      blueprint.gate,
      result,
      state,
      node.id,
    );

    // Apply the event to the FSM
    this.applyNodeEvent(fsm, evaluation.event);

    // If human gate, produce a pause
    if (evaluation.event === "HUMAN_GATE") {
      return {
        nodeId: node.id,
        stateUpdates: {
          status: fsm.getStateName(),
          output: result.stdout,
          exit_code: result.exitCode,
          gate_result: evaluation.result,
          started_at: new Date().toISOString(),
        },
        pause: `Human gate: ${node.id} — awaiting approval`,
      };
    }

    // If gate failed, record rejection
    if (evaluation.event === "GATE_FAILED") {
      this.logger.nodeEvent(
        "error",
        this.toLogEvent(node),
        `Gate FAILED — ${evaluation.result.details}`,
      );

      return {
        nodeId: node.id,
        stateUpdates: {
          status: fsm.getStateName(),
          output: result.stdout,
          exit_code: result.exitCode,
          gate_result: evaluation.result,
          completed_at: new Date().toISOString(),
        },
        rejection: {
          gateResult: evaluation.result,
          routeTo: blueprint.gate.rejection_routes_to,
        },
        pause: null,
      };
    }

    // Gate passed
    this.logger.nodeEvent(
      "info",
      this.toLogEvent(node),
      `Gate PASSED — ${evaluation.result.details}`,
    );

    return {
      nodeId: node.id,
      stateUpdates: {
        status: fsm.getStateName(),
        output: result.stdout,
        exit_code: result.exitCode,
        gate_result: evaluation.result,
        completed_at: new Date().toISOString(),
      },
      pause: null,
    };
  }

  // ── Review Mode: Phase 1 — Dry Run ────────────────────────────────
  // RUNNING → (dry-run container) → DRY_RUN_DONE → PRESENT_PROPOSAL → pause

  private async handleDryRun(
    node: DagNode,
    blueprint: Blueprint,
    fsm: NodeFSM,
    state: PipelineState,
  ): Promise<NodeOutcome> {
    const prompt: string = await this.promptBuilder.buildPrompt(
      blueprint,
      this.buildContext(node, state),
    );

    const result: ContainerResult = await this.dockerManager.spawnContainer({
      node,
      blueprint,
      prompt,
      dryRun: true,
    });

    this.applyNodeEvent(fsm, "DRY_RUN_DONE");
    this.applyNodeEvent(fsm, "PRESENT_PROPOSAL");

    return {
      nodeId: node.id,
      stateUpdates: {
        status: fsm.getStateName(),
        dry_run_output: result.stdout,
        started_at: new Date().toISOString(),
      },
      pause:
        `Review proposed changes for ${node.id}.\n` +
        `Run 'pipelineforge resume --id <pipeline-id>' after review.`,
    };
  }

  // ── Review Mode: Phase 3 — Worktree Execution ────────────────────
  // AWAITING_PROPOSAL_REVIEW → PROPOSAL_APPROVED → IMPLEMENTING →
  // (container in worktree) → IMPLEMENTATION_DONE → pause

  private async handleProposalApproved(
    node: DagNode,
    blueprint: Blueprint,
    fsm: NodeFSM,
    state: PipelineState,
  ): Promise<NodeOutcome> {
    this.applyNodeEvent(fsm, "PROPOSAL_APPROVED");

    const ticketId: string = this.extractTicketId(node);
    const worktreeInfo: WorktreeInfo = await this.worktreeManager.create(
      node.id,
      ticketId,
    );

    const prompt: string = await this.promptBuilder.buildPrompt(
      blueprint,
      this.buildContext(node, state),
    );

    const result: ContainerResult = await this.dockerManager.spawnContainer({
      node,
      blueprint,
      prompt,
      worktreePath: worktreeInfo.worktreePath,
    });

    this.applyNodeEvent(fsm, "IMPLEMENTATION_DONE");

    return {
      nodeId: node.id,
      stateUpdates: {
        status: fsm.getStateName(),
        output: result.stdout,
        exit_code: result.exitCode,
        worktree_branch: worktreeInfo.branchName,
        worktree_path: worktreeInfo.worktreePath,
      },
      pause:
        `Review implementation in worktree: ${worktreeInfo.worktreePath}\n` +
        `Branch: ${worktreeInfo.branchName}\n` +
        `Run 'pipelineforge resume --id <pipeline-id>' to approve or reject.`,
    };
  }

  // ── Review Mode: Phase 5 — Merge ─────────────────────────────────
  // AWAITING_IMPLEMENTATION_REVIEW → IMPL_APPROVED → (merge) → PASSED

  private async handleImplApproved(
    node: DagNode,
    _blueprint: Blueprint,
    fsm: NodeFSM,
    state: PipelineState,
  ): Promise<NodeOutcome> {
    const timing: ReviewTiming = state.review_timing;

    // Pre-merge reviews (placeholder — review agents are separate DAG nodes)
    if (timing === "before" || timing === "both") {
      // TODO: trigger review agent nodes against worktree branch
    }

    const mergeResult: MergeResult = await this.worktreeManager.merge(node.id);

    if (mergeResult.status === "conflict") {
      return {
        nodeId: node.id,
        stateUpdates: {
          status: fsm.getStateName(), // stays awaiting_implementation_review
        },
        pause:
          `Merge conflict in ${node.id}.\n` +
          `Conflicting files: ${mergeResult.conflictFiles.join(", ")}\n` +
          `Resolve manually, then run 'pipelineforge resume'.`,
      };
    }

    // Post-merge reviews
    if (timing === "after" || timing === "both") {
      // TODO: trigger review agent nodes against main
    }

    this.applyNodeEvent(fsm, "IMPL_APPROVED");

    return {
      nodeId: node.id,
      stateUpdates: {
        status: fsm.getStateName(),
        completed_at: new Date().toISOString(),
      },
      pause: null,
    };
  }

  // ── FSM Event Application ─────────────────────────────────────────
  // Centralized event application — all state changes go through here.

  private applyNodeEvent(fsm: NodeFSM, event: TransitionEvent): StateId {
    return fsm.transition(event);
  }

  private applyPipelineEvent(event: PipelineEvent): void {
    this.pipelineFSM!.transition(event);
  }

  private syncPipelineStatus(state: PipelineState): PipelineState {
    return { ...state, status: this.pipelineFSM!.getStateName() };
  }

  // ── Outcome Application ───────────────────────────────────────────

  private applyOutcome(
    outcome: NodeOutcome,
    state: PipelineState,
  ): PipelineState {
    let updated: PipelineState = this.stateManager.updateNode(
      state,
      outcome.nodeId,
      outcome.stateUpdates,
    );

    if (outcome.rejection !== undefined) {
      updated = this.stateManager.recordRejection(
        updated,
        outcome.nodeId,
        outcome.rejection.gateResult,
        outcome.rejection.routeTo,
      );
    }

    return updated;
  }

  // ── Ready Node Discovery ──────────────────────────────────────────
  // A node is ready when all its dependencies have passed and it is
  // not terminal, running, or paused.

  private findReadyNodes(
    graph: DagGraph,
    state: PipelineState,
  ): ReadonlyArray<string> {
    const ready: string[] = [];

    for (const nodeState of state.nodes) {
      const fsm: NodeFSM | undefined = this.nodeFSMs.get(nodeState.id);
      if (fsm === undefined || fsm.isTerminal()) {
        continue;
      }

      const fsmState: string = fsm.getStateName();

      // Paused nodes are dispatchable on resume — they have
      // dedicated handlers in dispatchNode()
      if (fsm.isPaused()) {
        ready.push(nodeState.id);
        continue;
      }

      if (fsmState === "running" || fsmState === "implementing") {
        continue;
      }

      const node: DagNode | undefined = graph.nodes.get(nodeState.id);
      if (node === undefined) {
        continue;
      }

      const allDepsPassed: boolean = node.dependencies.every(
        (depId: string): boolean => {
          const depFSM: NodeFSM | undefined = this.nodeFSMs.get(depId);
          return depFSM !== undefined && depFSM.getStateName() === "passed";
        },
      );

      if (allDepsPassed) {
        ready.push(nodeState.id);
      }
    }

    return ready;
  }

  // ── Active Node Count ─────────────────────────────────────────────

  private countActive(state: PipelineState): number {
    let count: number = 0;
    for (const nodeState of state.nodes) {
      const fsm: NodeFSM | undefined = this.nodeFSMs.get(nodeState.id);
      if (fsm === undefined) {
        continue;
      }
      const s: string = fsm.getStateName();
      if (s === "running" || s === "implementing") {
        count++;
      }
    }
    return count;
  }

  // ── Final Status Resolution ───────────────────────────────────────

  private resolveFinalStatus(state: PipelineState): PipelineState {
    const allTerminal: boolean = Array.from(this.nodeFSMs.values()).every(
      (fsm: NodeFSM): boolean => fsm.isTerminal(),
    );

    if (!allTerminal) {
      return state;
    }

    const anyFailed: boolean = Array.from(this.nodeFSMs.values()).some(
      (fsm: NodeFSM): boolean => fsm.getStateName() === "failed",
    );

    if (anyFailed) {
      this.applyPipelineEvent("NODE_FAILED");
    } else {
      this.applyPipelineEvent("ALL_PASSED");
    }

    return this.syncPipelineStatus(state);
  }

  // ── Context Building ──────────────────────────────────────────────

  private buildContext(
    node: DagNode,
    state: PipelineState,
  ): PromptContext {
    const stepOutputs: Record<string, unknown> = {};
    for (const depId of node.dependencies) {
      const depState: NodeState | undefined = state.nodes.find(
        (n: NodeState): boolean => n.id === depId,
      );
      if (depState !== undefined && depState.output !== null) {
        stepOutputs[depId] = {
          outputs: {
            output: this.extractClaudeResult(depState.output),
            exit_code: depState.exit_code,
          },
        };
      }
    }

    const total: number = state.nodes.filter(
      (n: NodeState): boolean => n.blueprint === node.blueprint,
    ).length;

    return {
      instance: node.instance,
      total,
      feature: state.feature,
      notesDir: state.notes_dir,
      repoDir: state.repo_dir,
      ticketId: this.extractTicketId(node),
      stepOutputs,
    };
  }

  private extractTicketId(node: DagNode): string {
    return `${node.blueprint}-${String(node.instance)}`;
  }

  // ── Output Sanitization ─────────────────────────────────────────────
  // Docker multiplexed streams prepend 8-byte headers (stream type +
  // payload length) to each frame. The Claude CLI JSON output lives
  // inside these frames. Strip the binary prefix and extract the
  // human-readable `result` field from the Claude JSON response.

  private extractClaudeResult(rawOutput: string): string {
    // Strip Docker multiplexed stream header bytes (non-printable prefix)
    const cleaned: string = rawOutput.replace(/^[\x00-\x08]+/, "");

    // Try to parse as Claude CLI JSON and extract the result field
    const jsonStart: number = cleaned.indexOf("{");
    if (jsonStart === -1) {
      return cleaned;
    }

    try {
      const parsed: unknown = JSON.parse(cleaned.slice(jsonStart));
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "result" in parsed
      ) {
        const result: unknown = (parsed as Record<string, unknown>)["result"];
        if (typeof result === "string") {
          return result;
        }
      }
    } catch {
      // Not valid JSON — return cleaned output as-is
    }

    return cleaned;
  }

  // ── Log Event Helper ────────────────────────────────────────────────

  private toLogEvent(node: DagNode): NodeLogEvent {
    return {
      nodeId: node.id,
      blueprint: node.blueprint,
      instance: node.instance,
    };
  }
}

// ── Node Outcome ────────────────────────────────────────────────────
// Internal type representing the result of dispatching a single node.
// Contains state updates to apply and optional pause/rejection info.

interface NodeOutcome {
  readonly nodeId: string;
  readonly stateUpdates: Partial<NodeState>;
  readonly pause: string | null;
  readonly rejection?: {
    readonly gateResult: import("../types/Gate.js").GateResult;
    readonly routeTo: string | undefined;
  };
}
