import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  PipelineState,
  PipelineSummary,
  NodeState,
} from "../types/Pipeline.js";
import type { GateResult, RejectionRecord } from "../types/Gate.js";

// ── State Manager ───────────────────────────────────────────────────
// Persists and restores pipeline state as JSON files.

export class StateManager {
  private readonly stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  /**
   * Save pipeline state to disk.
   * State file: <stateDir>/<pipeline-id>/state.json
   *
   * @param state - The pipeline state to persist
   */
  async save(state: PipelineState): Promise<void> {
    const dir: string = join(this.stateDir, state.id);
    await mkdir(dir, { recursive: true });

    const updated: PipelineState = {
      ...state,
      updated_at: new Date().toISOString(),
    };

    await writeFile(
      join(dir, "state.json"),
      JSON.stringify(updated, null, 2),
      "utf-8",
    );
  }

  /**
   * Load pipeline state from disk.
   *
   * @param pipelineId - The pipeline ID to load
   * @returns The loaded pipeline state
   */
  async load(pipelineId: string): Promise<PipelineState> {
    const raw: string = await readFile(
      join(this.stateDir, pipelineId, "state.json"),
      "utf-8",
    );
    return JSON.parse(raw) as PipelineState;
  }

  /**
   * List all pipelines with their current status.
   *
   * @returns Array of pipeline summaries
   */
  async list(): Promise<ReadonlyArray<PipelineSummary>> {
    let dirs: ReadonlyArray<string>;
    try {
      dirs = await readdir(this.stateDir);
    } catch {
      return [];
    }

    const summaries: PipelineSummary[] = [];
    for (const id of dirs) {
      try {
        const state: PipelineState = await this.load(id);
        summaries.push({
          id: state.id,
          pipeline: state.pipeline_name,
          feature: state.feature,
          status: state.status,
          created: state.created_at,
          updated: state.updated_at,
        });
      } catch {
        // Skip corrupted state files
      }
    }

    return summaries;
  }

  /**
   * Update a single node's state within a pipeline.
   *
   * @param state - Current pipeline state
   * @param nodeId - The node ID to update
   * @param updates - Partial node state updates
   * @returns New pipeline state with the node updated
   */
  updateNode(
    state: PipelineState,
    nodeId: string,
    updates: Partial<NodeState>,
  ): PipelineState {
    const nodes: ReadonlyArray<NodeState> = state.nodes.map(
      (node: NodeState): NodeState =>
        node.id === nodeId ? { ...node, ...updates } : node,
    );

    return { ...state, nodes };
  }

  /**
   * Reset failed nodes back to pending for retry.
   * Clears execution artifacts (output, exit_code, gate_result, etc.)
   * while preserving rejection_history for audit trail.
   *
   * @param state - Current pipeline state
   * @param nodeId - Optional specific node ID to reset. If omitted, resets all failed nodes.
   * @returns Updated pipeline state with failed nodes reset to pending and pipeline status set to running
   */
  resetFailedNodes(
    state: PipelineState,
    nodeId?: string,
  ): PipelineState {
    const nodes: ReadonlyArray<NodeState> = state.nodes.map(
      (node: NodeState): NodeState => {
        const shouldReset: boolean =
          node.status === "failed" &&
          (nodeId === undefined || node.id === nodeId);

        if (!shouldReset) {
          return node;
        }

        return {
          ...node,
          status: "pending",
          started_at: null,
          completed_at: null,
          duration_ms: null,
          container_id: null,
          exit_code: null,
          output: null,
          error: null,
          gate_result: null,
          // Preserve worktree info and dry_run_output — they may be
          // useful context on retry. Preserve rejection history for
          // audit trail.
        };
      },
    );

    return { ...state, status: "running", nodes };
  }

  /**
   * Record a rejection for a node and route to upstream.
   *
   * @param state - Current pipeline state
   * @param nodeId - The node that was rejected
   * @param gateResult - The gate evaluation result
   * @param routeTo - The upstream blueprint to re-run
   * @returns Updated pipeline state
   */
  recordRejection(
    state: PipelineState,
    nodeId: string,
    gateResult: GateResult,
    routeTo: string | undefined,
  ): PipelineState {
    const rejection: RejectionRecord = {
      timestamp: new Date().toISOString(),
      feedback: gateResult.details,
      routed_to: routeTo ?? "none",
    };

    const nodes: ReadonlyArray<NodeState> = state.nodes.map(
      (node: NodeState): NodeState => {
        if (node.id === nodeId) {
          return {
            ...node,
            status: "failed",
            gate_result: gateResult,
            rejection_count: node.rejection_count + 1,
            rejection_history: [...node.rejection_history, rejection],
          };
        }
        return node;
      },
    );

    return { ...state, nodes };
  }
}
