import type { Gate } from "@pftypes/Blueprint.ts";
import type { GateResult } from "@pftypes/Gate.ts";
import type { ContainerResult, NodeState, PipelineState } from "@pftypes/Pipeline.ts";
import type { TransitionEvent } from "@core/NodeFSM.ts";

// ── Gate Evaluation Result with FSM Event ───────────────────────────

export interface GateEvaluation {
  readonly result: GateResult;
  readonly event: TransitionEvent;
}

// ── Gate Evaluator ──────────────────────────────────────────────────
// Evaluates gate conditions for completed blueprint executions.
// Returns both a GateResult (for logging/state) and a TransitionEvent
// (for driving the NodeFSM).

export class GateEvaluator {
  /**
   * Evaluate gate conditions for a completed node.
   *
   * @param gate - Gate definition from the blueprint
   * @param result - Container execution result
   * @param state - Current pipeline state (for sibling aggregation)
   * @param nodeId - The node being evaluated
   * @returns Gate evaluation result
   */
  evaluate(
    gate: Gate,
    result: ContainerResult,
    state: PipelineState,
    nodeId: string,
  ): GateResult {
    switch (gate.type) {
      case "approval":
        return this.evaluateApproval(gate, result, state, nodeId);
      case "quality":
        return this.evaluateQuality(gate, result);
      case "human":
        return this.evaluateHuman();
      case "composite":
        return this.evaluateComposite(gate, result, state, nodeId);
    }
  }

  /**
   * Evaluate and resolve to an FSM transition event.
   * This is the primary interface for the DagExecutor — it returns
   * both the gate result (for persistence) and the event to feed
   * into the NodeFSM.
   *
   * @param gate - Gate definition from the blueprint
   * @param result - Container execution result
   * @param state - Current pipeline state
   * @param nodeId - The node being evaluated
   * @returns GateEvaluation with result and FSM event
   */
  evaluateToEvent(
    gate: Gate,
    result: ContainerResult,
    state: PipelineState,
    nodeId: string,
  ): GateEvaluation {
    const gateResult: GateResult = this.evaluate(gate, result, state, nodeId);
    const event: TransitionEvent = this.resolveEvent(gateResult);
    return { result: gateResult, event };
  }

  /**
   * Map a GateResult to its corresponding NodeFSM TransitionEvent.
   *
   * @param gateResult - The gate evaluation result
   * @returns The FSM event to apply
   */
  resolveEvent(gateResult: GateResult): TransitionEvent {
    if (gateResult.type === "human") {
      return "HUMAN_GATE";
    }
    return gateResult.passed ? "GATE_PASSED" : "GATE_FAILED";
  }

  /**
   * Evaluate an approval gate by aggregating results across
   * parallel instances (siblings) of the same blueprint.
   */
  private evaluateApproval(
    gate: Gate,
    _result: ContainerResult,
    state: PipelineState,
    nodeId: string,
  ): GateResult {
    const siblings: ReadonlyArray<NodeState> = this.getSiblingResults(
      state,
      nodeId,
    );

    const approvalMarker: string = gate.approval_marker ?? "APPROVED";
    const approved: number = siblings.filter(
      (n: NodeState): boolean =>
        n.output !== null && n.output.includes(approvalMarker),
    ).length;

    const total: number = gate.total ?? siblings.length;
    const required: number = gate.required ?? total;

    const allComplete: boolean = siblings.every(
      (n: NodeState): boolean =>
        n.status === "passed" || n.status === "failed",
    );

    if (!allComplete) {
      return {
        passed: true,
        type: "approval",
        approved,
        total,
        details: `${String(approved)}/${String(total)} — waiting for siblings`,
      };
    }

    const passed: boolean = approved >= required;

    return {
      passed,
      type: "approval",
      approved,
      total,
      details: passed
        ? `${String(approved)}/${String(total)} approvals — GATE PASSED`
        : `${String(approved)}/${String(total)} approvals — GATE FAILED (need ${String(required)})`,
    };
  }

  /**
   * Evaluate a quality gate based on exit code and pattern matching.
   */
  private evaluateQuality(
    gate: Gate,
    result: ContainerResult,
  ): GateResult {
    const checks: boolean[] = [];

    if (gate.quality_checks !== undefined) {
      for (const check of gate.quality_checks) {
        switch (check.check) {
          case "exit_code":
            checks.push(result.exitCode === 0);
            break;
          case "tests_pass":
            checks.push(result.exitCode === 0);
            break;
          case "lint_clean":
            checks.push(result.exitCode === 0);
            break;
          case "pattern_match":
            if (check.pattern !== undefined) {
              checks.push(
                new RegExp(check.pattern).test(result.stdout),
              );
            }
            break;
        }
      }
    } else {
      checks.push(result.exitCode === 0);
    }

    const passed: boolean = checks.every(Boolean);
    const passedCount: number = checks.filter(Boolean).length;

    return {
      passed,
      type: "quality",
      approved: passedCount,
      total: checks.length,
      details: passed
        ? `${String(passedCount)}/${String(checks.length)} quality checks — GATE PASSED`
        : `${String(passedCount)}/${String(checks.length)} quality checks — GATE FAILED`,
    };
  }

  /**
   * Human gate always returns a "pause" result.
   */
  private evaluateHuman(): GateResult {
    return {
      passed: false,
      type: "human",
      approved: 0,
      total: 1,
      details: "Awaiting human approval",
    };
  }

  /**
   * Composite gate: approval + quality must both pass.
   */
  private evaluateComposite(
    gate: Gate,
    result: ContainerResult,
    state: PipelineState,
    nodeId: string,
  ): GateResult {
    const approvalResult: GateResult = this.evaluateApproval(
      gate,
      result,
      state,
      nodeId,
    );
    const qualityResult: GateResult = this.evaluateQuality(gate, result);

    const passed: boolean =
      approvalResult.passed && qualityResult.passed;

    return {
      passed,
      type: "composite",
      approved: approvalResult.approved,
      total: approvalResult.total,
      details: `Approval: ${approvalResult.details} | Quality: ${qualityResult.details}`,
    };
  }

  /**
   * Get all sibling nodes (same blueprint) from pipeline state.
   */
  private getSiblingResults(
    state: PipelineState,
    nodeId: string,
  ): ReadonlyArray<NodeState> {
    const node: NodeState | undefined = state.nodes.find(
      (n: NodeState): boolean => n.id === nodeId,
    );
    if (node === undefined) {
      return [];
    }

    return state.nodes.filter(
      (n: NodeState): boolean => n.blueprint === node.blueprint,
    );
  }
}
