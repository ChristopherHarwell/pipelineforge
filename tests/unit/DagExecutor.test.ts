import { describe, it, expect, vi, beforeEach } from "vitest";
import { DagExecutor } from "../../src/core/DagExecutor.js";
import type { ExecutorConfig, ExecutionResult } from "../../src/core/DagExecutor.js";
import type { DagGraph, DagNode } from "../../src/types/Graph.js";
import type { Blueprint } from "../../src/types/Blueprint.js";
import type { PipelineState, NodeState, ContainerResult } from "../../src/types/Pipeline.js";
import type { GateEvaluation } from "../../src/core/GateEvaluator.js";
import type { GateResult } from "../../src/types/Gate.js";
import type { WorktreeInfo, MergeResult } from "../../src/core/WorktreeManager.js";
import type { PromptContext } from "../../src/utils/PromptBuilder.js";
import {
  createContainerResult,
  createNodeState,
  createPipelineState,
  createBlueprint,
  createStableTestId,
  deepFreeze,
} from "../utils/mock-data.js";

// ===========================================================================
// DagExecutor
// ===========================================================================

// ── Mock Dependencies ─────────────────────────────────────────────────

function createMockDockerManager(): {
  spawnContainer: ReturnType<typeof vi.fn>;
  killAll: ReturnType<typeof vi.fn>;
} {
  return {
    spawnContainer: vi.fn().mockResolvedValue(
      createContainerResult({ exitCode: 0, stdout: "output" }),
    ),
    killAll: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockGateEvaluator(): {
  evaluate: ReturnType<typeof vi.fn>;
  evaluateToEvent: ReturnType<typeof vi.fn>;
  resolveEvent: ReturnType<typeof vi.fn>;
} {
  return {
    evaluate: vi.fn(),
    evaluateToEvent: vi.fn().mockReturnValue(
      deepFreeze({
        result: {
          passed: true,
          type: "quality",
          approved: 1,
          total: 1,
          details: "1/1 quality checks — GATE PASSED",
        },
        event: "GATE_PASSED",
      } satisfies GateEvaluation),
    ),
    resolveEvent: vi.fn(),
  };
}

function createMockStateManager(): {
  save: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  updateNode: ReturnType<typeof vi.fn>;
  recordRejection: ReturnType<typeof vi.fn>;
} {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn(),
    updateNode: vi.fn().mockImplementation(
      (state: PipelineState, nodeId: string, updates: Partial<NodeState>): PipelineState => ({
        ...state,
        nodes: state.nodes.map(
          (n: NodeState): NodeState =>
            n.id === nodeId ? { ...n, ...updates } : n,
        ),
      }),
    ),
    recordRejection: vi.fn().mockImplementation(
      (state: PipelineState, nodeId: string, gateResult: GateResult): PipelineState => ({
        ...state,
        nodes: state.nodes.map(
          (n: NodeState): NodeState =>
            n.id === nodeId
              ? {
                  ...n,
                  status: "failed" as const,
                  gate_result: gateResult,
                  rejection_count: n.rejection_count + 1,
                  rejection_history: [
                    ...n.rejection_history,
                    {
                      timestamp: new Date().toISOString(),
                      feedback: gateResult.details,
                      routed_to: "none",
                    },
                  ],
                }
              : n,
        ),
      }),
    ),
  };
}

function createMockWorktreeManager(): {
  create: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  merge: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
  cleanupAll: ReturnType<typeof vi.fn>;
  readonly size: number;
} {
  return {
    create: vi.fn().mockResolvedValue(
      deepFreeze({
        branchName: "pf/test-pipeline/test-ticket",
        worktreePath: "/tmp/pf-worktrees/test-pipeline/test-ticket",
        baseBranch: "main",
      } satisfies WorktreeInfo),
    ),
    get: vi.fn(),
    merge: vi.fn().mockResolvedValue(
      deepFreeze({ status: "merged" } satisfies MergeResult),
    ),
    cleanup: vi.fn().mockResolvedValue(undefined),
    cleanupAll: vi.fn().mockResolvedValue(undefined),
    size: 0,
  };
}

function createMockPromptBuilder(): {
  buildPrompt: ReturnType<typeof vi.fn>;
} {
  return {
    buildPrompt: vi.fn().mockResolvedValue("test prompt"),
  };
}

// ── Graph Factories ───────────────────────────────────────────────────

function createDagNode(overrides: Partial<DagNode> & { readonly id: string }): DagNode {
  return deepFreeze({
    blueprint: "test",
    instance: 1,
    dependencies: [],
    dependents: [],
    ...overrides,
  });
}

function createDagGraph(nodes: ReadonlyArray<DagNode>): DagGraph {
  const nodeMap: Map<string, DagNode> = new Map();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  return deepFreeze({
    nodes: nodeMap,
    topological_order: nodes.map((n: DagNode): string => n.id),
    parallel_groups: [nodes.map((n: DagNode): string => n.id)],
  }) as DagGraph;
}

// ── Executor Factory ──────────────────────────────────────────────────

interface ExecutorScenario {
  readonly executor: DagExecutor;
  readonly dockerManager: ReturnType<typeof createMockDockerManager>;
  readonly gateEvaluator: ReturnType<typeof createMockGateEvaluator>;
  readonly stateManager: ReturnType<typeof createMockStateManager>;
  readonly worktreeManager: ReturnType<typeof createMockWorktreeManager>;
  readonly promptBuilder: ReturnType<typeof createMockPromptBuilder>;
}

function createExecutorScenario(
  configOverrides?: Partial<ExecutorConfig>,
): ExecutorScenario {
  const dockerManager = createMockDockerManager();
  const gateEvaluator = createMockGateEvaluator();
  const stateManager = createMockStateManager();
  const worktreeManager = createMockWorktreeManager();
  const promptBuilder = createMockPromptBuilder();

  const config: ExecutorConfig = deepFreeze({
    maxConcurrent: 4,
    reviewTiming: "before",
    ...configOverrides,
  });

  const executor: DagExecutor = new DagExecutor(
    dockerManager as never,
    gateEvaluator as never,
    stateManager as never,
    worktreeManager as never,
    promptBuilder as never,
    config,
  );

  return {
    executor,
    dockerManager,
    gateEvaluator,
    stateManager,
    worktreeManager,
    promptBuilder,
  };
}

// ── Reusable Test Fixtures ────────────────────────────────────────────

function createSingleNodeFixture(): {
  readonly graph: DagGraph;
  readonly state: PipelineState;
  readonly blueprint: Blueprint;
} {
  const nodeId: string = `node-${String(createStableTestId("nodeId").value)}`;
  const graph: DagGraph = createDagGraph([
    createDagNode({ id: nodeId, blueprint: "test" }),
  ]);
  const state: PipelineState = createPipelineState([
    createNodeState({ id: nodeId, blueprint: "test", status: "pending" }),
  ]);
  const blueprint: Blueprint = createBlueprint({ name: "test" });

  return { graph, state, blueprint };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("DagExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Standard execution lifecycle ──────────────────────────────────

  describe("— standard execution lifecycle", () => {
    it("should transition a single node from pending to passed via FSM events", async () => {
      const { executor, gateEvaluator, stateManager } = createExecutorScenario();
      const { graph, state } = createSingleNodeFixture();
      const nodeId: string = state.nodes[0]!.id;

      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test" })),
      };

      const executionResult: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      expect(executionResult.paused).toBe(false);
      expect(executionResult.pauseReason).toBeNull();

      // Verify gate evaluator was called
      expect(gateEvaluator.evaluateToEvent).toHaveBeenCalledOnce();

      // Verify state was saved
      expect(stateManager.save).toHaveBeenCalled();

      // Final node should be in passed status
      const finalState: PipelineState = executionResult.state;
      const finalNode: NodeState | undefined = finalState.nodes.find(
        (n: NodeState): boolean => n.id === nodeId,
      );
      expect(finalNode).toBeDefined();
      expect(finalNode!.status).toBe("passed");
    });

    it("should dispatch a container with the correct prompt", async () => {
      const { executor, dockerManager, promptBuilder } = createExecutorScenario();
      const { graph, state } = createSingleNodeFixture();

      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test" })),
      };

      await executor.execute(graph, blueprintRegistry as never, state);

      expect(promptBuilder.buildPrompt).toHaveBeenCalledOnce();
      expect(dockerManager.spawnContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "test prompt",
        }),
      );
    });

    it("should transition to failed when gate evaluation returns GATE_FAILED", async () => {
      const { executor, gateEvaluator, stateManager } = createExecutorScenario();
      const { graph, state } = createSingleNodeFixture();

      gateEvaluator.evaluateToEvent.mockReturnValue(
        deepFreeze({
          result: {
            passed: false,
            type: "quality",
            approved: 0,
            total: 1,
            details: "0/1 quality checks — GATE FAILED",
          },
          event: "GATE_FAILED",
        } satisfies GateEvaluation),
      );

      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(
          createBlueprint({ name: "test", gate: { type: "quality", rejection_routes_to: "upstream" } }),
        ),
      };

      const executionResult: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      expect(executionResult.paused).toBe(false);

      // Verify rejection was recorded
      expect(stateManager.recordRejection).toHaveBeenCalledOnce();
    });

    it("should resolve pipeline to completed when all nodes pass", async () => {
      const { executor } = createExecutorScenario();
      const nodeA: DagNode = createDagNode({ id: "a", blueprint: "test" });
      const nodeB: DagNode = createDagNode({ id: "b", blueprint: "test" });
      const graph: DagGraph = createDagGraph([nodeA, nodeB]);
      const state: PipelineState = createPipelineState([
        createNodeState({ id: "a", blueprint: "test", status: "pending" }),
        createNodeState({ id: "b", blueprint: "test", status: "pending" }),
      ]);

      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test" })),
      };

      const executionResult: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      expect(executionResult.state.status).toBe("completed");
    });

    it("should resolve pipeline to failed when any node fails", async () => {
      const { executor, gateEvaluator } = createExecutorScenario();
      const graph: DagGraph = createDagGraph([
        createDagNode({ id: "a", blueprint: "test" }),
      ]);
      const state: PipelineState = createPipelineState([
        createNodeState({ id: "a", blueprint: "test", status: "pending" }),
      ]);

      gateEvaluator.evaluateToEvent.mockReturnValue(
        deepFreeze({
          result: {
            passed: false,
            type: "quality",
            approved: 0,
            total: 1,
            details: "GATE FAILED",
          },
          event: "GATE_FAILED",
        } satisfies GateEvaluation),
      );

      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test" })),
      };

      const executionResult: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      expect(executionResult.state.status).toBe("failed");
    });
  });

  // ── Dependency ordering ───────────────────────────────────────────

  describe("— dependency ordering", () => {
    it("should not dispatch a node whose dependencies have not passed", async () => {
      const { executor, dockerManager } = createExecutorScenario();
      const graph: DagGraph = createDagGraph([
        createDagNode({ id: "a", blueprint: "test", dependents: ["b"] }),
        createDagNode({ id: "b", blueprint: "test", dependencies: ["a"] }),
      ]);
      const state: PipelineState = createPipelineState([
        createNodeState({ id: "a", blueprint: "test", status: "pending" }),
        createNodeState({ id: "b", blueprint: "test", status: "pending" }),
      ]);

      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test" })),
      };

      await executor.execute(graph, blueprintRegistry as never, state);

      // Both should eventually be dispatched, but b only after a passes
      expect(dockerManager.spawnContainer).toHaveBeenCalledTimes(2);
    });

    it("should dispatch independent nodes concurrently within the batch", async () => {
      const { executor, dockerManager } = createExecutorScenario();
      const graph: DagGraph = createDagGraph([
        createDagNode({ id: "a", blueprint: "test" }),
        createDagNode({ id: "b", blueprint: "test" }),
        createDagNode({ id: "c", blueprint: "test" }),
      ]);
      const state: PipelineState = createPipelineState([
        createNodeState({ id: "a", blueprint: "test", status: "pending" }),
        createNodeState({ id: "b", blueprint: "test", status: "pending" }),
        createNodeState({ id: "c", blueprint: "test", status: "pending" }),
      ]);

      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test" })),
      };

      await executor.execute(graph, blueprintRegistry as never, state);

      // All 3 independent nodes should be dispatched
      expect(dockerManager.spawnContainer).toHaveBeenCalledTimes(3);
    });

    it("should respect maxConcurrent limit", async () => {
      const { executor, dockerManager } = createExecutorScenario({ maxConcurrent: 1 });
      const graph: DagGraph = createDagGraph([
        createDagNode({ id: "a", blueprint: "test" }),
        createDagNode({ id: "b", blueprint: "test" }),
      ]);
      const state: PipelineState = createPipelineState([
        createNodeState({ id: "a", blueprint: "test", status: "pending" }),
        createNodeState({ id: "b", blueprint: "test", status: "pending" }),
      ]);

      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test" })),
      };

      await executor.execute(graph, blueprintRegistry as never, state);

      // Both dispatched, but sequentially (one per loop iteration)
      expect(dockerManager.spawnContainer).toHaveBeenCalledTimes(2);
    });
  });

  // ── Human gate pause ──────────────────────────────────────────────

  describe("— human gate pause", () => {
    it("should pause the pipeline when a human gate is encountered", async () => {
      const { executor, gateEvaluator, stateManager } = createExecutorScenario();
      const { graph, state } = createSingleNodeFixture();

      gateEvaluator.evaluateToEvent.mockReturnValue(
        deepFreeze({
          result: {
            passed: false,
            type: "human",
            approved: 0,
            total: 1,
            details: "Awaiting human approval",
          },
          event: "HUMAN_GATE",
        } satisfies GateEvaluation),
      );

      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test", gate: { type: "human" } })),
      };

      const executionResult: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      expect(executionResult.paused).toBe(true);
      expect(executionResult.pauseReason).toContain("Human gate");
      expect(executionResult.state.status).toBe("paused");

      // State should be saved
      expect(stateManager.save).toHaveBeenCalled();
    });
  });

  // ── Review mode: dry-run path ─────────────────────────────────────

  describe("— review mode: dry-run path", () => {
    it("should dispatch a dry-run container and pause for proposal review", async () => {
      const { executor, dockerManager, stateManager } = createExecutorScenario();
      const nodeId: string = `node-${String(createStableTestId("review-node").value)}`;
      const graph: DagGraph = createDagGraph([
        createDagNode({ id: nodeId, blueprint: "review-bp" }),
      ]);
      const state: PipelineState = createPipelineState([
        createNodeState({ id: nodeId, blueprint: "review-bp", status: "pending" }),
      ]);

      const reviewBlueprint: Blueprint = createBlueprint({
        name: "review-bp",
        review_mode: {
          enabled: true,
          dry_run_disallowed_tools: ["Edit", "Write", "NotebookEdit"],
        },
      });

      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(reviewBlueprint),
      };

      const executionResult: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      // Should pause at proposal review
      expect(executionResult.paused).toBe(true);
      expect(executionResult.pauseReason).toContain("Review proposed changes");

      // Docker should have been called with dryRun: true
      expect(dockerManager.spawnContainer).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: true }),
      );

      // Node status should be awaiting_proposal_review
      const finalNode: NodeState | undefined = executionResult.state.nodes.find(
        (n: NodeState): boolean => n.id === nodeId,
      );
      expect(finalNode!.status).toBe("awaiting_proposal_review");
    });
  });

  // ── Review mode: proposal approved → worktree execution ───────────

  describe("— review mode: proposal approved", () => {
    it("should create a worktree and dispatch implementation when proposal is approved", async () => {
      const { executor, dockerManager, worktreeManager } = createExecutorScenario();
      const nodeId: string = `node-${String(createStableTestId("proposal-node").value)}`;
      const graph: DagGraph = createDagGraph([
        createDagNode({ id: nodeId, blueprint: "review-bp" }),
      ]);

      // State resumes from awaiting_proposal_review
      const state: PipelineState = createPipelineState(
        [
          createNodeState({
            id: nodeId,
            blueprint: "review-bp",
            status: "awaiting_proposal_review",
            dry_run_output: "proposed changes",
          }),
        ],
        { status: "paused" },
      );

      const reviewBlueprint: Blueprint = createBlueprint({
        name: "review-bp",
        review_mode: {
          enabled: true,
          dry_run_disallowed_tools: ["Edit", "Write", "NotebookEdit"],
        },
      });

      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(reviewBlueprint),
      };

      const executionResult: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      // Should have created a worktree
      expect(worktreeManager.create).toHaveBeenCalledOnce();

      // Should have dispatched container with worktreePath
      expect(dockerManager.spawnContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: "/tmp/pf-worktrees/test-pipeline/test-ticket",
        }),
      );

      // Should pause again at awaiting_implementation_review
      expect(executionResult.paused).toBe(true);
      expect(executionResult.pauseReason).toContain("Review implementation in worktree");

      const finalNode: NodeState | undefined = executionResult.state.nodes.find(
        (n: NodeState): boolean => n.id === nodeId,
      );
      expect(finalNode!.status).toBe("awaiting_implementation_review");
      expect(finalNode!.worktree_branch).toBe("pf/test-pipeline/test-ticket");
    });
  });

  // ── Review mode: implementation approved → merge ──────────────────

  describe("— review mode: implementation approved", () => {
    it("should merge the worktree and pass the node on impl approval", async () => {
      const { executor, worktreeManager } = createExecutorScenario();
      const nodeId: string = `node-${String(createStableTestId("impl-node").value)}`;
      const graph: DagGraph = createDagGraph([
        createDagNode({ id: nodeId, blueprint: "review-bp" }),
      ]);

      // State resumes from awaiting_implementation_review
      const state: PipelineState = createPipelineState(
        [
          createNodeState({
            id: nodeId,
            blueprint: "review-bp",
            status: "awaiting_implementation_review",
            worktree_branch: "pf/test/TICKET-001",
            worktree_path: "/tmp/pf-worktrees/test/TICKET-001",
          }),
        ],
        { status: "paused" },
      );

      const reviewBlueprint: Blueprint = createBlueprint({
        name: "review-bp",
        review_mode: {
          enabled: true,
          dry_run_disallowed_tools: ["Edit", "Write", "NotebookEdit"],
        },
      });

      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(reviewBlueprint),
      };

      const executionResult: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      // Should have merged
      expect(worktreeManager.merge).toHaveBeenCalledWith(nodeId);

      // Should complete without pause
      expect(executionResult.paused).toBe(false);
      expect(executionResult.state.status).toBe("completed");

      const finalNode: NodeState | undefined = executionResult.state.nodes.find(
        (n: NodeState): boolean => n.id === nodeId,
      );
      expect(finalNode!.status).toBe("passed");
    });

    it("should pause with conflict info when merge fails", async () => {
      const { executor, worktreeManager } = createExecutorScenario();
      const nodeId: string = `node-${String(createStableTestId("conflict-node").value)}`;
      const graph: DagGraph = createDagGraph([
        createDagNode({ id: nodeId, blueprint: "review-bp" }),
      ]);

      const state: PipelineState = createPipelineState(
        [
          createNodeState({
            id: nodeId,
            blueprint: "review-bp",
            status: "awaiting_implementation_review",
          }),
        ],
        { status: "paused" },
      );

      worktreeManager.merge.mockResolvedValue(
        deepFreeze({
          status: "conflict",
          conflictFiles: ["src/index.ts", "src/app.ts"],
        } satisfies MergeResult),
      );

      const reviewBlueprint: Blueprint = createBlueprint({
        name: "review-bp",
        review_mode: {
          enabled: true,
          dry_run_disallowed_tools: ["Edit", "Write", "NotebookEdit"],
        },
      });

      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(reviewBlueprint),
      };

      const executionResult: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      expect(executionResult.paused).toBe(true);
      expect(executionResult.pauseReason).toContain("Merge conflict");
      expect(executionResult.pauseReason).toContain("src/index.ts");
    });
  });

  // ── Resume from paused state ──────────────────────────────────────

  describe("— resume from paused state", () => {
    it("should resume a paused pipeline and continue execution", async () => {
      const { executor } = createExecutorScenario();
      const graph: DagGraph = createDagGraph([
        createDagNode({ id: "a", blueprint: "test" }),
        createDagNode({ id: "b", blueprint: "test" }),
      ]);

      // Node a already passed, pipeline was paused, b is ready
      const state: PipelineState = createPipelineState(
        [
          createNodeState({ id: "a", blueprint: "test", status: "passed" }),
          createNodeState({ id: "b", blueprint: "test", status: "pending" }),
        ],
        { status: "paused" },
      );

      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test" })),
      };

      const executionResult: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      expect(executionResult.paused).toBe(false);
      expect(executionResult.state.status).toBe("completed");
    });
  });

  // ── Abort ─────────────────────────────────────────────────────────

  describe("— abort", () => {
    it("should kill all containers and clean up worktrees", async () => {
      const { executor, dockerManager, worktreeManager } = createExecutorScenario();
      const state: PipelineState = createPipelineState([
        createNodeState({ id: "a", blueprint: "test", status: "running" }),
        createNodeState({ id: "b", blueprint: "test", status: "pending" }),
      ]);

      const abortedState: PipelineState = await executor.abort(state);

      expect(dockerManager.killAll).toHaveBeenCalledOnce();
      expect(worktreeManager.cleanupAll).toHaveBeenCalledOnce();
      expect(abortedState.status).toBe("failed");
    });

    it("should skip non-terminal nodes on abort", async () => {
      const { executor, stateManager } = createExecutorScenario();
      const state: PipelineState = createPipelineState([
        createNodeState({ id: "a", blueprint: "test", status: "running" }),
        createNodeState({ id: "b", blueprint: "test", status: "pending" }),
        createNodeState({ id: "c", blueprint: "test", status: "passed" }),
      ]);

      const abortedState: PipelineState = await executor.abort(state);

      // Running and pending nodes should be skipped, passed node should remain
      const nodeA: NodeState | undefined = abortedState.nodes.find(
        (n: NodeState): boolean => n.id === "a",
      );
      const nodeB: NodeState | undefined = abortedState.nodes.find(
        (n: NodeState): boolean => n.id === "b",
      );
      const nodeC: NodeState | undefined = abortedState.nodes.find(
        (n: NodeState): boolean => n.id === "c",
      );

      expect(nodeA!.status).toBe("skipped");
      expect(nodeB!.status).toBe("skipped");
      expect(nodeC!.status).toBe("passed");

      // State should be saved
      expect(stateManager.save).toHaveBeenCalledOnce();
    });
  });

  // ── Context building ──────────────────────────────────────────────

  describe("— context building", () => {
    it("should pass dependency outputs to the prompt builder", async () => {
      const { executor, promptBuilder } = createExecutorScenario();
      const graph: DagGraph = createDagGraph([
        createDagNode({ id: "a", blueprint: "test", dependents: ["b"] }),
        createDagNode({ id: "b", blueprint: "consumer", dependencies: ["a"] }),
      ]);

      // Node a already passed with output
      const state: PipelineState = createPipelineState([
        createNodeState({
          id: "a",
          blueprint: "test",
          status: "passed",
          output: "upstream output",
          exit_code: 0,
        }),
        createNodeState({ id: "b", blueprint: "consumer", status: "pending" }),
      ]);

      const blueprintRegistry = {
        get: vi.fn().mockImplementation(
          (name: string): Blueprint => createBlueprint({ name }),
        ),
      };

      await executor.execute(graph, blueprintRegistry as never, state);

      // Check that when b was dispatched, the prompt builder received a's output
      const calls: ReadonlyArray<readonly [Blueprint, PromptContext]> =
        promptBuilder.buildPrompt.mock.calls as ReadonlyArray<readonly [Blueprint, PromptContext]>;

      // Find the call for node b (consumer blueprint)
      const consumerCall: readonly [Blueprint, PromptContext] | undefined = calls.find(
        (call: readonly [Blueprint, PromptContext]): boolean =>
          call[0].name === "consumer",
      );

      expect(consumerCall).toBeDefined();
      expect(consumerCall![1].stepOutputs).toHaveProperty("a");
    });
  });

  // ── State persistence ─────────────────────────────────────────────

  describe("— state persistence", () => {
    it("should save state after each batch of node completions", async () => {
      const { executor, stateManager } = createExecutorScenario();
      const graph: DagGraph = createDagGraph([
        createDagNode({ id: "a", blueprint: "test" }),
      ]);
      const state: PipelineState = createPipelineState([
        createNodeState({ id: "a", blueprint: "test", status: "pending" }),
      ]);

      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test" })),
      };

      await executor.execute(graph, blueprintRegistry as never, state);

      // At least 2 saves: after batch + after final status resolution
      expect(stateManager.save.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("should save state immediately when pipeline pauses", async () => {
      const { executor, stateManager, gateEvaluator } = createExecutorScenario();
      const { graph, state } = createSingleNodeFixture();

      gateEvaluator.evaluateToEvent.mockReturnValue(
        deepFreeze({
          result: {
            passed: false,
            type: "human",
            approved: 0,
            total: 1,
            details: "Awaiting human approval",
          },
          event: "HUMAN_GATE",
        } satisfies GateEvaluation),
      );

      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test", gate: { type: "human" } })),
      };

      await executor.execute(graph, blueprintRegistry as never, state);

      // Saved on pause
      expect(stateManager.save).toHaveBeenCalled();

      // Last save should have paused status
      const lastSaveCall: PipelineState =
        stateManager.save.mock.calls[stateManager.save.mock.calls.length - 1]![0] as PipelineState;
      expect(lastSaveCall.status).toBe("paused");
    });
  });
});
