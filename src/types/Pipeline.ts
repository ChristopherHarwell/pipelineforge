import type { GateResult, RejectionRecord } from "./Gate.js";

// ── Node Status ─────────────────────────────────────────────────────

export type NodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "dry_run_complete"
  | "awaiting_proposal_review"
  | "implementing"
  | "awaiting_implementation_review"
  | "passed"
  | "failed"
  | "skipped"
  | "awaiting_human";

// ── Pipeline Status ─────────────────────────────────────────────────

export type PipelineStatus = "running" | "paused" | "completed" | "failed";

// ── Review Timing ───────────────────────────────────────────────────

export type ReviewTiming = "before" | "after" | "both";

// ── Node State ──────────────────────────────────────────────────────

export interface NodeState {
  readonly id: string;
  readonly blueprint: string;
  readonly instance: number;
  readonly status: NodeStatus;
  readonly depends_on: ReadonlyArray<string>;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly duration_ms: number | null;
  readonly container_id: string | null;
  readonly worktree_branch: string | null;
  readonly worktree_path: string | null;
  readonly dry_run_output: string | null;
  readonly exit_code: number | null;
  readonly output: string | null;
  readonly error: string | null;
  readonly gate_result: GateResult | null;
  readonly rejection_count: number;
  readonly rejection_history: ReadonlyArray<RejectionRecord>;
}

// ── Pipeline State ──────────────────────────────────────────────────

export interface PipelineState {
  readonly id: string;
  readonly pipeline_name: string;
  readonly feature: string;
  readonly notes_dir: string;
  readonly repo_dir: string;
  readonly review_timing: ReviewTiming;
  readonly created_at: string;
  readonly updated_at: string;
  readonly status: PipelineStatus;
  readonly nodes: ReadonlyArray<NodeState>;
}

// ── Pipeline Summary ────────────────────────────────────────────────

export interface PipelineSummary {
  readonly id: string;
  readonly pipeline: string;
  readonly feature: string;
  readonly status: PipelineStatus;
  readonly created: string;
  readonly updated: string;
}

// ── Pipeline Config ─────────────────────────────────────────────────

export interface PipelineConfig {
  readonly name: string;
  readonly description: string;
  readonly blueprints: ReadonlyArray<string>;
  readonly defaults: {
    readonly model: string;
    readonly timeout_minutes: number;
    readonly max_concurrent_containers: number;
  };
  readonly human_gates: ReadonlyArray<{ readonly after: string }>;
}

// ── Container Result ────────────────────────────────────────────────

export interface ContainerResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}
