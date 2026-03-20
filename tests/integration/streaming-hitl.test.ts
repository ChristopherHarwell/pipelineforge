import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough } from "node:stream";
import { DagExecutor } from "@core/DagExecutor.ts";
import type { ExecutorConfig, ExecutionResult } from "@core/DagExecutor.ts";
import type { DagGraph, DagNode } from "@pftypes/Graph.ts";
import type { Blueprint } from "@pftypes/Blueprint.ts";
import type { PipelineState, NodeState, ContainerResult } from "@pftypes/Pipeline.ts";
import type { GateEvaluation } from "@core/GateEvaluator.ts";
import type { GateResult } from "@pftypes/Gate.ts";
import type { WorktreeInfo, MergeResult } from "@core/WorktreeManager.ts";
import type { PipelineLogger } from "@pftypes/Logger.ts";
import type { SpawnOptions } from "@pftypes/ExecutionBackend.ts";
import type {
  StreamingExecutionBackend,
  StreamingSessionHandle,
  StreamCompletionEvent,
} from "@pftypes/StreamingBackend.ts";
import { isStreamingBackend } from "@pftypes/StreamingBackend.ts";
import type { SessionId } from "@pftypes/ProxySession.ts";
import { toSessionId } from "@pftypes/ProxySession.ts";
import type { InputChannel, UserInput } from "@pftypes/InputChannel.ts";
import { InputRacer } from "@core/InputRacer.ts";
import { CliInputChannel } from "@core/CliInputChannel.ts";
import { DiscordInputChannel } from "@core/DiscordInputChannel.ts";
import { QuestionDetector } from "@core/QuestionDetector.ts";
import type { QuestionDetectionResult } from "@core/QuestionDetector.ts";
import { NoopLogger } from "@utils/NoopLogger.ts";
import {
  createContainerResult,
  createNodeState,
  createPipelineState,
  createBlueprint,
  createStableTestId,
  deepFreeze,
} from "../utils/mock-data.js";

// ===========================================================================
// Streaming Human-in-the-Loop — End-to-End Integration Tests
// ===========================================================================

// ── Mock Factories ─────────────────────────────────────────────────────

/**
 * Create a mock StreamingExecutionBackend that emits lines asynchronously,
 * records sent messages, and completes after all lines are emitted.
 */
function createMockStreamingBackend(
  lines: ReadonlyArray<string>,
  exitCode: number = 0,
  lineDelayMs: number = 5,
): {
  readonly backend: StreamingExecutionBackend;
  readonly sentMessages: string[];
  readonly spawnedSessions: string[];
} {
  const sentMessages: string[] = [];
  const spawnedSessions: string[] = [];
  let sessionCounter: number = 0;

  const backend: StreamingExecutionBackend = {
    supportsStreaming: true as const,
    spawnContainer: vi.fn().mockResolvedValue(
      createContainerResult({ exitCode, stdout: lines.join("\n") }),
    ),
    killAll: vi.fn().mockResolvedValue(undefined),
    spawnStreamingSession: vi.fn().mockImplementation(
      async (opts: SpawnOptions): Promise<StreamingSessionHandle> => {
        sessionCounter++;
        const sessionId: SessionId = toSessionId(`mock-session-${String(sessionCounter)}`);
        spawnedSessions.push(opts.node.id);

        const stream: PassThrough = new PassThrough();
        const fullOutput: string = lines.join("\n");
        const startTime: number = Date.now();

        // Emit lines asynchronously with small delays to simulate streaming
        setTimeout(async (): Promise<void> => {
          for (let i: number = 0; i < lines.length; i++) {
            stream.write(lines[i] + "\n");
            if (lineDelayMs > 0 && i < lines.length - 1) {
              await new Promise<void>((r: () => void): void => {
                setTimeout(r, lineDelayMs);
              });
            }
          }
          stream.end();
        }, 1);

        // Build a completion promise eagerly so late callers don't miss "end"
        const completionPromise: Promise<StreamCompletionEvent> =
          new Promise<StreamCompletionEvent>((resolve): void => {
            stream.on("end", (): void => {
              resolve({
                type: "completion",
                exitCode,
                fullOutput,
                durationMs: Date.now() - startTime,
              });
            });
          });

        return {
          sessionId,
          outputStream: stream,
          sendMessage: vi.fn().mockImplementation(
            async (msg: string): Promise<string> => {
              sentMessages.push(msg);
              return "";
            },
          ),
          waitForCompletion: (): Promise<StreamCompletionEvent> => completionPromise,
          kill: vi.fn().mockResolvedValue(undefined),
          [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
        };
      },
    ),
    sendSessionMessage: vi.fn().mockImplementation(
      async (_sid: SessionId, msg: string): Promise<string> => {
        sentMessages.push(msg);
        return "";
      },
    ),
  };

  return { backend, sentMessages, spawnedSessions };
}

function createMockGateEvaluator(
  defaultEvent: "GATE_PASSED" | "GATE_FAILED" | "HUMAN_GATE" = "GATE_PASSED",
): ReturnType<typeof vi.fn> & {
  evaluate: ReturnType<typeof vi.fn>;
  evaluateToEvent: ReturnType<typeof vi.fn>;
  resolveEvent: ReturnType<typeof vi.fn>;
} {
  const passed: boolean = defaultEvent === "GATE_PASSED";
  const type: string = defaultEvent === "HUMAN_GATE" ? "human" : "quality";

  return {
    evaluate: vi.fn(),
    evaluateToEvent: vi.fn().mockReturnValue(
      deepFreeze({
        result: {
          passed,
          type,
          approved: passed ? 1 : 0,
          total: 1,
          details: passed
            ? "1/1 quality checks — GATE PASSED"
            : defaultEvent === "HUMAN_GATE"
              ? "Awaiting human approval"
              : "0/1 quality checks — GATE FAILED",
        },
        event: defaultEvent,
      } satisfies GateEvaluation),
    ),
    resolveEvent: vi.fn(),
  } as never;
}

function createMockStateManager(): {
  save: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  updateNode: ReturnType<typeof vi.fn>;
  recordRejection: ReturnType<typeof vi.fn>;
  resetFailedNodes: ReturnType<typeof vi.fn>;
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
    resetFailedNodes: vi.fn(),
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
        branchName: "pf/test/ticket",
        worktreePath: "/tmp/pf-worktrees/test/ticket",
        baseBranch: "main",
      }),
    ),
    get: vi.fn(),
    merge: vi.fn().mockResolvedValue(deepFreeze({ status: "merged" })),
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

/** Create a mock InputChannel that returns a fixed answer. */
function createMockInputChannel(
  source: "cli" | "discord",
  answer: string,
  delayMs: number = 0,
): InputChannel & { readonly promptCalls: string[] } {
  const promptCalls: string[] = [];
  return {
    source,
    promptCalls,
    prompt: vi.fn().mockImplementation(
      async (question: string): Promise<UserInput> => {
        promptCalls.push(question);
        if (delayMs > 0) {
          await new Promise<void>((r: () => void): void => {
            setTimeout(r, delayMs);
          });
        }
        return { source, content: answer, receivedAt: Date.now() };
      },
    ),
    close: vi.fn(),
  };
}

/** Create a mock InputChannel that always fails. */
function createFailingInputChannel(source: "cli" | "discord"): InputChannel {
  return {
    source,
    prompt: vi.fn().mockRejectedValue(new Error(`${source} channel failed`)),
    close: vi.fn(),
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

interface StreamingExecutorScenario {
  readonly executor: DagExecutor;
  readonly backend: StreamingExecutionBackend;
  readonly sentMessages: string[];
  readonly spawnedSessions: string[];
  readonly gateEvaluator: ReturnType<typeof createMockGateEvaluator>;
  readonly stateManager: ReturnType<typeof createMockStateManager>;
  readonly promptBuilder: ReturnType<typeof createMockPromptBuilder>;
  readonly inputRacer: InputRacer | null;
}

function createStreamingExecutorScenario(opts: {
  readonly lines: ReadonlyArray<string>;
  readonly exitCode?: number;
  readonly lineDelayMs?: number;
  readonly gateEvent?: "GATE_PASSED" | "GATE_FAILED" | "HUMAN_GATE";
  readonly inputChannels?: ReadonlyArray<InputChannel>;
  readonly notificationRouter?: unknown;
}): StreamingExecutorScenario {
  const { backend, sentMessages, spawnedSessions } = createMockStreamingBackend(
    opts.lines,
    opts.exitCode ?? 0,
    opts.lineDelayMs ?? 5,
  );
  const gateEvaluator = createMockGateEvaluator(opts.gateEvent ?? "GATE_PASSED");
  const stateManager = createMockStateManager();
  const worktreeManager = createMockWorktreeManager();
  const promptBuilder = createMockPromptBuilder();
  const logger: PipelineLogger = new NoopLogger();

  const config: ExecutorConfig = deepFreeze({
    maxConcurrent: 4,
    reviewTiming: "before" as const,
  });

  const inputRacer: InputRacer | null =
    opts.inputChannels !== undefined && opts.inputChannels.length > 0
      ? new InputRacer(opts.inputChannels)
      : null;

  const executor: DagExecutor = new DagExecutor(
    backend as never,
    gateEvaluator as never,
    stateManager as never,
    worktreeManager as never,
    promptBuilder as never,
    logger,
    config,
    (opts.notificationRouter ?? null) as never,
    inputRacer,
  );

  return {
    executor,
    backend,
    sentMessages,
    spawnedSessions,
    gateEvaluator,
    stateManager,
    promptBuilder,
    inputRacer,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Streaming Human-in-the-Loop — E2E", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Type guard ─────────────────────────────────────────────────────

  describe("— isStreamingBackend type guard", () => {
    it("should return false for a batch-only backend", () => {
      const batch = {
        spawnContainer: vi.fn(),
        killAll: vi.fn(),
      };
      expect(isStreamingBackend(batch)).toBe(false);
    });

    it("should return true for a streaming backend", () => {
      const { backend } = createMockStreamingBackend(["line"]);
      expect(isStreamingBackend(backend)).toBe(true);
    });

    it("should return false when supportsStreaming is absent", () => {
      const almostStreaming = {
        spawnContainer: vi.fn(),
        killAll: vi.fn(),
        spawnStreamingSession: vi.fn(),
        sendSessionMessage: vi.fn(),
      };
      expect(isStreamingBackend(almostStreaming)).toBe(false);
    });

    it("should return false when supportsStreaming is false", () => {
      const notStreaming = {
        spawnContainer: vi.fn(),
        killAll: vi.fn(),
        supportsStreaming: false,
        spawnStreamingSession: vi.fn(),
        sendSessionMessage: vi.fn(),
      };
      expect(isStreamingBackend(notStreaming as never)).toBe(false);
    });
  });

  // ── InputRacer ─────────────────────────────────────────────────────

  describe("— InputRacer", () => {
    it("should throw when constructed with zero channels", () => {
      expect(() => new InputRacer([])).toThrow("at least one");
    });

    it("should return the first response from a single channel", async () => {
      const channel = createMockInputChannel("cli", "hello");
      const racer: InputRacer = new InputRacer([channel]);

      const result: UserInput = await racer.race("question?");

      expect(result.source).toBe("cli");
      expect(result.content).toBe("hello");
      expect(channel.promptCalls).toEqual(["question?"]);
      racer.close();
    });

    it("should return the faster channel when racing two channels", async () => {
      const fast = createMockInputChannel("cli", "fast answer", 0);
      const slow = createMockInputChannel("discord", "slow answer", 500);
      const racer: InputRacer = new InputRacer([slow, fast]);

      const result: UserInput = await racer.race("race test?");

      expect(result.content).toBe("fast answer");
      expect(result.source).toBe("cli");
      racer.close();
    });

    it("should ignore a failing channel and return the succeeding one", async () => {
      const failing = createFailingInputChannel("discord");
      const succeeding = createMockInputChannel("cli", "backup answer");
      const racer: InputRacer = new InputRacer([failing, succeeding]);

      const result: UserInput = await racer.race("test?");

      expect(result.content).toBe("backup answer");
      expect(result.source).toBe("cli");
      racer.close();
    });

    it("should call close on all channels when closed", () => {
      const a = createMockInputChannel("cli", "a");
      const b = createMockInputChannel("discord", "b");
      const racer: InputRacer = new InputRacer([a, b]);

      racer.close();

      expect(a.close).toHaveBeenCalledOnce();
      expect(b.close).toHaveBeenCalledOnce();
    });
  });

  // ── CliInputChannel ───────────────────────────────────────────────

  describe("— CliInputChannel", () => {
    it("should have source 'cli'", () => {
      const channel: CliInputChannel = new CliInputChannel();
      expect(channel.source).toBe("cli");
      channel.close();
    });

    it("should be closeable even when never prompted", () => {
      const channel: CliInputChannel = new CliInputChannel();
      expect(() => channel.close()).not.toThrow();
    });

    it("should be closeable multiple times without error", () => {
      const channel: CliInputChannel = new CliInputChannel();
      channel.close();
      expect(() => channel.close()).not.toThrow();
    });
  });

  // ── QuestionDetector on streaming rolling window ──────────────────

  describe("— QuestionDetector streaming integration", () => {
    it("should not detect questions in normal output", () => {
      const detector: QuestionDetector = new QuestionDetector();
      const output: string = [
        "Starting implementation...",
        "Reading configuration files.",
        "Writing output to disk.",
        "Task completed successfully.",
      ].join("\n");

      const result: QuestionDetectionResult = detector.detect(output);
      expect(result.detected).toBe(false);
      expect(result.questions).toHaveLength(0);
    });

    it("should detect a single question with high confidence", () => {
      const detector: QuestionDetector = new QuestionDetector();
      const output: string = [
        "I found the configuration.",
        "Which database driver should I use for this project?",
      ].join("\n");

      const result: QuestionDetectionResult = detector.detect(output);
      expect(result.detected).toBe(true);
      expect(result.questions.length).toBeGreaterThanOrEqual(1);
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("should detect multiple questions with bonus confidence", () => {
      const detector: QuestionDetector = new QuestionDetector();
      const output: string = [
        "I have two questions before proceeding:",
        "1. Should I use PostgreSQL or MySQL?",
        "2. What port should the service listen on?",
      ].join("\n");

      const result: QuestionDetectionResult = detector.detect(output);
      expect(result.detected).toBe(true);
      expect(result.questions.length).toBeGreaterThanOrEqual(2);
    });

    it("should work on a rolling window of 20 lines", () => {
      const detector: QuestionDetector = new QuestionDetector();
      const window: string[] = [];

      // Fill with 18 lines of non-question output
      for (let i: number = 0; i < 18; i++) {
        window.push(`Processing step ${String(i)}...`);
      }
      // Add 2 question lines at the end
      window.push("Which approach should I take?");
      window.push("Should I refactor first?");

      const result: QuestionDetectionResult = detector.detect(window.join("\n"));
      expect(result.detected).toBe(true);
    });
  });

  // ── DagExecutor streaming execution path ──────────────────────────

  describe("— DagExecutor streaming execution (no questions)", () => {
    it("should use spawnStreamingSession when backend supports streaming", async () => {
      const nodeId: string = `node-${String(createStableTestId("stream-basic").value)}`;
      const { executor, backend, spawnedSessions } = createStreamingExecutorScenario({
        lines: [
          "Starting work...",
          "Processing...",
          "Done.",
        ],
      });

      const graph: DagGraph = createDagGraph([
        createDagNode({ id: nodeId, blueprint: "test" }),
      ]);
      const state: PipelineState = createPipelineState([
        createNodeState({ id: nodeId, blueprint: "test", status: "pending" }),
      ]);
      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test" })),
      };

      const result: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      // Should have spawned a streaming session, NOT a batch container
      expect(backend.spawnStreamingSession).toHaveBeenCalledOnce();
      expect(backend.spawnContainer).not.toHaveBeenCalled();
      expect(spawnedSessions).toContain(nodeId);

      // Pipeline should complete successfully
      expect(result.paused).toBe(false);
      expect(result.state.status).toBe("completed");

      // Node should be passed
      const finalNode: NodeState | undefined = result.state.nodes.find(
        (n: NodeState): boolean => n.id === nodeId,
      );
      expect(finalNode).toBeDefined();
      expect(finalNode!.status).toBe("passed");
      expect(finalNode!.output).toContain("Done.");
    });

    it("should handle gate failure in streaming mode", async () => {
      const nodeId: string = `node-${String(createStableTestId("stream-fail").value)}`;
      const { executor, stateManager } = createStreamingExecutorScenario({
        lines: ["Some output", "But not good enough"],
        gateEvent: "GATE_FAILED",
      });

      const graph: DagGraph = createDagGraph([
        createDagNode({ id: nodeId, blueprint: "test" }),
      ]);
      const state: PipelineState = createPipelineState([
        createNodeState({ id: nodeId, blueprint: "test", status: "pending" }),
      ]);
      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(
          createBlueprint({ name: "test", gate: { type: "quality", rejection_routes_to: "upstream" } }),
        ),
      };

      const result: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      expect(result.state.status).toBe("failed");
      expect(stateManager.recordRejection).toHaveBeenCalledOnce();
    });

    it("should handle human gate in streaming mode", async () => {
      const nodeId: string = `node-${String(createStableTestId("stream-human").value)}`;
      const { executor } = createStreamingExecutorScenario({
        lines: ["Agent output here"],
        gateEvent: "HUMAN_GATE",
      });

      const graph: DagGraph = createDagGraph([
        createDagNode({ id: nodeId, blueprint: "test" }),
      ]);
      const state: PipelineState = createPipelineState([
        createNodeState({ id: nodeId, blueprint: "test", status: "pending" }),
      ]);
      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test", gate: { type: "human" } })),
      };

      const result: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      expect(result.paused).toBe(true);
      expect(result.pauseReason).toContain("Human gate");
      expect(result.state.status).toBe("paused");
    });

    it("should dispatch multiple streaming nodes concurrently", async () => {
      const { executor, backend, spawnedSessions } = createStreamingExecutorScenario({
        lines: ["output"],
      });

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

      const result: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      expect(backend.spawnStreamingSession).toHaveBeenCalledTimes(3);
      expect(spawnedSessions).toEqual(expect.arrayContaining(["a", "b", "c"]));
      expect(result.state.status).toBe("completed");
    });

    it("should respect dependency ordering in streaming mode", async () => {
      const { executor, backend, spawnedSessions } = createStreamingExecutorScenario({
        lines: ["output"],
      });

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

      const result: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      // Both should be dispatched
      expect(backend.spawnStreamingSession).toHaveBeenCalledTimes(2);
      expect(result.state.status).toBe("completed");
    });
  });

  // ── Full HITL flow: question → race → answer injection ────────────

  describe("— full HITL: question detection → InputRacer → answer injection", () => {
    it("should detect a question mid-stream and inject the CLI answer", async () => {
      const nodeId: string = `node-${String(createStableTestId("hitl-cli").value)}`;
      const cliChannel = createMockInputChannel("cli", "Use PostgreSQL");

      const { executor, sentMessages } = createStreamingExecutorScenario({
        lines: [
          "Analyzing the project...",
          "Found database config.",
          "Which database driver should I use?",
          "Should I use PostgreSQL or MySQL?",
          "Waiting for response...",
        ],
        lineDelayMs: 10,
        inputChannels: [cliChannel],
      });

      const graph: DagGraph = createDagGraph([
        createDagNode({ id: nodeId, blueprint: "test" }),
      ]);
      const state: PipelineState = createPipelineState([
        createNodeState({ id: nodeId, blueprint: "test", status: "pending" }),
      ]);
      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test" })),
      };

      const result: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      // Pipeline should complete (gate passes after stream ends)
      expect(result.state.status).toBe("completed");

      // The CLI channel should have been prompted
      expect(cliChannel.promptCalls.length).toBeGreaterThanOrEqual(1);

      // The answer should have been sent to the session
      expect(sentMessages).toContain("Use PostgreSQL");
    });

    it("should detect a question and use the Discord channel when CLI fails", async () => {
      const nodeId: string = `node-${String(createStableTestId("hitl-discord").value)}`;
      const failingCli = createFailingInputChannel("cli");
      const discordChannel = createMockInputChannel("discord", "Use MySQL", 0);

      const { executor, sentMessages } = createStreamingExecutorScenario({
        lines: [
          "Starting...",
          "Which framework should I use?",
          "Should I pick Express or Fastify?",
        ],
        lineDelayMs: 10,
        inputChannels: [failingCli, discordChannel],
      });

      const graph: DagGraph = createDagGraph([
        createDagNode({ id: nodeId, blueprint: "test" }),
      ]);
      const state: PipelineState = createPipelineState([
        createNodeState({ id: nodeId, blueprint: "test", status: "pending" }),
      ]);
      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test" })),
      };

      const result: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      expect(result.state.status).toBe("completed");

      // Discord's answer should have been injected
      expect(sentMessages).toContain("Use MySQL");
    });

    it("should not prompt when no InputRacer is configured", async () => {
      const nodeId: string = `node-${String(createStableTestId("no-racer").value)}`;

      // No inputChannels = no InputRacer
      const { executor, sentMessages } = createStreamingExecutorScenario({
        lines: [
          "Working...",
          "Which option should I pick?",
          "Done.",
        ],
        lineDelayMs: 10,
      });

      const graph: DagGraph = createDagGraph([
        createDagNode({ id: nodeId, blueprint: "test" }),
      ]);
      const state: PipelineState = createPipelineState([
        createNodeState({ id: nodeId, blueprint: "test", status: "pending" }),
      ]);
      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test" })),
      };

      const result: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      // Should complete without sending any messages
      expect(result.state.status).toBe("completed");
      expect(sentMessages).toHaveLength(0);
    });

    it("should not re-prompt for the same question twice", async () => {
      const nodeId: string = `node-${String(createStableTestId("no-dupe").value)}`;

      // First prompt during streaming gets "answer"; post-completion
      // prompt gets "" (accept) to break the interaction loop.
      let callCount: number = 0;
      const promptCalls: string[] = [];
      const cliChannel: InputChannel & { readonly promptCalls: string[] } = {
        source: "cli" as const,
        promptCalls,
        prompt: vi.fn().mockImplementation(
          async (question: string): Promise<UserInput> => {
            promptCalls.push(question);
            callCount++;
            // First call: answer the streaming question
            // Subsequent calls: accept (empty) to break post-completion loop
            const content: string = callCount <= 1 ? "answer" : "";
            return { source: "cli" as const, content, receivedAt: Date.now() };
          },
        ),
        close: vi.fn(),
      };

      const { executor, sentMessages } = createStreamingExecutorScenario({
        lines: [
          "Which database should I use?",
          "Working...",
          // Same question repeated (e.g., agent re-asks)
          "Which database should I use?",
          "Done.",
        ],
        lineDelayMs: 10,
        inputChannels: [cliChannel],
      });

      const graph: DagGraph = createDagGraph([
        createDagNode({ id: nodeId, blueprint: "test" }),
      ]);
      const state: PipelineState = createPipelineState([
        createNodeState({ id: nodeId, blueprint: "test", status: "pending" }),
      ]);
      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test" })),
      };

      await executor.execute(graph, blueprintRegistry as never, state);

      // Answer should only be sent once during streaming (the dupe is
      // filtered by answeredQuestions). Post-completion prompt gets ""
      // which is not sent as a follow-up.
      const postgresAnswers: number = sentMessages.filter(
        (m: string): boolean => m === "answer",
      ).length;
      expect(postgresAnswers).toBeLessThanOrEqual(1);
    });

    it("should notify Discord when CLI answers and router exists", async () => {
      const nodeId: string = `node-${String(createStableTestId("cross-notify").value)}`;
      const cliChannel = createMockInputChannel("cli", "my answer");

      const mockRouter = {
        notify: vi.fn().mockResolvedValue("msg-123"),
        waitForResponse: vi.fn(),
        sendUpdate: vi.fn().mockResolvedValue(undefined),
        ensureThread: vi.fn(),
        getThreadId: vi.fn().mockReturnValue("thread-123"),
      };

      const { executor } = createStreamingExecutorScenario({
        lines: [
          "What should I do next?",
          "Should I proceed with the implementation?",
        ],
        lineDelayMs: 10,
        inputChannels: [cliChannel],
        notificationRouter: mockRouter,
      });

      const graph: DagGraph = createDagGraph([
        createDagNode({ id: nodeId, blueprint: "test" }),
      ]);
      const state: PipelineState = createPipelineState([
        createNodeState({ id: nodeId, blueprint: "test", status: "pending" }),
      ]);
      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test" })),
      };

      await executor.execute(graph, blueprintRegistry as never, state);

      // NotificationRouter.sendUpdate should have been called to notify Discord
      expect(mockRouter.sendUpdate).toHaveBeenCalled();
      const updateCall: string = mockRouter.sendUpdate.mock.calls[0]?.[0] as string;
      expect(updateCall).toContain("CLI");
      expect(updateCall).toContain("my answer");
    });
  });

  // ── Streaming with non-zero exit code ─────────────────────────────

  describe("— streaming error handling", () => {
    it("should capture full output even when exit code is non-zero", async () => {
      const nodeId: string = `node-${String(createStableTestId("err-exit").value)}`;
      const { executor } = createStreamingExecutorScenario({
        lines: ["Starting...", "Error: something went wrong"],
        exitCode: 1,
        gateEvent: "GATE_FAILED",
      });

      const graph: DagGraph = createDagGraph([
        createDagNode({ id: nodeId, blueprint: "test" }),
      ]);
      const state: PipelineState = createPipelineState([
        createNodeState({ id: nodeId, blueprint: "test", status: "pending" }),
      ]);
      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test" })),
      };

      const result: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      expect(result.state.status).toBe("failed");
      const finalNode: NodeState | undefined = result.state.nodes.find(
        (n: NodeState): boolean => n.id === nodeId,
      );
      expect(finalNode!.output).toContain("Error: something went wrong");
    });
  });

  // ── Batch fallback: non-streaming backend should use old path ─────

  describe("— batch fallback (non-streaming backend)", () => {
    it("should use spawnContainer when backend does NOT support streaming", async () => {
      const nodeId: string = `node-${String(createStableTestId("batch-fallback").value)}`;

      // Create a NON-streaming backend (plain ExecutionBackend)
      const batchBackend = {
        spawnContainer: vi.fn().mockResolvedValue(
          createContainerResult({ exitCode: 0, stdout: "batch output" }),
        ),
        killAll: vi.fn().mockResolvedValue(undefined),
      };

      const gateEvaluator = createMockGateEvaluator("GATE_PASSED");
      const stateManager = createMockStateManager();
      const worktreeManager = createMockWorktreeManager();
      const promptBuilder = createMockPromptBuilder();

      const executor: DagExecutor = new DagExecutor(
        batchBackend as never,
        gateEvaluator as never,
        stateManager as never,
        worktreeManager as never,
        promptBuilder as never,
        new NoopLogger(),
        deepFreeze({ maxConcurrent: 4, reviewTiming: "before" as const }),
      );

      const graph: DagGraph = createDagGraph([
        createDagNode({ id: nodeId, blueprint: "test" }),
      ]);
      const state: PipelineState = createPipelineState([
        createNodeState({ id: nodeId, blueprint: "test", status: "pending" }),
      ]);
      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test" })),
      };

      const result: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      // Should use the batch path
      expect(batchBackend.spawnContainer).toHaveBeenCalledOnce();
      expect(result.state.status).toBe("completed");

      const finalNode: NodeState | undefined = result.state.nodes.find(
        (n: NodeState): boolean => n.id === nodeId,
      );
      expect(finalNode!.status).toBe("passed");
      expect(finalNode!.output).toBe("batch output");
    });
  });

  // ── StreamingSessionHandle contract ───────────────────────────────

  describe("— StreamingSessionHandle contract", () => {
    it("should produce all lines through outputStream", async () => {
      const expectedLines: ReadonlyArray<string> = [
        "Line 1",
        "Line 2",
        "Line 3",
      ];
      const { backend } = createMockStreamingBackend(expectedLines);

      const handle: StreamingSessionHandle = await backend.spawnStreamingSession({
        node: createDagNode({ id: "handle-test" }),
        blueprint: createBlueprint({ name: "test" }),
        prompt: "test prompt",
      });

      const receivedLines: string[] = [];
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: handle.outputStream });

      await new Promise<void>((resolve: () => void): void => {
        rl.on("line", (line: string): void => {
          receivedLines.push(line);
        });
        rl.on("close", resolve);
      });

      const completion: StreamCompletionEvent = await handle.waitForCompletion();

      expect(receivedLines).toEqual(expectedLines);
      expect(completion.type).toBe("completion");
      expect(completion.exitCode).toBe(0);
      expect(completion.fullOutput).toBe(expectedLines.join("\n"));
      expect(completion.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should record messages sent via sendMessage", async () => {
      const { backend, sentMessages } = createMockStreamingBackend(["line"]);

      const handle: StreamingSessionHandle = await backend.spawnStreamingSession({
        node: createDagNode({ id: "msg-test" }),
        blueprint: createBlueprint({ name: "test" }),
        prompt: "test prompt",
      });

      // Drain the stream so "end" fires (PassThrough buffers until consumed)
      handle.outputStream.resume();

      await handle.sendMessage("answer 1");
      await handle.sendMessage("answer 2");

      expect(sentMessages).toEqual(["answer 1", "answer 2"]);

      await handle.waitForCompletion();
    });

    it("should have a valid sessionId", async () => {
      const { backend } = createMockStreamingBackend(["line"]);

      const handle: StreamingSessionHandle = await backend.spawnStreamingSession({
        node: createDagNode({ id: "id-test" }),
        blueprint: createBlueprint({ name: "test" }),
        prompt: "test prompt",
      });

      // Drain the stream so "end" fires (PassThrough buffers until consumed)
      handle.outputStream.resume();

      expect(typeof handle.sessionId).toBe("string");
      expect(handle.sessionId.length).toBeGreaterThan(0);

      await handle.waitForCompletion();
    });
  });

  // ── Multi-node pipeline with mixed outcomes ───────────────────────

  describe("— multi-node mixed outcomes", () => {
    it("should stream all nodes and handle mixed pass/fail results", async () => {
      // Create a backend that returns different exit codes per node
      const sentMessages: string[] = [];
      let callCount: number = 0;

      const backend: StreamingExecutionBackend = {
        supportsStreaming: true as const,
        spawnContainer: vi.fn(),
        killAll: vi.fn().mockResolvedValue(undefined),
        spawnStreamingSession: vi.fn().mockImplementation(
          async (opts: SpawnOptions): Promise<StreamingSessionHandle> => {
            callCount++;
            const isFailNode: boolean = opts.node.id === "fail-node";
            const lines: ReadonlyArray<string> = isFailNode
              ? ["Error: compilation failed"]
              : ["Success output"];
            const exitCode: number = isFailNode ? 1 : 0;

            const stream: PassThrough = new PassThrough();
            setTimeout((): void => {
              for (const line of lines) {
                stream.write(line + "\n");
              }
              stream.end();
            }, 1);

            return {
              sessionId: toSessionId(`sess-${String(callCount)}`),
              outputStream: stream,
              sendMessage: vi.fn(),
              waitForCompletion: (): Promise<StreamCompletionEvent> =>
                new Promise<StreamCompletionEvent>((resolve): void => {
                  stream.on("end", (): void => {
                    resolve({
                      type: "completion",
                      exitCode,
                      fullOutput: lines.join("\n"),
                      durationMs: 10,
                    });
                  });
                }),
              kill: vi.fn(),
            };
          },
        ),
        sendSessionMessage: vi.fn(),
      };

      // Gate evaluator returns PASSED for exit 0, FAILED for exit 1
      const gateEvaluator = {
        evaluate: vi.fn(),
        evaluateToEvent: vi.fn().mockImplementation(
          (_gate: unknown, result: ContainerResult): GateEvaluation => {
            const passed: boolean = result.exitCode === 0;
            return {
              result: {
                passed,
                type: "quality",
                approved: passed ? 1 : 0,
                total: 1,
                details: passed ? "GATE PASSED" : "GATE FAILED",
              },
              event: passed ? "GATE_PASSED" : "GATE_FAILED",
            };
          },
        ),
        resolveEvent: vi.fn(),
      };

      const stateManager = createMockStateManager();

      const executor: DagExecutor = new DagExecutor(
        backend as never,
        gateEvaluator as never,
        stateManager as never,
        createMockWorktreeManager() as never,
        createMockPromptBuilder() as never,
        new NoopLogger(),
        deepFreeze({ maxConcurrent: 4, reviewTiming: "before" as const }),
      );

      const graph: DagGraph = createDagGraph([
        createDagNode({ id: "pass-node", blueprint: "test" }),
        createDagNode({ id: "fail-node", blueprint: "test" }),
      ]);
      const state: PipelineState = createPipelineState([
        createNodeState({ id: "pass-node", blueprint: "test", status: "pending" }),
        createNodeState({ id: "fail-node", blueprint: "test", status: "pending" }),
      ]);
      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test" })),
      };

      const result: ExecutionResult = await executor.execute(
        graph,
        blueprintRegistry as never,
        state,
      );

      // Pipeline should fail because one node failed
      expect(result.state.status).toBe("failed");

      const passNode: NodeState | undefined = result.state.nodes.find(
        (n: NodeState): boolean => n.id === "pass-node",
      );
      const failNode: NodeState | undefined = result.state.nodes.find(
        (n: NodeState): boolean => n.id === "fail-node",
      );

      expect(passNode!.status).toBe("passed");
      expect(failNode!.status).toBe("failed");
    });
  });

  // ── State persistence in streaming mode ───────────────────────────

  describe("— state persistence in streaming mode", () => {
    it("should save state after streaming execution completes", async () => {
      const nodeId: string = `node-${String(createStableTestId("persist").value)}`;
      const { executor, stateManager } = createStreamingExecutorScenario({
        lines: ["output"],
      });

      const graph: DagGraph = createDagGraph([
        createDagNode({ id: nodeId, blueprint: "test" }),
      ]);
      const state: PipelineState = createPipelineState([
        createNodeState({ id: nodeId, blueprint: "test", status: "pending" }),
      ]);
      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test" })),
      };

      await executor.execute(graph, blueprintRegistry as never, state);

      // State should be saved at least twice (after batch + final)
      expect(stateManager.save.mock.calls.length).toBeGreaterThanOrEqual(2);

      // Final save should have completed status
      const lastSave: PipelineState =
        stateManager.save.mock.calls[stateManager.save.mock.calls.length - 1]![0] as PipelineState;
      expect(lastSave.status).toBe("completed");
    });

    it("should save state with paused status when human gate is hit in streaming mode", async () => {
      const nodeId: string = `node-${String(createStableTestId("persist-pause").value)}`;
      const { executor, stateManager } = createStreamingExecutorScenario({
        lines: ["output"],
        gateEvent: "HUMAN_GATE",
      });

      const graph: DagGraph = createDagGraph([
        createDagNode({ id: nodeId, blueprint: "test" }),
      ]);
      const state: PipelineState = createPipelineState([
        createNodeState({ id: nodeId, blueprint: "test", status: "pending" }),
      ]);
      const blueprintRegistry = {
        get: vi.fn().mockReturnValue(createBlueprint({ name: "test", gate: { type: "human" } })),
      };

      await executor.execute(graph, blueprintRegistry as never, state);

      const lastSave: PipelineState =
        stateManager.save.mock.calls[stateManager.save.mock.calls.length - 1]![0] as PipelineState;
      expect(lastSave.status).toBe("paused");
    });
  });
});
