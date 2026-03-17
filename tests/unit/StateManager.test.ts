import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "../../src/core/StateManager.js";
import type {
  PipelineState,
  NodeState,
  PipelineSummary,
} from "../../src/types/Pipeline.js";
import {
  createNodeState,
  createPipelineState,
  createStableTestId,
  deepFreeze,
} from "../utils/mock-data.js";

// ===========================================================================
// StateManager
// ===========================================================================

describe("StateManager", () => {
  let stateDir: string;
  let manager: StateManager;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "pf-state-test-"));
    manager = new StateManager(stateDir);
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  // ── save + load round-trip ────────────────────────────────────────

  describe("— save and load", () => {
    it("should persist and restore pipeline state as JSON", async () => {
      const pipelineId: string = `test-${String(createStableTestId("id").value)}`;
      const nodes: ReadonlyArray<NodeState> = [
        createNodeState({ id: "node-1", blueprint: "qa-review" }),
        createNodeState({ id: "node-2", blueprint: "type-review" }),
      ];
      const state: PipelineState = createPipelineState(nodes, {
        id: pipelineId,
      });

      await manager.save(state);
      const loaded: PipelineState = await manager.load(pipelineId);

      expect(loaded.id).toBe(pipelineId);
      expect(loaded.nodes).toHaveLength(2);
      expect(loaded.nodes[0]!.blueprint).toBe("qa-review");
      expect(loaded.nodes[1]!.blueprint).toBe("type-review");
    });

    it("should update the updated_at timestamp on save", async () => {
      const state: PipelineState = createPipelineState([], {
        id: "ts-test",
        updated_at: "2020-01-01T00:00:00.000Z",
      });

      await manager.save(state);
      const loaded: PipelineState = await manager.load("ts-test");

      expect(loaded.updated_at).not.toBe("2020-01-01T00:00:00.000Z");
    });

    it("should preserve all node state fields through round-trip", async () => {
      const node: NodeState = createNodeState({
        id: "impl-1",
        blueprint: "implement-ticket",
        instance: 1,
        status: "implementing",
        worktree_branch: "pf/abc/TICKET-001",
        worktree_path: "/tmp/pf-worktrees/abc/TICKET-001",
        dry_run_output: "proposed diff here",
        exit_code: 0,
        output: "implementation complete",
        rejection_count: 2,
      });
      const state: PipelineState = createPipelineState([node], {
        id: "field-test",
        review_timing: "both",
      });

      await manager.save(state);
      const loaded: PipelineState = await manager.load("field-test");

      const loadedNode: NodeState = loaded.nodes[0]!;
      expect(loadedNode.worktree_branch).toBe("pf/abc/TICKET-001");
      expect(loadedNode.worktree_path).toBe("/tmp/pf-worktrees/abc/TICKET-001");
      expect(loadedNode.dry_run_output).toBe("proposed diff here");
      expect(loadedNode.status).toBe("implementing");
      expect(loadedNode.rejection_count).toBe(2);
      expect(loaded.review_timing).toBe("both");
    });

    it("should throw when loading a non-existent pipeline", async () => {
      await expect(manager.load("nonexistent")).rejects.toThrow();
    });
  });

  // ── list ──────────────────────────────────────────────────────────

  describe("— list", () => {
    it("should return an empty array when no pipelines exist", async () => {
      const summaries: ReadonlyArray<PipelineSummary> = await manager.list();

      expect(summaries).toEqual([]);
    });

    it("should return summaries for all saved pipelines", async () => {
      const state1: PipelineState = createPipelineState([], {
        id: "pipeline-1",
        pipeline_name: "full-sdlc",
        feature: "auth feature",
      });
      const state2: PipelineState = createPipelineState([], {
        id: "pipeline-2",
        pipeline_name: "review-only",
        feature: "fix bug",
      });

      await manager.save(state1);
      await manager.save(state2);

      const summaries: ReadonlyArray<PipelineSummary> = await manager.list();

      expect(summaries).toHaveLength(2);

      const ids: ReadonlyArray<string> = summaries.map(
        (s: PipelineSummary): string => s.id,
      );
      expect(ids).toContain("pipeline-1");
      expect(ids).toContain("pipeline-2");
    });
  });

  // ── updateNode ────────────────────────────────────────────────────

  describe("— updateNode", () => {
    it("should return a new state with the target node updated", () => {
      const nodes: ReadonlyArray<NodeState> = [
        createNodeState({ id: "node-1", status: "pending" }),
        createNodeState({ id: "node-2", status: "pending" }),
      ];
      const state: PipelineState = createPipelineState(nodes);

      const updated: PipelineState = manager.updateNode(state, "node-1", {
        status: "running",
      });

      expect(updated.nodes[0]!.status).toBe("running");
      expect(updated.nodes[1]!.status).toBe("pending");
    });

    it("should not mutate the original state", () => {
      const nodes: ReadonlyArray<NodeState> = [
        createNodeState({ id: "node-1", status: "pending" }),
      ];
      const state: PipelineState = createPipelineState(nodes);
      const snapshotBefore: string = JSON.stringify(state);

      manager.updateNode(state, "node-1", { status: "running" });

      expect(JSON.stringify(state)).toBe(snapshotBefore);
    });

    it("should support updating worktree fields", () => {
      const nodes: ReadonlyArray<NodeState> = [
        createNodeState({ id: "impl-1", status: "running" }),
      ];
      const state: PipelineState = createPipelineState(nodes);

      const updated: PipelineState = manager.updateNode(state, "impl-1", {
        status: "implementing",
        worktree_branch: "pf/abc/TICKET-001",
        worktree_path: "/tmp/pf-worktrees/abc/TICKET-001",
      });

      expect(updated.nodes[0]!.worktree_branch).toBe("pf/abc/TICKET-001");
      expect(updated.nodes[0]!.worktree_path).toBe(
        "/tmp/pf-worktrees/abc/TICKET-001",
      );
    });

    it("should support updating dry_run_output", () => {
      const nodes: ReadonlyArray<NodeState> = [
        createNodeState({ id: "impl-1", status: "running" }),
      ];
      const state: PipelineState = createPipelineState(nodes);

      const updated: PipelineState = manager.updateNode(state, "impl-1", {
        status: "dry_run_complete",
        dry_run_output: "--- a/file.ts\n+++ b/file.ts\n@@ ...",
      });

      expect(updated.nodes[0]!.status).toBe("dry_run_complete");
      expect(updated.nodes[0]!.dry_run_output).toContain("file.ts");
    });
  });

  // ── resetFailedNodes ──────────────────────────────────────────────

  describe("— resetFailedNodes", () => {
    it("should reset all failed nodes to pending", () => {
      const nodeId1: string = `node-${String(createStableTestId("failed-1").value)}`;
      const nodeId2: string = `node-${String(createStableTestId("failed-2").value)}`;
      const nodeId3: string = `node-${String(createStableTestId("passed-1").value)}`;
      const pipelineId: string = `pipeline-${String(createStableTestId("retry-all").value)}`;
      const nodes: ReadonlyArray<NodeState> = [
        createNodeState({ id: nodeId1, status: "failed", exit_code: 1, output: "error" }),
        createNodeState({ id: nodeId2, status: "failed", exit_code: 1, output: "error" }),
        createNodeState({ id: nodeId3, status: "passed" }),
      ];
      const state: PipelineState = createPipelineState(nodes, {
        id: pipelineId,
        status: "failed",
      });

      const updated: PipelineState = manager.resetFailedNodes(state);

      expect(updated.status).toBe("running");
      expect(updated.nodes[0]!.status).toBe("pending");
      expect(updated.nodes[1]!.status).toBe("pending");
      expect(updated.nodes[2]!.status).toBe("passed");
    });

    it("should clear execution artifacts on reset nodes", () => {
      const nodeId: string = `node-${String(createStableTestId("artifacts").value)}`;
      const pipelineId: string = `pipeline-${String(createStableTestId("clear-artifacts").value)}`;
      const gateResult = deepFreeze({
        passed: false,
        type: "quality" as const,
        approved: 0,
        total: 1,
        details: "0/1 quality checks — GATE FAILED",
      });
      const nodes: ReadonlyArray<NodeState> = [
        createNodeState({
          id: nodeId,
          status: "failed",
          exit_code: 1,
          output: "API Error: 500",
          error: "transient failure",
          gate_result: gateResult,
          started_at: "2026-03-17T20:50:00.000Z",
          completed_at: "2026-03-17T20:52:00.000Z",
        }),
      ];
      const state: PipelineState = createPipelineState(nodes, {
        id: pipelineId,
        status: "failed",
      });

      const updated: PipelineState = manager.resetFailedNodes(state);
      const node: NodeState = updated.nodes[0]!;

      expect(node.status).toBe("pending");
      expect(node.exit_code).toBeNull();
      expect(node.output).toBeNull();
      expect(node.error).toBeNull();
      expect(node.gate_result).toBeNull();
      expect(node.started_at).toBeNull();
      expect(node.completed_at).toBeNull();
      expect(node.duration_ms).toBeNull();
      expect(node.container_id).toBeNull();
    });

    it("should preserve rejection_history for audit trail", () => {
      const nodeId: string = `node-${String(createStableTestId("history").value)}`;
      const pipelineId: string = `pipeline-${String(createStableTestId("preserve-history").value)}`;
      const rejectionRecord = deepFreeze({
        timestamp: "2026-03-17T20:52:00.000Z",
        feedback: "0/1 quality checks — GATE FAILED",
        routed_to: "none",
      });
      const nodes: ReadonlyArray<NodeState> = [
        createNodeState({
          id: nodeId,
          status: "failed",
          rejection_count: 1,
          rejection_history: [rejectionRecord],
        }),
      ];
      const state: PipelineState = createPipelineState(nodes, {
        id: pipelineId,
        status: "failed",
      });

      const updated: PipelineState = manager.resetFailedNodes(state);
      const node: NodeState = updated.nodes[0]!;

      expect(node.rejection_count).toBe(1);
      expect(node.rejection_history).toHaveLength(1);
    });

    it("should reset only the specified node when nodeId is provided", () => {
      const nodeId1: string = `node-${String(createStableTestId("specific-target").value)}`;
      const nodeId2: string = `node-${String(createStableTestId("specific-untouched").value)}`;
      const pipelineId: string = `pipeline-${String(createStableTestId("specific-retry").value)}`;
      const nodes: ReadonlyArray<NodeState> = [
        createNodeState({ id: nodeId1, status: "failed", output: "err1" }),
        createNodeState({ id: nodeId2, status: "failed", output: "err2" }),
      ];
      const state: PipelineState = createPipelineState(nodes, {
        id: pipelineId,
        status: "failed",
      });

      const updated: PipelineState = manager.resetFailedNodes(state, nodeId1);

      expect(updated.nodes[0]!.status).toBe("pending");
      expect(updated.nodes[0]!.output).toBeNull();
      expect(updated.nodes[1]!.status).toBe("failed");
      expect(updated.nodes[1]!.output).toBe("err2");
    });

    it("should set pipeline status to running", () => {
      const nodeId: string = `node-${String(createStableTestId("status-reset").value)}`;
      const pipelineId: string = `pipeline-${String(createStableTestId("status-running").value)}`;
      const nodes: ReadonlyArray<NodeState> = [
        createNodeState({ id: nodeId, status: "failed" }),
      ];
      const state: PipelineState = createPipelineState(nodes, {
        id: pipelineId,
        status: "failed",
      });

      const updated: PipelineState = manager.resetFailedNodes(state);

      expect(updated.status).toBe("running");
    });

    it("should not mutate the original state", () => {
      const nodeId: string = `node-${String(createStableTestId("immutability").value)}`;
      const pipelineId: string = `pipeline-${String(createStableTestId("immutability-check").value)}`;
      const nodes: ReadonlyArray<NodeState> = [
        createNodeState({ id: nodeId, status: "failed" }),
      ];
      const state: PipelineState = createPipelineState(nodes, {
        id: pipelineId,
        status: "failed",
      });
      const snapshotBefore: string = JSON.stringify(state);

      manager.resetFailedNodes(state);

      expect(JSON.stringify(state)).toBe(snapshotBefore);
    });
  });

  // ── recordRejection ───────────────────────────────────────────────

  describe("— recordRejection", () => {
    it("should increment rejection_count and append to rejection_history", () => {
      const nodes: ReadonlyArray<NodeState> = [
        createNodeState({ id: "impl-1", rejection_count: 0 }),
      ];
      const state: PipelineState = createPipelineState(nodes);
      const gateResult = {
        passed: false,
        type: "approval" as const,
        approved: 4,
        total: 6,
        details: "4/6 approvals — GATE FAILED (need 6)",
      };

      const updated: PipelineState = manager.recordRejection(
        state,
        "impl-1",
        gateResult,
        "implement-ticket",
      );

      const node: NodeState = updated.nodes[0]!;
      expect(node.rejection_count).toBe(1);
      expect(node.rejection_history).toHaveLength(1);
      expect(node.rejection_history[0]!.routed_to).toBe("implement-ticket");
      expect(node.rejection_history[0]!.feedback).toContain("GATE FAILED");
    });

    it("should set node status to failed", () => {
      const nodes: ReadonlyArray<NodeState> = [
        createNodeState({ id: "impl-1", status: "passed" }),
      ];
      const state: PipelineState = createPipelineState(nodes);
      const gateResult = {
        passed: false,
        type: "quality" as const,
        approved: 0,
        total: 1,
        details: "exit code 1",
      };

      const updated: PipelineState = manager.recordRejection(
        state,
        "impl-1",
        gateResult,
        undefined,
      );

      expect(updated.nodes[0]!.status).toBe("failed");
    });

    it("should not mutate the original state", () => {
      const nodes: ReadonlyArray<NodeState> = [
        createNodeState({ id: "impl-1" }),
      ];
      const state: PipelineState = createPipelineState(nodes);
      const snapshotBefore: string = JSON.stringify(state);
      const gateResult = {
        passed: false,
        type: "quality" as const,
        approved: 0,
        total: 1,
        details: "failed",
      };

      manager.recordRejection(state, "impl-1", gateResult, "upstream");

      expect(JSON.stringify(state)).toBe(snapshotBefore);
    });
  });
});
