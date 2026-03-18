import { describe, it, expect } from "vitest";
import { GateEvaluator } from "@core/GateEvaluator.ts";
import type { GateEvaluation } from "@core/GateEvaluator.ts";
import type { TransitionEvent } from "@core/NodeFSM.ts";
import type { Gate } from "@pftypes/Blueprint.ts";
import type { GateResult } from "@pftypes/Gate.ts";
import type {
  ContainerResult,
  NodeState,
  PipelineState,
} from "@pftypes/Pipeline.ts";
import {
  createContainerResult,
  createNodeState,
  createPipelineState,
  createApprovalScenario,
  type ApprovalScenario,
} from "../utils/mock-data.js";

// ===========================================================================
// GateEvaluator
// ===========================================================================

describe("GateEvaluator", () => {
  const evaluator: GateEvaluator = new GateEvaluator();

  // ── Quality gate ──────────────────────────────────────────────────

  describe("— quality gate", () => {
    it("should pass when exit code is 0 and no explicit checks defined", () => {
      const gate: Gate = { type: "quality" };
      const result: ContainerResult = createContainerResult({ exitCode: 0 });
      const state: PipelineState = createPipelineState([]);

      const gateResult: GateResult = evaluator.evaluate(
        gate,
        result,
        state,
        "node-1",
      );

      expect(gateResult.passed).toBe(true);
      expect(gateResult.type).toBe("quality");
    });

    it("should fail when exit code is non-zero", () => {
      const gate: Gate = { type: "quality" };
      const result: ContainerResult = createContainerResult({ exitCode: 1 });
      const state: PipelineState = createPipelineState([]);

      const gateResult: GateResult = evaluator.evaluate(
        gate,
        result,
        state,
        "node-1",
      );

      expect(gateResult.passed).toBe(false);
    });

    it.each<{ label: string; check: "exit_code" | "tests_pass" | "lint_clean" }>([
      { label: "exit_code", check: "exit_code" },
      { label: "tests_pass", check: "tests_pass" },
      { label: "lint_clean", check: "lint_clean" },
    ])("should pass $label check when exit code is 0", ({ check }) => {
      const gate: Gate = {
        type: "quality",
        quality_checks: [{ check }],
      };
      const result: ContainerResult = createContainerResult({ exitCode: 0 });
      const state: PipelineState = createPipelineState([]);

      const gateResult: GateResult = evaluator.evaluate(
        gate,
        result,
        state,
        "node-1",
      );

      expect(gateResult.passed).toBe(true);
      expect(gateResult.approved).toBe(1);
      expect(gateResult.total).toBe(1);
    });

    it("should pass pattern_match when pattern is found in stdout", () => {
      const gate: Gate = {
        type: "quality",
        quality_checks: [
          { check: "pattern_match", pattern: "ALL TESTS PASSED" },
        ],
      };
      const result: ContainerResult = createContainerResult({
        stdout: "Running tests... ALL TESTS PASSED",
      });
      const state: PipelineState = createPipelineState([]);

      const gateResult: GateResult = evaluator.evaluate(
        gate,
        result,
        state,
        "node-1",
      );

      expect(gateResult.passed).toBe(true);
    });

    it("should fail pattern_match when pattern is absent from stdout", () => {
      const gate: Gate = {
        type: "quality",
        quality_checks: [
          { check: "pattern_match", pattern: "ALL TESTS PASSED" },
        ],
      };
      const result: ContainerResult = createContainerResult({
        stdout: "3 tests failed",
      });
      const state: PipelineState = createPipelineState([]);

      const gateResult: GateResult = evaluator.evaluate(
        gate,
        result,
        state,
        "node-1",
      );

      expect(gateResult.passed).toBe(false);
    });

    it("should require all quality checks to pass (AND semantics)", () => {
      const gate: Gate = {
        type: "quality",
        quality_checks: [
          { check: "exit_code" },
          { check: "pattern_match", pattern: "CLEAN" },
        ],
      };
      const result: ContainerResult = createContainerResult({
        exitCode: 0,
        stdout: "not clean",
      });
      const state: PipelineState = createPipelineState([]);

      const gateResult: GateResult = evaluator.evaluate(
        gate,
        result,
        state,
        "node-1",
      );

      expect(gateResult.passed).toBe(false);
      expect(gateResult.approved).toBe(1);
      expect(gateResult.total).toBe(2);
    });
  });

  // ── Approval gate ─────────────────────────────────────────────────

  describe("— approval gate", () => {
    it.each<ApprovalScenario>([
      createApprovalScenario(6, 0, 6),
      createApprovalScenario(5, 1, 6),
      createApprovalScenario(3, 3, 6),
      createApprovalScenario(4, 2, 4),
      createApprovalScenario(3, 0, 3),
    ])(
      "should evaluate $label → passed=$expectedPassed",
      ({ nodes, required, total, expectedPassed, expectedApproved }) => {
        const gate: Gate = {
          type: "approval",
          required,
          total,
          approval_marker: "APPROVED",
        };
        const result: ContainerResult = createContainerResult();
        const state: PipelineState = createPipelineState(nodes);

        const gateResult: GateResult = evaluator.evaluate(
          gate,
          result,
          state,
          nodes[0]!.id,
        );

        expect(gateResult.passed).toBe(expectedPassed);
        expect(gateResult.approved).toBe(expectedApproved);
      },
    );

    it("should defer evaluation when siblings are still running", () => {
      const gate: Gate = {
        type: "approval",
        required: 3,
        total: 3,
        approval_marker: "APPROVED",
      };
      const result: ContainerResult = createContainerResult();
      const nodes: ReadonlyArray<NodeState> = [
        createNodeState({
          id: "qa-1",
          blueprint: "qa",
          status: "passed",
          output: "APPROVED",
        }),
        createNodeState({
          id: "qa-2",
          blueprint: "qa",
          status: "running",
          output: null,
        }),
        createNodeState({
          id: "qa-3",
          blueprint: "qa",
          status: "pending",
          output: null,
        }),
      ];
      const state: PipelineState = createPipelineState(nodes);

      const gateResult: GateResult = evaluator.evaluate(
        gate,
        result,
        state,
        "qa-1",
      );

      expect(gateResult.passed).toBe(true);
      expect(gateResult.details).toContain("waiting for siblings");
    });

    it("should use custom approval_marker when specified", () => {
      const gate: Gate = {
        type: "approval",
        required: 1,
        total: 1,
        approval_marker: "LGTM",
      };
      const result: ContainerResult = createContainerResult();
      const nodes: ReadonlyArray<NodeState> = [
        createNodeState({
          id: "review-1",
          blueprint: "review",
          output: "Code looks good. LGTM",
        }),
      ];
      const state: PipelineState = createPipelineState(nodes);

      const gateResult: GateResult = evaluator.evaluate(
        gate,
        result,
        state,
        "review-1",
      );

      expect(gateResult.passed).toBe(true);
      expect(gateResult.approved).toBe(1);
    });
  });

  // ── Human gate ────────────────────────────────────────────────────

  describe("— human gate", () => {
    it("should always return passed=false to trigger a pipeline pause", () => {
      const gate: Gate = { type: "human" };
      const result: ContainerResult = createContainerResult();
      const state: PipelineState = createPipelineState([]);

      const gateResult: GateResult = evaluator.evaluate(
        gate,
        result,
        state,
        "node-1",
      );

      expect(gateResult.passed).toBe(false);
      expect(gateResult.type).toBe("human");
      expect(gateResult.details).toMatch(/human/i);
    });
  });

  // ── Composite gate ────────────────────────────────────────────────

  describe("— composite gate", () => {
    it("should pass when both approval and quality conditions are met", () => {
      const gate: Gate = {
        type: "composite",
        required: 2,
        total: 2,
        approval_marker: "APPROVED",
        quality_checks: [{ check: "exit_code" }],
      };
      const result: ContainerResult = createContainerResult({ exitCode: 0 });
      const nodes: ReadonlyArray<NodeState> = [
        createNodeState({
          id: "qa-1",
          blueprint: "qa",
          output: "APPROVED",
        }),
        createNodeState({
          id: "qa-2",
          blueprint: "qa",
          output: "APPROVED",
        }),
      ];
      const state: PipelineState = createPipelineState(nodes);

      const gateResult: GateResult = evaluator.evaluate(
        gate,
        result,
        state,
        "qa-1",
      );

      expect(gateResult.passed).toBe(true);
      expect(gateResult.type).toBe("composite");
    });

    it("should fail when quality passes but approval does not", () => {
      const gate: Gate = {
        type: "composite",
        required: 2,
        total: 2,
        approval_marker: "APPROVED",
        quality_checks: [{ check: "exit_code" }],
      };
      const result: ContainerResult = createContainerResult({ exitCode: 0 });
      const nodes: ReadonlyArray<NodeState> = [
        createNodeState({
          id: "qa-1",
          blueprint: "qa",
          output: "APPROVED",
        }),
        createNodeState({
          id: "qa-2",
          blueprint: "qa",
          output: "REJECTED",
        }),
      ];
      const state: PipelineState = createPipelineState(nodes);

      const gateResult: GateResult = evaluator.evaluate(
        gate,
        result,
        state,
        "qa-1",
      );

      expect(gateResult.passed).toBe(false);
    });

    it("should fail when approval passes but quality does not", () => {
      const gate: Gate = {
        type: "composite",
        required: 2,
        total: 2,
        approval_marker: "APPROVED",
        quality_checks: [{ check: "exit_code" }],
      };
      const result: ContainerResult = createContainerResult({ exitCode: 1 });
      const nodes: ReadonlyArray<NodeState> = [
        createNodeState({
          id: "qa-1",
          blueprint: "qa",
          output: "APPROVED",
        }),
        createNodeState({
          id: "qa-2",
          blueprint: "qa",
          output: "APPROVED",
        }),
      ];
      const state: PipelineState = createPipelineState(nodes);

      const gateResult: GateResult = evaluator.evaluate(
        gate,
        result,
        state,
        "qa-1",
      );

      expect(gateResult.passed).toBe(false);
    });
  });

  // ── evaluateToEvent ─────────────────────────────────────────────────

  describe("— evaluateToEvent", () => {
    it("should return both a GateResult and a GATE_PASSED event for a passing quality gate", () => {
      const gate: Gate = { type: "quality" };
      const result: ContainerResult = createContainerResult({ exitCode: 0 });
      const state: PipelineState = createPipelineState([]);

      const evaluation: GateEvaluation = evaluator.evaluateToEvent(
        gate,
        result,
        state,
        "node-1",
      );

      expect(evaluation.result.passed).toBe(true);
      expect(evaluation.result.type).toBe("quality");
      expect(evaluation.event).toBe("GATE_PASSED");
    });

    it("should return GATE_FAILED event for a failing quality gate", () => {
      const gate: Gate = { type: "quality" };
      const result: ContainerResult = createContainerResult({ exitCode: 1 });
      const state: PipelineState = createPipelineState([]);

      const evaluation: GateEvaluation = evaluator.evaluateToEvent(
        gate,
        result,
        state,
        "node-1",
      );

      expect(evaluation.result.passed).toBe(false);
      expect(evaluation.event).toBe("GATE_FAILED");
    });

    it("should return HUMAN_GATE event for a human gate", () => {
      const gate: Gate = { type: "human" };
      const result: ContainerResult = createContainerResult();
      const state: PipelineState = createPipelineState([]);

      const evaluation: GateEvaluation = evaluator.evaluateToEvent(
        gate,
        result,
        state,
        "node-1",
      );

      expect(evaluation.result.type).toBe("human");
      expect(evaluation.event).toBe("HUMAN_GATE");
    });
  });

  // ── resolveEvent ────────────────────────────────────────────────────

  describe("— resolveEvent", () => {
    it.each<{ label: string; gateResult: GateResult; expectedEvent: TransitionEvent }>([
      {
        label: "quality passed → GATE_PASSED",
        gateResult: { passed: true, type: "quality", approved: 1, total: 1, details: "" },
        expectedEvent: "GATE_PASSED",
      },
      {
        label: "quality failed → GATE_FAILED",
        gateResult: { passed: false, type: "quality", approved: 0, total: 1, details: "" },
        expectedEvent: "GATE_FAILED",
      },
      {
        label: "approval passed → GATE_PASSED",
        gateResult: { passed: true, type: "approval", approved: 6, total: 6, details: "" },
        expectedEvent: "GATE_PASSED",
      },
      {
        label: "approval failed → GATE_FAILED",
        gateResult: { passed: false, type: "approval", approved: 2, total: 6, details: "" },
        expectedEvent: "GATE_FAILED",
      },
      {
        label: "human gate → HUMAN_GATE (regardless of passed flag)",
        gateResult: { passed: false, type: "human", approved: 0, total: 1, details: "" },
        expectedEvent: "HUMAN_GATE",
      },
      {
        label: "composite passed → GATE_PASSED",
        gateResult: { passed: true, type: "composite", approved: 6, total: 6, details: "" },
        expectedEvent: "GATE_PASSED",
      },
      {
        label: "composite failed → GATE_FAILED",
        gateResult: { passed: false, type: "composite", approved: 3, total: 6, details: "" },
        expectedEvent: "GATE_FAILED",
      },
    ])("should resolve $label", ({ gateResult, expectedEvent }) => {
      const event: TransitionEvent = evaluator.resolveEvent(gateResult);

      expect(event).toBe(expectedEvent);
    });
  });
});
