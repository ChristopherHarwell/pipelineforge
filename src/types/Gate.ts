// ── Gate Result Types ────────────────────────────────────────────────

export type GateType = "approval" | "quality" | "human" | "composite";

export interface GateResult {
  readonly passed: boolean;
  readonly type: GateType;
  readonly approved: number;
  readonly total: number;
  readonly details: string;
}

export interface RejectionRecord {
  readonly timestamp: string;
  readonly feedback: string;
  readonly routed_to: string;
}
