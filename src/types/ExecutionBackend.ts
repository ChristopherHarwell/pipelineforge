import type { Blueprint } from "@pftypes/Blueprint.ts";
import type { DagNode } from "@pftypes/Graph.ts";
import type { ContainerResult } from "@pftypes/Pipeline.ts";

// ── Spawn Options ───────────────────────────────────────────────────
// Shared spawn configuration used by all execution backends.

export interface SpawnOptions {
  readonly node: DagNode;
  readonly blueprint: Blueprint;
  readonly prompt: string;
  readonly worktreePath?: string;
  readonly dryRun?: boolean;
}

// ── Execution Backend Interface ─────────────────────────────────────
// Abstraction over the execution layer. Production uses DockerManager
// (direct Docker API) or ProxySessionManager (OpenClaw proxy gateway).
// Tests can provide a mock implementation.

export interface ExecutionBackend {
  /**
   * Spawn an execution unit (container or session) for a blueprint node.
   *
   * @param options - Spawn configuration including node, blueprint, prompt, and optional worktree/dry-run flags
   * @returns Execution result (stdout, stderr, exit code, duration)
   */
  readonly spawnContainer: (options: SpawnOptions) => Promise<ContainerResult>;

  /**
   * Kill all active execution units (cleanup on pipeline abort).
   */
  readonly killAll: () => Promise<void>;
}
