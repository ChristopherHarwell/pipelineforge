import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorktreeManager } from "../../src/core/WorktreeManager.js";
import type {
  WorktreeConfig,
  WorktreeInfo,
  MergeResult,
} from "../../src/core/WorktreeManager.js";
import { createStableTestId } from "../utils/mock-data.js";

// ===========================================================================
// WorktreeManager
// ===========================================================================

// ── Mock child_process ──────────────────────────────────────────────

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("node:util", () => ({
  promisify: (_fn: unknown) => execFileMock,
}));

// ── Test Helpers ────────────────────────────────────────────────────

function createConfig(overrides?: Partial<WorktreeConfig>): WorktreeConfig {
  return {
    repoDir: "/projects/my-repo",
    pipelineId: `pf-${String(createStableTestId("pipelineId").value)}`,
    ...overrides,
  };
}

describe("WorktreeManager", () => {
  const pipelineId: string = "abc-123";
  let manager: WorktreeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    execFileMock.mockResolvedValue({ stdout: "", stderr: "" });
    manager = new WorktreeManager(createConfig({ pipelineId }));
  });

  // ── create ────────────────────────────────────────────────────────

  describe("— create", () => {
    it("should produce a branch name following the pf/<pipelineId>/<ticketId> convention", async () => {
      const ticketId: string = `TICKET-${String(createStableTestId("ticket").value)}`;

      const info: WorktreeInfo = await manager.create(
        "implement-ticket-1",
        ticketId,
      );

      expect(info.branchName).toBe(`pf/${pipelineId}/${ticketId}`);
    });

    it("should place the worktree under /tmp/pf-worktrees/<pipelineId>/<ticketId>", async () => {
      const info: WorktreeInfo = await manager.create(
        "node-1",
        "TICKET-001",
      );

      expect(info.worktreePath).toBe(
        `/tmp/pf-worktrees/${pipelineId}/TICKET-001`,
      );
    });

    it.each<{ label: string; baseBranch: string | undefined; expected: string }>([
      { label: "defaults to main when no base branch specified", baseBranch: undefined, expected: "main" },
      { label: "uses custom base branch when specified", baseBranch: "develop", expected: "develop" },
      { label: "uses release branch when specified", baseBranch: "release/v2", expected: "release/v2" },
    ])("should use baseBranch: $label", async ({ baseBranch, expected }) => {
      const info: WorktreeInfo = await manager.create(
        "node-1",
        "TICKET-001",
        baseBranch,
      );

      expect(info.baseBranch).toBe(expected);
      expect(execFileMock).toHaveBeenCalledWith(
        "git",
        expect.arrayContaining([expected]),
      );
    });

    it("should call git worktree add with -b flag for new branch creation", async () => {
      await manager.create("node-1", "TICKET-002", "develop");

      expect(execFileMock).toHaveBeenCalledWith("git", [
        "-C",
        "/projects/my-repo",
        "worktree",
        "add",
        "-b",
        `pf/${pipelineId}/TICKET-002`,
        `/tmp/pf-worktrees/${pipelineId}/TICKET-002`,
        "develop",
      ]);
    });

    it("should freeze the returned WorktreeInfo to enforce immutability", async () => {
      const info: WorktreeInfo = await manager.create("node-1", "TICKET-001");

      expect(Object.isFrozen(info)).toBe(true);
    });

    it("should track the worktree in the active map", async () => {
      expect(manager.size).toBe(0);

      await manager.create("node-1", "TICKET-001");

      expect(manager.size).toBe(1);
      expect(manager.get("node-1")).toBeDefined();
    });
  });

  // ── get ───────────────────────────────────────────────────────────

  describe("— get", () => {
    it("should return undefined for an untracked node", () => {
      const result: WorktreeInfo | undefined = manager.get("nonexistent");

      expect(result).toBeUndefined();
    });

    it("should return the correct WorktreeInfo for a tracked node", async () => {
      const ticketId: string = "TICKET-001";
      await manager.create("node-1", ticketId);

      const info: WorktreeInfo | undefined = manager.get("node-1");

      expect(info).toBeDefined();
      expect(info!.branchName).toBe(`pf/${pipelineId}/${ticketId}`);
      expect(info!.worktreePath).toBe(
        `/tmp/pf-worktrees/${pipelineId}/${ticketId}`,
      );
    });
  });

  // ── merge ─────────────────────────────────────────────────────────

  describe("— merge", () => {
    it("should throw when no worktree exists for the node", async () => {
      await expect(manager.merge("nonexistent")).rejects.toThrow(
        /No worktree found for node: nonexistent/,
      );
    });

    it("should call git merge with --no-ff and a descriptive message", async () => {
      await manager.create("node-1", "TICKET-001");

      await manager.merge("node-1");

      expect(execFileMock).toHaveBeenCalledWith("git", [
        "-C",
        "/projects/my-repo",
        "merge",
        `pf/${pipelineId}/TICKET-001`,
        "--no-ff",
        "-m",
        `Merge pf/${pipelineId}/TICKET-001 into main`,
      ]);
    });

    it("should return { status: 'merged' } on success", async () => {
      await manager.create("node-1", "TICKET-001");

      const result: MergeResult = await manager.merge("node-1");

      expect(result.status).toBe("merged");
    });

    it("should remove the worktree from the active map after successful merge", async () => {
      await manager.create("node-1", "TICKET-001");

      await manager.merge("node-1");

      expect(manager.size).toBe(0);
      expect(manager.get("node-1")).toBeUndefined();
    });

    it("should return { status: 'conflict' } with file list on merge failure", async () => {
      await manager.create("node-1", "TICKET-001");

      execFileMock.mockImplementation(
        (_cmd: string, args: ReadonlyArray<string>) => {
          if (
            args.includes("merge") &&
            !args.includes("--abort") &&
            args.includes("--no-ff")
          ) {
            return Promise.reject(new Error("merge conflict"));
          }
          if (args.includes("--diff-filter=U")) {
            return Promise.resolve({
              stdout: "src/index.ts\nsrc/app.ts\n",
              stderr: "",
            });
          }
          return Promise.resolve({ stdout: "", stderr: "" });
        },
      );

      const result: MergeResult = await manager.merge("node-1");

      expect(result.status).toBe("conflict");
      if (result.status === "conflict") {
        expect(result.conflictFiles).toEqual(["src/index.ts", "src/app.ts"]);
      }
    });

    it("should abort the merge after detecting conflicts", async () => {
      await manager.create("node-1", "TICKET-001");

      execFileMock.mockImplementation(
        (_cmd: string, args: ReadonlyArray<string>) => {
          if (
            args.includes("merge") &&
            !args.includes("--abort") &&
            args.includes("--no-ff")
          ) {
            return Promise.reject(new Error("conflict"));
          }
          if (args.includes("--diff-filter=U")) {
            return Promise.resolve({ stdout: "file.ts\n", stderr: "" });
          }
          return Promise.resolve({ stdout: "", stderr: "" });
        },
      );

      await manager.merge("node-1");

      expect(execFileMock).toHaveBeenCalledWith("git", [
        "-C",
        "/projects/my-repo",
        "merge",
        "--abort",
      ]);
    });
  });

  // ── cleanup ───────────────────────────────────────────────────────

  describe("— cleanup", () => {
    it("should be a no-op for an untracked node", async () => {
      await manager.cleanup("nonexistent");

      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("should remove the worktree directory via git worktree remove", async () => {
      await manager.create("node-1", "TICKET-001");
      vi.clearAllMocks();
      execFileMock.mockResolvedValue({ stdout: "", stderr: "" });

      await manager.cleanup("node-1");

      expect(execFileMock).toHaveBeenCalledWith("git", [
        "-C",
        "/projects/my-repo",
        "worktree",
        "remove",
        "--force",
        `/tmp/pf-worktrees/${pipelineId}/TICKET-001`,
      ]);
    });

    it("should delete the branch via git branch -D", async () => {
      await manager.create("node-1", "TICKET-001");
      vi.clearAllMocks();
      execFileMock.mockResolvedValue({ stdout: "", stderr: "" });

      await manager.cleanup("node-1");

      expect(execFileMock).toHaveBeenCalledWith("git", [
        "-C",
        "/projects/my-repo",
        "branch",
        "-D",
        `pf/${pipelineId}/TICKET-001`,
      ]);
    });

    it("should remove the node from the active worktrees map", async () => {
      await manager.create("node-1", "TICKET-001");

      await manager.cleanup("node-1");

      expect(manager.size).toBe(0);
    });

    it("should not throw when git worktree remove fails", async () => {
      await manager.create("node-1", "TICKET-001");
      vi.clearAllMocks();

      let callIndex: number = 0;
      execFileMock.mockImplementation(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.reject(new Error("worktree already removed"));
        }
        return Promise.resolve({ stdout: "", stderr: "" });
      });

      await expect(manager.cleanup("node-1")).resolves.toBeUndefined();
    });
  });

  // ── cleanupAll ────────────────────────────────────────────────────

  describe("— cleanupAll", () => {
    it("should clean up all active worktrees", async () => {
      await manager.create("node-1", "TICKET-001");
      await manager.create("node-2", "TICKET-002");
      await manager.create("node-3", "TICKET-003");

      expect(manager.size).toBe(3);

      await manager.cleanupAll();

      expect(manager.size).toBe(0);
    });

    it("should be a no-op when no worktrees are active", async () => {
      expect(manager.size).toBe(0);

      await manager.cleanupAll();

      expect(manager.size).toBe(0);
    });
  });
});
