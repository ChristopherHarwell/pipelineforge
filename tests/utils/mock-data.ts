// ── Stable Test ID ──────────────────────────────────────────────────
// Generates randomized test identifiers to prevent test coupling to
// specific values. Every test datum uses a StableTestId so that
// hardcoded magic values never leak across test boundaries.

export interface StableTestId {
  readonly value: number;
  readonly label?: string;
}

/**
 * Create a frozen test identifier with a random value.
 * Prevents hardcoded test values from coupling tests together.
 *
 * @param label - Optional human-readable label for debugging
 * @returns A frozen StableTestId
 */
export function createStableTestId(label?: string): StableTestId {
  return Object.freeze({ value: Math.random(), label });
}

/**
 * Create a frozen integer test identifier in a given range.
 *
 * @param min - Minimum value (inclusive)
 * @param max - Maximum value (exclusive)
 * @param label - Optional label
 * @returns A frozen StableTestId with an integer value
 */
export function createStableIntegerId(
  min: number,
  max: number,
  label?: string,
): StableTestId {
  return Object.freeze({
    value: Math.floor(Math.random() * (max - min)) + min,
    label,
  });
}

// ── Deep Freeze ─────────────────────────────────────────────────────
// Import for local use and re-export for test consumers.

import { deepFreeze } from "../../src/utils/deepfreeze.js";
export { deepFreeze };
export type { DeepReadonly } from "../../src/utils/deepfreeze.js";

// ── Pipeline Test Factories ─────────────────────────────────────────

import type { GateResult } from "../../src/types/Gate.js";
import type {
  ContainerResult,
  NodeState,
  PipelineState,
  ReviewTiming,
} from "../../src/types/Pipeline.js";
import type { Blueprint } from "../../src/types/Blueprint.js";

/**
 * Create a ContainerResult with sensible defaults.
 * All values can be overridden via the overrides parameter.
 */
export function createContainerResult(
  overrides?: Partial<ContainerResult>,
): ContainerResult {
  return deepFreeze({
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs: createStableIntegerId(100, 10000, "durationMs").value,
    ...overrides,
  });
}

/**
 * Create a NodeState with sensible defaults.
 * Requires at minimum an `id` field.
 */
export function createNodeState(
  overrides: Partial<NodeState> & { readonly id: string },
): NodeState {
  return deepFreeze({
    blueprint: "test",
    instance: 1,
    status: "passed" as const,
    depends_on: [],
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
    ...overrides,
  });
}

/**
 * Create a PipelineState with sensible defaults.
 * Accepts a node array and optional state-level overrides.
 */
export function createPipelineState(
  nodes: ReadonlyArray<NodeState>,
  overrides?: Partial<PipelineState>,
): PipelineState {
  const pipelineId: string = `pipeline-${String(createStableTestId("pipelineId").value)}`;
  return deepFreeze({
    id: pipelineId,
    pipeline_name: "test",
    feature: "test feature",
    notes_dir: "/notes",
    repo_dir: "/repo",
    review_timing: "before" as ReviewTiming,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "running" as const,
    nodes,
    ...overrides,
  });
}

/**
 * Create a Blueprint with sensible defaults for testing.
 * Requires at minimum a `name` field.
 */
export function createBlueprint(
  overrides: Partial<Blueprint> & { readonly name: string },
): Blueprint {
  return deepFreeze({
    description: "test blueprint",
    skill_path: "~/.claude/skills/test/SKILL.md",
    execution: {
      prompt_template: "test prompt",
      model: "sonnet" as const,
      max_turns: 50,
      timeout_minutes: 10,
      allowed_tools: ["Read"],
      output_format: "json" as const,
    },
    parallel: { instances: 1, naming: "{name}-{i}" },
    depends_on: [],
    gate: { type: "quality" as const },
    outputs: {},
    review_mode: { enabled: false, dry_run_disallowed_tools: ["Edit", "Write", "NotebookEdit"] },
    requires_repo: true,
    ...overrides,
  });
}

// ── Approval Scenario Factory ───────────────────────────────────────

export interface ApprovalScenario {
  readonly label: string;
  readonly nodes: ReadonlyArray<NodeState>;
  readonly required: number;
  readonly total: number;
  readonly expectedPassed: boolean;
  readonly expectedApproved: number;
}

/**
 * Create an approval gate test scenario with N approved and M rejected nodes.
 *
 * @param approvedCount - Number of nodes that output "APPROVED"
 * @param rejectedCount - Number of nodes that output "REJECTED"
 * @param required - Number of approvals required to pass
 */
export function createApprovalScenario(
  approvedCount: number,
  rejectedCount: number,
  required: number,
): ApprovalScenario {
  const total: number = approvedCount + rejectedCount;
  const nodes: NodeState[] = [];

  for (let i: number = 1; i <= approvedCount; i++) {
    nodes.push(
      createNodeState({
        id: `qa-${String(i)}`,
        blueprint: "qa",
        output: "APPROVED",
      }),
    );
  }

  for (let i: number = approvedCount + 1; i <= total; i++) {
    nodes.push(
      createNodeState({
        id: `qa-${String(i)}`,
        blueprint: "qa",
        output: "REJECTED",
      }),
    );
  }

  return deepFreeze({
    label: `${String(approvedCount)}/${String(total)} approved (need ${String(required)})`,
    nodes,
    required,
    total,
    expectedPassed: approvedCount >= required,
    expectedApproved: approvedCount,
  });
}
