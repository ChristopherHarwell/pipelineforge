import { describe, it, expect } from "vitest";
import {
  NodeFSM,
  createNodeFSM,
  PENDING,
  READY,
  RUNNING,
  DRY_RUN_COMPLETE,
  AWAITING_PROPOSAL_REVIEW,
  IMPLEMENTING,
  AWAITING_IMPLEMENTATION_REVIEW,
  PASSED,
  FAILED,
  SKIPPED,
  AWAITING_HUMAN,
} from "@core/NodeFSM.ts";
import type { StateId, TransitionEvent } from "@core/NodeFSM.ts";
import { createStableTestId } from "../utils/mock-data.js";

// ===========================================================================
// NodeFSM
// ===========================================================================

describe("NodeFSM", () => {
  // ── Initial state ─────────────────────────────────────────────────

  describe("— initial state", () => {
    it("should default to PENDING (0x0)", () => {
      const nodeId: string = `node-${String(createStableTestId("id").value)}`;
      const fsm: NodeFSM = new NodeFSM(nodeId);

      expect(fsm.getState()).toBe(PENDING);
      expect(fsm.getStateName()).toBe("pending");
    });

    it("should accept a custom initial state", () => {
      const fsm: NodeFSM = new NodeFSM("node-1", RUNNING);

      expect(fsm.getState()).toBe(RUNNING);
      expect(fsm.getStateName()).toBe("running");
    });
  });

  // ── Standard lifecycle ────────────────────────────────────────────

  describe("— standard lifecycle (no review mode)", () => {
    it("should walk PENDING → READY → RUNNING → PASSED", () => {
      const fsm: NodeFSM = new NodeFSM("node-1");

      const s1: StateId = fsm.transition("DEPS_SATISFIED");
      expect(s1).toBe(READY);

      const s2: StateId = fsm.transition("DISPATCH");
      expect(s2).toBe(RUNNING);

      const s3: StateId = fsm.transition("GATE_PASSED");
      expect(s3).toBe(PASSED);

      expect(fsm.isTerminal()).toBe(true);
    });

    it("should walk PENDING → READY → RUNNING → FAILED", () => {
      const fsm: NodeFSM = new NodeFSM("node-1");

      fsm.transition("DEPS_SATISFIED");
      fsm.transition("DISPATCH");

      const s3: StateId = fsm.transition("GATE_FAILED");
      expect(s3).toBe(FAILED);

      expect(fsm.isTerminal()).toBe(true);
    });
  });

  // ── Review mode lifecycle ─────────────────────────────────────────

  describe("— review mode lifecycle", () => {
    it("should walk the full dry-run → propose → implement → approve path", () => {
      const fsm: NodeFSM = new NodeFSM("impl-1");

      fsm.transition("DEPS_SATISFIED");
      fsm.transition("DISPATCH");

      // Phase 1: dry-run
      const s1: StateId = fsm.transition("DRY_RUN_DONE");
      expect(s1).toBe(DRY_RUN_COMPLETE);

      // Phase 2: present proposal for human review
      const s2: StateId = fsm.transition("PRESENT_PROPOSAL");
      expect(s2).toBe(AWAITING_PROPOSAL_REVIEW);
      expect(fsm.isPaused()).toBe(true);

      // Phase 3: proposal approved → implementing
      const s3: StateId = fsm.transition("PROPOSAL_APPROVED");
      expect(s3).toBe(IMPLEMENTING);
      expect(fsm.isPaused()).toBe(false);

      // Phase 4: implementation done → awaiting review
      const s4: StateId = fsm.transition("IMPLEMENTATION_DONE");
      expect(s4).toBe(AWAITING_IMPLEMENTATION_REVIEW);
      expect(fsm.isPaused()).toBe(true);

      // Phase 5: implementation approved
      const s5: StateId = fsm.transition("IMPL_APPROVED");
      expect(s5).toBe(PASSED);
      expect(fsm.isTerminal()).toBe(true);
    });

    it("should return to RUNNING on proposal rejection", () => {
      const fsm: NodeFSM = new NodeFSM("impl-1");
      fsm.transition("DEPS_SATISFIED");
      fsm.transition("DISPATCH");
      fsm.transition("DRY_RUN_DONE");
      fsm.transition("PRESENT_PROPOSAL");

      const s: StateId = fsm.transition("PROPOSAL_REJECTED");
      expect(s).toBe(RUNNING);

      // Can retry the dry-run
      expect(fsm.canTransition("DRY_RUN_DONE")).toBe(true);
    });

    it("should return to RUNNING on implementation rejection", () => {
      const fsm: NodeFSM = new NodeFSM("impl-1");
      fsm.transition("DEPS_SATISFIED");
      fsm.transition("DISPATCH");
      fsm.transition("DRY_RUN_DONE");
      fsm.transition("PRESENT_PROPOSAL");
      fsm.transition("PROPOSAL_APPROVED");
      fsm.transition("IMPLEMENTATION_DONE");

      const s: StateId = fsm.transition("IMPL_REJECTED");
      expect(s).toBe(RUNNING);

      // Full review cycle can restart
      expect(fsm.canTransition("DRY_RUN_DONE")).toBe(true);
    });
  });

  // ── Human gate ────────────────────────────────────────────────────

  describe("— human gate", () => {
    it("should transition RUNNING → AWAITING_HUMAN on HUMAN_GATE event", () => {
      const fsm: NodeFSM = new NodeFSM("node-1");
      fsm.transition("DEPS_SATISFIED");
      fsm.transition("DISPATCH");

      const s: StateId = fsm.transition("HUMAN_GATE");
      expect(s).toBe(AWAITING_HUMAN);
      expect(fsm.isPaused()).toBe(true);
    });

    it("should transition AWAITING_HUMAN → PASSED on approval", () => {
      const fsm: NodeFSM = new NodeFSM("node-1", AWAITING_HUMAN);

      const s: StateId = fsm.transition("HUMAN_APPROVED");
      expect(s).toBe(PASSED);
    });

    it("should transition AWAITING_HUMAN → FAILED on rejection", () => {
      const fsm: NodeFSM = new NodeFSM("node-1", AWAITING_HUMAN);

      const s: StateId = fsm.transition("HUMAN_REJECTED");
      expect(s).toBe(FAILED);
    });
  });

  // ── SKIP event ────────────────────────────────────────────────────

  describe("— SKIP event", () => {
    it.each<{ label: string; initialState: StateId }>([
      { label: "PENDING (0x0)",                      initialState: PENDING },
      { label: "READY (0x1)",                        initialState: READY },
      { label: "RUNNING (0x2)",                      initialState: RUNNING },
      { label: "DRY_RUN_COMPLETE (0x3)",             initialState: DRY_RUN_COMPLETE },
      { label: "AWAITING_PROPOSAL_REVIEW (0x4)",     initialState: AWAITING_PROPOSAL_REVIEW },
      { label: "IMPLEMENTING (0x5)",                 initialState: IMPLEMENTING },
      { label: "AWAITING_IMPLEMENTATION_REVIEW (0x6)", initialState: AWAITING_IMPLEMENTATION_REVIEW },
      { label: "AWAITING_HUMAN (0xA)",               initialState: AWAITING_HUMAN },
    ])("should allow SKIP from $label", ({ initialState }) => {
      const fsm: NodeFSM = new NodeFSM("node-1", initialState);

      const s: StateId = fsm.transition("SKIP");
      expect(s).toBe(SKIPPED);
      expect(fsm.isTerminal()).toBe(true);
    });
  });

  // ── Retry from failed ────────────────────────────────────────────

  describe("— retry from failed", () => {
    it("should transition FAILED → PENDING on RETRY event", () => {
      const nodeId: string = `node-${String(createStableTestId("retry-basic").value)}`;
      const fsm: NodeFSM = new NodeFSM(nodeId, FAILED);

      const s: StateId = fsm.transition("RETRY");
      expect(s).toBe(PENDING);
      expect(fsm.isTerminal()).toBe(false);
    });

    it("should allow a full lifecycle after retry", () => {
      const nodeId: string = `node-${String(createStableTestId("retry-lifecycle").value)}`;
      const fsm: NodeFSM = new NodeFSM(nodeId, FAILED);

      fsm.transition("RETRY");
      fsm.transition("DEPS_SATISFIED");
      fsm.transition("DISPATCH");

      const s: StateId = fsm.transition("GATE_PASSED");
      expect(s).toBe(PASSED);
      expect(fsm.isTerminal()).toBe(true);
    });

    it("should not allow RETRY from PASSED", () => {
      const nodeId: string = `node-${String(createStableTestId("retry-from-passed").value)}`;
      const fsm: NodeFSM = new NodeFSM(nodeId, PASSED);

      expect(() => fsm.transition("RETRY")).toThrow(
        /Invalid transition.*passed.*RETRY/,
      );
    });

    it("should not allow RETRY from RUNNING", () => {
      const nodeId: string = `node-${String(createStableTestId("retry-from-running").value)}`;
      const fsm: NodeFSM = new NodeFSM(nodeId, RUNNING);

      expect(() => fsm.transition("RETRY")).toThrow(
        /Invalid transition.*running.*RETRY/,
      );
    });
  });

  // ── Invalid transitions ───────────────────────────────────────────

  describe("— invalid transitions", () => {
    it("should throw when transitioning from a terminal state", () => {
      const fsm: NodeFSM = new NodeFSM("node-1", PASSED);

      expect(() => fsm.transition("DISPATCH")).toThrow(
        /Invalid transition.*passed.*DISPATCH/,
      );
    });

    it("should throw when PENDING receives DISPATCH (must go through READY first)", () => {
      const fsm: NodeFSM = new NodeFSM("node-1");

      expect(() => fsm.transition("DISPATCH")).toThrow(
        /Invalid transition.*pending.*DISPATCH/,
      );
    });

    it("should throw when RUNNING receives PROPOSAL_APPROVED (must go through dry-run first)", () => {
      const fsm: NodeFSM = new NodeFSM("node-1", RUNNING);

      expect(() => fsm.transition("PROPOSAL_APPROVED")).toThrow(
        /Invalid transition.*running.*PROPOSAL_APPROVED/,
      );
    });

    it("should include the node ID in the error message", () => {
      const fsm: NodeFSM = new NodeFSM("qa-review-3", PASSED);

      expect(() => fsm.transition("DISPATCH")).toThrow(/qa-review-3/);
    });
  });

  // ── canTransition ─────────────────────────────────────────────────

  describe("— canTransition", () => {
    it("should return true for valid transitions", () => {
      const fsm: NodeFSM = new NodeFSM("node-1");

      expect(fsm.canTransition("DEPS_SATISFIED")).toBe(true);
    });

    it("should return false for invalid transitions", () => {
      const fsm: NodeFSM = new NodeFSM("node-1");

      expect(fsm.canTransition("GATE_PASSED")).toBe(false);
    });
  });

  // ── createNodeFSM factory ─────────────────────────────────────────

  describe("— createNodeFSM factory", () => {
    it.each<{ label: string; status: string; expectedState: StateId }>([
      { label: "pending",                       status: "pending",                       expectedState: PENDING },
      { label: "running",                       status: "running",                       expectedState: RUNNING },
      { label: "implementing",                  status: "implementing",                  expectedState: IMPLEMENTING },
      { label: "awaiting_implementation_review", status: "awaiting_implementation_review", expectedState: AWAITING_IMPLEMENTATION_REVIEW },
      { label: "passed",                        status: "passed",                        expectedState: PASSED },
      { label: "failed",                        status: "failed",                        expectedState: FAILED },
    ])("should create FSM from status '$label'", ({ status, expectedState }) => {
      const fsm: NodeFSM = createNodeFSM(
        "node-1",
        status as import("@pftypes/Pipeline.ts").NodeStatus,
      );

      expect(fsm.getState()).toBe(expectedState);
    });

    it("should throw for unknown status", () => {
      expect(() =>
        createNodeFSM("node-1", "invalid" as import("@pftypes/Pipeline.ts").NodeStatus),
      ).toThrow(/Unknown NodeStatus/);
    });
  });

  // ── Terminal and pause state checks ───────────────────────────────

  describe("— isTerminal", () => {
    it.each<{ label: string; state: StateId; expected: boolean }>([
      { label: "PASSED",  state: PASSED,  expected: true },
      { label: "FAILED",  state: FAILED,  expected: true },
      { label: "SKIPPED", state: SKIPPED, expected: true },
      { label: "PENDING", state: PENDING, expected: false },
      { label: "RUNNING", state: RUNNING, expected: false },
    ])("should return $expected for $label", ({ state, expected }) => {
      const fsm: NodeFSM = new NodeFSM("node-1", state);

      expect(fsm.isTerminal()).toBe(expected);
    });
  });

  describe("— isPaused", () => {
    it.each<{ label: string; state: StateId; expected: boolean }>([
      { label: "AWAITING_PROPOSAL_REVIEW",      state: AWAITING_PROPOSAL_REVIEW,      expected: true },
      { label: "AWAITING_IMPLEMENTATION_REVIEW", state: AWAITING_IMPLEMENTATION_REVIEW, expected: true },
      { label: "AWAITING_HUMAN",                state: AWAITING_HUMAN,                expected: true },
      { label: "RUNNING",                       state: RUNNING,                       expected: false },
      { label: "PASSED",                        state: PASSED,                        expected: false },
    ])("should return $expected for $label", ({ state, expected }) => {
      const fsm: NodeFSM = new NodeFSM("node-1", state);

      expect(fsm.isPaused()).toBe(expected);
    });
  });
});
