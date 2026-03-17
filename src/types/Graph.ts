// ── DAG Graph Types ─────────────────────────────────────────────────

export interface DagNode {
  readonly id: string;
  readonly blueprint: string;
  readonly instance: number;
  readonly dependencies: ReadonlyArray<string>;
  readonly dependents: ReadonlyArray<string>;
}

export interface DagGraph {
  readonly nodes: ReadonlyMap<string, DagNode>;
  readonly topological_order: ReadonlyArray<string>;
  readonly parallel_groups: ReadonlyArray<ReadonlyArray<string>>;
}
