import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileAsync: typeof execFile.__promisify__ = promisify(execFile);

// ── Worktree Config ─────────────────────────────────────────────────

export interface WorktreeConfig {
  readonly repoDir: string;
  readonly pipelineId: string;
}

// ── Worktree Info ───────────────────────────────────────────────────

export interface WorktreeInfo {
  readonly branchName: string;
  readonly worktreePath: string;
  readonly baseBranch: string;
}

// ── Merge Result ────────────────────────────────────────────────────

export type MergeResult =
  | { readonly status: "merged" }
  | { readonly status: "conflict"; readonly conflictFiles: ReadonlyArray<string> };

// ── Worktree Manager ────────────────────────────────────────────────
// Manages git worktree lifecycle for isolated implementation execution.
// Each implementation step runs in its own worktree so changes are
// never written directly to the main branch.

export class WorktreeManager {
  private readonly config: WorktreeConfig;
  private readonly activeWorktrees: Map<string, WorktreeInfo> = new Map();

  constructor(config: WorktreeConfig) {
    this.config = config;
  }

  /**
   * Create a git worktree for an implementation step.
   * The worktree directory is bind-mounted into Docker containers
   * instead of the main repo.
   *
   * @param nodeId - The DAG node ID (e.g., "implement-ticket-1")
   * @param ticketId - The ticket being implemented (e.g., "TICKET-001")
   * @param baseBranch - Branch to base the worktree on (default: "main")
   * @returns WorktreeInfo with paths for Docker bind-mounting
   */
  async create(
    nodeId: string,
    ticketId: string,
    baseBranch: string = "main",
  ): Promise<WorktreeInfo> {
    const branchName: string =
      `pf/${this.config.pipelineId}/${ticketId}`;
    const worktreePath: string = join(
      "/tmp/pf-worktrees",
      this.config.pipelineId,
      ticketId,
    );

    await execFileAsync("git", [
      "-C",
      this.config.repoDir,
      "worktree",
      "add",
      "-b",
      branchName,
      worktreePath,
      baseBranch,
    ]);

    const info: WorktreeInfo = Object.freeze({
      branchName,
      worktreePath,
      baseBranch,
    });

    this.activeWorktrees.set(nodeId, info);
    return info;
  }

  /**
   * Get the worktree info for a node.
   *
   * @param nodeId - The DAG node ID
   * @returns WorktreeInfo if a worktree exists for this node, undefined otherwise
   */
  get(nodeId: string): WorktreeInfo | undefined {
    return this.activeWorktrees.get(nodeId);
  }

  /**
   * Get the count of active worktrees.
   */
  get size(): number {
    return this.activeWorktrees.size;
  }

  /**
   * Merge a worktree branch into the base branch.
   * Called after human approval of the implementation.
   *
   * @param nodeId - The DAG node ID
   * @returns MergeResult indicating success or conflict
   * @throws Error if no worktree exists for the node
   */
  async merge(nodeId: string): Promise<MergeResult> {
    const info: WorktreeInfo | undefined = this.activeWorktrees.get(nodeId);
    if (info === undefined) {
      throw new Error(`No worktree found for node: ${nodeId}`);
    }

    try {
      await execFileAsync("git", [
        "-C",
        this.config.repoDir,
        "merge",
        info.branchName,
        "--no-ff",
        "-m",
        `Merge ${info.branchName} into ${info.baseBranch}`,
      ]);

      await this.cleanup(nodeId);

      return { status: "merged" };
    } catch {
      // Check for merge conflicts
      const { stdout: conflictOutput } = await execFileAsync("git", [
        "-C",
        this.config.repoDir,
        "diff",
        "--name-only",
        "--diff-filter=U",
      ]);

      const conflictFiles: ReadonlyArray<string> = conflictOutput
        .trim()
        .split("\n")
        .filter(Boolean);

      // Abort the failed merge
      await execFileAsync("git", [
        "-C",
        this.config.repoDir,
        "merge",
        "--abort",
      ]);

      return { status: "conflict", conflictFiles };
    }
  }

  /**
   * Delete a worktree and its branch. Called on rejection or after merge.
   *
   * @param nodeId - The DAG node ID
   */
  async cleanup(nodeId: string): Promise<void> {
    const info: WorktreeInfo | undefined = this.activeWorktrees.get(nodeId);
    if (info === undefined) {
      return;
    }

    try {
      await execFileAsync("git", [
        "-C",
        this.config.repoDir,
        "worktree",
        "remove",
        "--force",
        info.worktreePath,
      ]);
    } catch {
      // Worktree may already be removed
    }

    try {
      await execFileAsync("git", [
        "-C",
        this.config.repoDir,
        "branch",
        "-D",
        info.branchName,
      ]);
    } catch {
      // Branch may already be deleted
    }

    this.activeWorktrees.delete(nodeId);
  }

  /**
   * Clean up all active worktrees (abort scenario).
   */
  async cleanupAll(): Promise<void> {
    const cleanups: ReadonlyArray<Promise<void>> = Array.from(
      this.activeWorktrees.keys(),
    ).map((nodeId: string): Promise<void> => this.cleanup(nodeId));

    await Promise.allSettled(cleanups);
    this.activeWorktrees.clear();
  }
}
