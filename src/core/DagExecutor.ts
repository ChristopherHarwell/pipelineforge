import type { Blueprint } from "@pftypes/Blueprint.ts";
import { isJsonObject, getNestedObject } from "@utils/json-guards.ts";
import type { DagGraph, DagNode } from "@pftypes/Graph.ts";
import type {
  ContainerResult,
  NodeState,
  PipelineState,
  ReviewTiming,
} from "@pftypes/Pipeline.ts";
import type { ExecutionBackend } from "@pftypes/ExecutionBackend.ts";
import { isStreamingBackend } from "@pftypes/StreamingBackend.ts";
import type { StreamingExecutionBackend, StreamingSessionHandle, StreamCompletionEvent } from "@pftypes/StreamingBackend.ts";
import type { InputRacer } from "@core/InputRacer.ts";
import type { UserInput } from "@pftypes/InputChannel.ts";
import type { BlueprintRegistry } from "@core/BlueprintRegistry.ts";
import type { GateEvaluator, GateEvaluation } from "@core/GateEvaluator.ts";
import type { StateManager } from "@core/StateManager.ts";
import type { WorktreeManager, WorktreeInfo, MergeResult } from "@core/WorktreeManager.ts";
import type { PromptBuilder, PromptContext } from "@utils/PromptBuilder.ts";
import type { PipelineLogger, NodeLogEvent } from "@pftypes/Logger.ts";
import type { NotificationRouter, NotificationPayload } from "@core/NotificationRouter.ts";
import type { ResolvedResponse } from "@core/ResponseResolver.ts";
import { ResponseResolver } from "@core/ResponseResolver.ts";
import { QuestionDetector } from "@core/QuestionDetector.ts";
import type { QuestionDetectionResult } from "@core/QuestionDetector.ts";
import type { DiscordMessageId, NotificationType } from "@pftypes/Discord.ts";
import { NodeFSM, createNodeFSM } from "@core/NodeFSM.ts";
import type { StateId, TransitionEvent } from "@core/NodeFSM.ts";
import { PipelineFSM, createPipelineFSM } from "@core/PipelineFSM.ts";
import type { PipelineEvent } from "@core/PipelineFSM.ts";

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
  private readonly executionBackend: ExecutionBackend;
  private readonly gateEvaluator: GateEvaluator;
  private readonly stateManager: StateManager;
  private readonly worktreeManager: WorktreeManager;
  private readonly promptBuilder: PromptBuilder;
  private readonly logger: PipelineLogger;
  private readonly config: ExecutorConfig;
  private readonly notificationRouter: NotificationRouter | null;
  private readonly inputRacer: InputRacer | null;
  private readonly responseResolver: ResponseResolver;
  private readonly questionDetector: QuestionDetector;

  // ── FSM instances ─────────────────────────────────────────────────

  private readonly nodeFSMs: Map<string, NodeFSM> = new Map();
  private pipelineFSM: PipelineFSM | null = null;

  constructor(
    executionBackend: ExecutionBackend,
    gateEvaluator: GateEvaluator,
    stateManager: StateManager,
    worktreeManager: WorktreeManager,
    promptBuilder: PromptBuilder,
    logger: PipelineLogger,
    config: ExecutorConfig,
    notificationRouter: NotificationRouter | null = null,
    inputRacer: InputRacer | null = null,
  ) {
    this.executionBackend = executionBackend;
    this.gateEvaluator = gateEvaluator;
    this.stateManager = stateManager;
    this.worktreeManager = worktreeManager;
    this.promptBuilder = promptBuilder;
    this.logger = logger;
    this.config = config;
    this.notificationRouter = notificationRouter;
    this.inputRacer = inputRacer;
    this.responseResolver = new ResponseResolver();
    this.questionDetector = new QuestionDetector();
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

        // If any node caused a pause, handle via notification or CLI
        if (outcome.pause !== null) {
          if (this.notificationRouter !== null) {
            // ── Discord routing: notify, wait, resolve, continue ──
            currentState = await this.handlePauseViaNotification(
              outcome,
              currentState,
              graph,
              blueprints,
            );
          } else {
            // ── CLI-only: return paused for manual resume ──
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

    await this.executionBackend.killAll();
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
  // If the backend supports streaming, delegates to handleStreamingExecution().

  private async handleStandardExecution(
    node: DagNode,
    blueprint: Blueprint,
    fsm: NodeFSM,
    state: PipelineState,
  ): Promise<NodeOutcome> {
    // ── Streaming branch: real-time output + mid-execution Q&A ──
    if (isStreamingBackend(this.executionBackend)) {
      return this.handleStreamingExecution(node, blueprint, fsm, state);
    }

    const prompt: string = await this.promptBuilder.buildPrompt(
      blueprint,
      this.buildContext(node, state, blueprint),
    );

    const result: ContainerResult = await this.executionBackend.spawnContainer({
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

    // Gate passed — check for agent questions before completing
    const questionDetection: QuestionDetectionResult | null =
      this.checkForAgentQuestion(result, fsm);

    if (questionDetection !== null) {
      this.applyNodeEvent(fsm, "AGENT_QUESTION");

      this.logger.nodeEvent(
        "info",
        this.toLogEvent(node),
        `Agent question detected (confidence: ${String(questionDetection.confidence)})`,
      );

      return {
        nodeId: node.id,
        stateUpdates: {
          status: fsm.getStateName(),
          output: result.stdout,
          exit_code: result.exitCode,
          gate_result: evaluation.result,
          started_at: new Date().toISOString(),
        },
        pause: `Agent ${node.id} has a question:\n${questionDetection.questions.join("\n")}`,
      };
    }

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

  // ── Streaming Execution Path ─────────────────────────────────────
  // RUNNING → (streaming session) → live output + question detection
  // → AGENT_QUESTION → ANSWER_RECEIVED → continue → gate evaluation

  private async handleStreamingExecution(
    node: DagNode,
    blueprint: Blueprint,
    fsm: NodeFSM,
    state: PipelineState,
  ): Promise<NodeOutcome> {
    const backend: StreamingExecutionBackend =
      this.executionBackend as StreamingExecutionBackend;

    const prompt: string = await this.promptBuilder.buildPrompt(
      blueprint,
      this.buildContext(node, state, blueprint),
    );

    const handle: StreamingSessionHandle = await backend.spawnStreamingSession({
      node,
      blueprint,
      prompt,
    });

    // ── Stream output to console ────────────────────────────────
    this.logger.streamContainerOutput(node.id, handle.outputStream);

    // Ensure the stream is in flowing mode so the PassThrough drains
    // and the "end" event fires. Without this, waitForCompletion()
    // hangs if the logger doesn't attach a "data" listener (e.g.
    // NoopLogger in tests). resume() puts the stream into flowing
    // mode, discarding data not consumed by a listener.
    handle.outputStream.resume();

    // ── Wait for session to complete ────────────────────────────
    // OpenClaw `--json` returns a single JSON blob when done — the
    // output stream carries raw JSON, not plain text. Mid-stream
    // question detection was removed because:
    //   1. Questions are inside JSON string values (invisible to
    //      line-by-line regex matching)
    //   2. The async rl.on("line") handler races with waitForCompletion(),
    //      causing FSM state conflicts (AGENT_QUESTION fires but
    //      ANSWER_RECEIVED never completes before gate evaluation)
    // Instead, we prompt the user post-completion with the extracted text.
    let completion: StreamCompletionEvent = await handle.waitForCompletion();

    // ── Post-completion: show agent response and prompt user ────
    // Instead of trying to detect questions via pattern matching
    // (fragile — misses parenthetical clarifications, implicit
    // questions, etc.), always show the agent's extracted text and
    // let the user decide whether to respond. Empty response = accept.
    let extractedText: string = this.extractAgentText(completion.fullOutput);
    let interactionLoop: number = 0;
    const MAX_INTERACTION_LOOPS: number = 5;

    while (this.inputRacer !== null && interactionLoop < MAX_INTERACTION_LOOPS) {
      // Show the agent's response text to the user
      this.logger.nodeEvent(
        "info",
        this.toLogEvent(node),
        `Agent response:\n${extractedText}`,
      );

      this.applyNodeEvent(fsm, "AGENT_QUESTION");

      // Prompt user — empty response means "accept and continue"
      const postInput: UserInput = await this.inputRacer.race(extractedText);

      if (postInput.content.length === 0) {
        this.applyNodeEvent(fsm, "ANSWER_RECEIVED");
        break;
      }

      this.applyNodeEvent(fsm, "ANSWER_RECEIVED");

      this.logger.nodeEvent(
        "info",
        this.toLogEvent(node),
        `Reply from ${postInput.source}: "${postInput.content.slice(0, 80)}"`,
      );

      if (postInput.source === "cli" && this.notificationRouter !== null) {
        await this.notificationRouter.sendUpdate(
          `Reply via CLI for ${node.id}: "${postInput.content.slice(0, 200)}"`,
        );
      }

      // Send follow-up and capture the new response
      const followUpOutput: string = await handle.sendMessage(postInput.content);
      extractedText = this.extractAgentText(followUpOutput);
      completion = { ...completion, fullOutput: followUpOutput };

      interactionLoop++;
    }

    const result: ContainerResult = {
      stdout: completion.fullOutput,
      stderr: "",
      exitCode: completion.exitCode,
      durationMs: completion.durationMs,
    };

    // ── Gate evaluation (same as standard path) ─────────────────
    const evaluation: GateEvaluation = this.gateEvaluator.evaluateToEvent(
      blueprint.gate,
      result,
      state,
      node.id,
    );

    this.applyNodeEvent(fsm, evaluation.event);

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
      this.buildContext(node, state, blueprint),
    );

    const result: ContainerResult = await this.executionBackend.spawnContainer({
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
      this.buildContext(node, state, blueprint),
    );

    const result: ContainerResult = await this.executionBackend.spawnContainer({
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

  // ── Notification-Based Pause Handling ────────────────────────────────
  // When a NotificationRouter is available, pause events are routed to
  // Discord instead of returning to the CLI. The executor waits for
  // a Discord response, resolves it to an FSM event, and continues.

  private async handlePauseViaNotification(
    outcome: NodeOutcome,
    state: PipelineState,
    _graph: DagGraph,
    _blueprints: BlueprintRegistry,
  ): Promise<PipelineState> {
    const router: NotificationRouter = this.notificationRouter!;
    const nodeState: NodeState | undefined = state.nodes.find(
      (n: NodeState): boolean => n.id === outcome.nodeId,
    );
    const currentNodeStatus: string = nodeState?.status ?? "running";

    // Determine notification type from the FSM state
    const notificationType: NotificationType = this.inferNotificationType(currentNodeStatus);

    const payload: NotificationPayload = {
      type: notificationType,
      pipelineId: state.id,
      nodeId: outcome.nodeId,
      nodeStatus: nodeState?.status ?? "running",
      output: nodeState?.output ?? null,
      gateDetails: nodeState?.gate_result?.details ?? null,
    };

    const messageId: DiscordMessageId = await router.notify(payload);

    // Wait for Discord response
    const discordResponse = await router.waitForResponse(
      messageId,
      this.config.maxConcurrent * 60_000, // timeout proportional to concurrency
    );

    // Resolve the response to an FSM event
    const resolved: ResolvedResponse = this.responseResolver.resolve(
      discordResponse,
      nodeState?.status ?? "running",
    );

    // Apply the resolved FSM event
    const fsm: NodeFSM = this.nodeFSMs.get(outcome.nodeId)!;
    this.applyNodeEvent(fsm, resolved.fsmEvent);

    // Update node state with the new status
    const updatedState: PipelineState = this.stateManager.updateNode(
      state,
      outcome.nodeId,
      { status: fsm.getStateName() },
    );

    this.logger.pipelineEvent(
      "info",
      `Discord response for ${outcome.nodeId}: ${resolved.action} → ${fsm.getStateName()}`,
    );

    await this.stateManager.save(updatedState);
    return updatedState;
  }

  private inferNotificationType(nodeStatus: string): NotificationType {
    switch (nodeStatus) {
      case "awaiting_answer":
        return "agent_question";
      case "awaiting_human":
        return "human_gate";
      case "awaiting_proposal_review":
        return "proposal_review";
      case "awaiting_implementation_review":
        return "implementation_review";
      default:
        return "pipeline_update";
    }
  }

  // ── Agent Question Detection ──────────────────────────────────────
  // After standard execution, check if the agent output contains
  // questions. If detected and a NotificationRouter is available,
  // transition to AWAITING_ANSWER instead of completing.

  private checkForAgentQuestion(
    result: ContainerResult,
    fsm: NodeFSM,
  ): QuestionDetectionResult | null {
    if (this.notificationRouter === null) {
      return null;
    }

    const textToCheck: string = this.extractAgentText(result.stdout);
    const detection: QuestionDetectionResult = this.questionDetector.detect(
      textToCheck,
    );

    if (detection.detected && fsm.canTransition("AGENT_QUESTION")) {
      return detection;
    }

    return null;
  }

  // ── JSON Line Text Extraction ────────────────────────────────────
  // During streaming, each line from the subprocess is raw JSON.
  // Lines like `"text": "Which repo?\nWhich branch?"` contain agent
  // text inside a JSON string value. This helper extracts and
  // unescapes the value so the rolling-window question detector can
  // see real text instead of JSON syntax.

  /**
   * Extract text from a JSON `"text": "..."` line.
   * Returns the unescaped string value, or the original line if
   * it doesn't match the pattern.
   *
   * @param line - A raw output line from the streaming subprocess
   * @returns Extracted text or the original line
   */
  static extractJsonTextField(line: string): string {
    // Match JSON key "text" with a string value — handles the common
    // OpenClaw output format: `"text": "agent says...",`
    const match: RegExpMatchArray | null = line.match(
      /^\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/,
    );

    if (match?.[1] === undefined) {
      return line;
    }

    // JSON.parse to unescape \n, \", \uXXXX etc.
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return line;
    }
  }

  // ── Agent Text Extraction ────────────────────────────────────────
  // OpenClaw's `--json` output wraps agent text in a JSON blob at
  // result.payloads[].text. Extract human-readable text so the
  // question detector can match patterns like "What do you want?".
  // Falls back to raw output if JSON parsing fails.

  private extractAgentText(jsonOutput: string): string {
    try {
      const parsed: unknown = JSON.parse(jsonOutput.trim());

      if (isJsonObject(parsed) && Object.hasOwn(parsed, "result")) {
        const resultObj: Record<string, unknown> | undefined = getNestedObject(parsed, "result");

        if (resultObj !== undefined && Object.hasOwn(resultObj, "payloads")) {
          const payloads: unknown = resultObj["payloads"];

          if (Array.isArray(payloads)) {
            const extracted: string = payloads
              .filter(
                (p: unknown): boolean =>
                  isJsonObject(p) &&
                  typeof p["text"] === "string",
              )
              .map((p: unknown): string => (p as Record<string, unknown>)["text"] as string)
              .join("\n");

            // Only return extracted text if we actually found some
            if (extracted.length > 0) {
              return extracted;
            }
          }
        }
      }
    } catch {
      // Not JSON or unexpected structure — return raw
    }
    return jsonOutput;
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
    blueprint: Blueprint,
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
      repoDir: blueprint.requires_repo ? state.repo_dir : null,
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
      if (isJsonObject(parsed) && "result" in parsed) {
        const result: unknown = parsed["result"];
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
    readonly gateResult: import("@pftypes/Gate.ts").GateResult;
    readonly routeTo: string | undefined;
  };
}
