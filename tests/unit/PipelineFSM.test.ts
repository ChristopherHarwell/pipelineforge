import { describe, it, expect } from "vitest";
import {
  PipelineFSM,
  createPipelineFSM,
  P_RUNNING,
  P_PAUSED,
  P_COMPLETED,
  P_FAILED,
} from "../../src/core/PipelineFSM.js";
import type { PipelineStateId, PipelineEvent } from "../../src/core/PipelineFSM.js";
import { createStableTestId } from "../utils/mock-data.js";

// ===========================================================================
// PipelineFSM
// ===========================================================================

describe("PipelineFSM", () => {
  // ── Initial state ─────────────────────────────────────────────────

  describe("— initial state", () => {
    it("should default to RUNNING (0x0)", () => {
      const fsm: PipelineFSM = new PipelineFSM("pipeline-1");

      expect(fsm.getState()).toBe(P_RUNNING);
      expect(fsm.getStateName()).toBe("running");
    });
  });

  // ── Standard lifecycle ────────────────────────────────────────────

  describe("— standard lifecycle", () => {
    it("should walk RUNNING → COMPLETED when all nodes pass", () => {
      const fsm: PipelineFSM = new PipelineFSM("pipeline-1");

      const s: PipelineStateId = fsm.transition("ALL_PASSED");
      expect(s).toBe(P_COMPLETED);
      expect(fsm.isTerminal()).toBe(true);
    });

    it("should walk RUNNING → FAILED when a node fails", () => {
      const fsm: PipelineFSM = new PipelineFSM("pipeline-1");

      const s: PipelineStateId = fsm.transition("NODE_FAILED");
      expect(s).toBe(P_FAILED);
      expect(fsm.isTerminal()).toBe(true);
    });
  });

  // ── Pause and resume ──────────────────────────────────────────────

  describe("— pause and resume", () => {
    it("should walk RUNNING → PAUSED → RUNNING on pause/resume", () => {
      const fsm: PipelineFSM = new PipelineFSM("pipeline-1");

      const s1: PipelineStateId = fsm.transition("NODE_PAUSED");
      expect(s1).toBe(P_PAUSED);
      expect(fsm.isTerminal()).toBe(false);

      const s2: PipelineStateId = fsm.transition("RESUME");
      expect(s2).toBe(P_RUNNING);
    });
  });

  // ── Abort ─────────────────────────────────────────────────────────

  describe("— abort", () => {
    it.each<{ label: string; initialState: PipelineStateId }>([
      { label: "RUNNING", initialState: P_RUNNING },
      { label: "PAUSED",  initialState: P_PAUSED },
    ])("should transition $label → FAILED on ABORT", ({ initialState }) => {
      const fsm: PipelineFSM = new PipelineFSM("pipeline-1", initialState);

      const s: PipelineStateId = fsm.transition("ABORT");
      expect(s).toBe(P_FAILED);
    });
  });

  // ── Retry ───────────────────────────────────────────────────────

  describe("— retry", () => {
    it("should transition FAILED → RUNNING on RETRY event", () => {
      const pipelineId: string = `pipeline-${String(createStableTestId("retry-basic").value)}`;
      const fsm: PipelineFSM = new PipelineFSM(pipelineId, P_FAILED);

      const s: PipelineStateId = fsm.transition("RETRY");
      expect(s).toBe(P_RUNNING);
      expect(fsm.isTerminal()).toBe(false);
    });

    it("should not allow RETRY from RUNNING", () => {
      const pipelineId: string = `pipeline-${String(createStableTestId("retry-from-running").value)}`;
      const fsm: PipelineFSM = new PipelineFSM(pipelineId, P_RUNNING);

      expect(() => fsm.transition("RETRY")).toThrow(
        /Invalid pipeline transition.*running.*RETRY/,
      );
    });

    it("should not allow RETRY from COMPLETED", () => {
      const pipelineId: string = `pipeline-${String(createStableTestId("retry-from-completed").value)}`;
      const fsm: PipelineFSM = new PipelineFSM(pipelineId, P_COMPLETED);

      expect(() => fsm.transition("RETRY")).toThrow(
        /Invalid pipeline transition.*completed.*RETRY/,
      );
    });

    it("should allow full lifecycle after retry", () => {
      const pipelineId: string = `pipeline-${String(createStableTestId("retry-lifecycle").value)}`;
      const fsm: PipelineFSM = new PipelineFSM(pipelineId, P_FAILED);

      fsm.transition("RETRY");
      const s: PipelineStateId = fsm.transition("ALL_PASSED");
      expect(s).toBe(P_COMPLETED);
      expect(fsm.isTerminal()).toBe(true);
    });
  });

  // ── Invalid transitions ───────────────────────────────────────────

  describe("— invalid transitions", () => {
    it("should throw when COMPLETED receives RESUME", () => {
      const fsm: PipelineFSM = new PipelineFSM("pipeline-1", P_COMPLETED);

      expect(() => fsm.transition("RESUME")).toThrow(
        /Invalid pipeline transition.*completed.*RESUME/,
      );
    });

    it("should throw when PAUSED receives ALL_PASSED", () => {
      const fsm: PipelineFSM = new PipelineFSM("pipeline-1", P_PAUSED);

      expect(() => fsm.transition("ALL_PASSED")).toThrow(
        /Invalid pipeline transition/,
      );
    });

    it("should include the pipeline ID in the error message", () => {
      const fsm: PipelineFSM = new PipelineFSM("my-pipeline", P_COMPLETED);

      expect(() => fsm.transition("RESUME")).toThrow(/my-pipeline/);
    });
  });

  // ── canTransition ─────────────────────────────────────────────────

  describe("— canTransition", () => {
    it("should return true for valid transitions", () => {
      const fsm: PipelineFSM = new PipelineFSM("pipeline-1");

      expect(fsm.canTransition("ALL_PASSED")).toBe(true);
      expect(fsm.canTransition("NODE_PAUSED")).toBe(true);
    });

    it("should return false for invalid transitions", () => {
      const fsm: PipelineFSM = new PipelineFSM("pipeline-1");

      expect(fsm.canTransition("RESUME")).toBe(false);
    });
  });

  // ── createPipelineFSM factory ─────────────────────────────────────

  describe("— createPipelineFSM factory", () => {
    it.each<{ label: string; status: string; expectedState: PipelineStateId }>([
      { label: "running",   status: "running",   expectedState: P_RUNNING },
      { label: "paused",    status: "paused",    expectedState: P_PAUSED },
      { label: "completed", status: "completed", expectedState: P_COMPLETED },
      { label: "failed",    status: "failed",    expectedState: P_FAILED },
    ])("should create FSM from status '$label'", ({ status, expectedState }) => {
      const fsm: PipelineFSM = createPipelineFSM(
        "pipeline-1",
        status as import("../../src/types/Pipeline.js").PipelineStatus,
      );

      expect(fsm.getState()).toBe(expectedState);
    });

    it("should throw for unknown status", () => {
      expect(() =>
        createPipelineFSM(
          "pipeline-1",
          "invalid" as import("../../src/types/Pipeline.js").PipelineStatus,
        ),
      ).toThrow(/Unknown PipelineStatus/);
    });
  });
});
