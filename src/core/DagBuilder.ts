import type { Blueprint } from "@pftypes/Blueprint.ts";
import type { DagGraph, DagNode } from "@pftypes/Graph.ts";

// ── DAG Builder ─────────────────────────────────────────────────────
// Builds a directed acyclic graph from blueprint dependencies.

export class DagBuilder {
  /**
   * Build a DAG from a set of blueprints.
   * Each blueprint's `depends_on` field defines edges.
   * Parallel instances are expanded into individual nodes.
   *
   * @param blueprints - Map of blueprint name → definition
   * @param selectedNames - Which blueprints to include (from pipeline config)
   * @returns The built DAG
   * @throws Error if a cycle is detected or dependencies are missing
   */
  build(
    blueprints: ReadonlyMap<string, Blueprint>,
    selectedNames: ReadonlyArray<string>,
  ): DagGraph {
    // ── Validate dependencies exist ─────────────────────────────────
    for (const name of selectedNames) {
      const bp: Blueprint | undefined = blueprints.get(name);
      if (bp === undefined) {
        throw new Error(`Blueprint not found: ${name}`);
      }
      for (const dep of bp.depends_on) {
        if (!selectedNames.includes(dep)) {
          throw new Error(
            `Blueprint "${name}" depends on "${dep}" which is not in the pipeline`,
          );
        }
      }
    }

    // ── Build nodes (expand parallel instances) ─────────────────────
    const nodes: Map<string, DagNode> = new Map();
    const nodesByBlueprint: Map<string, string[]> = new Map();

    for (const name of selectedNames) {
      const bp: Blueprint = blueprints.get(name)!;
      const instances: number = bp.parallel.instances;
      const nodeIds: string[] = [];

      for (let i = 1; i <= instances; i++) {
        const id: string =
          instances === 1 ? name : `${name}-${String(i)}`;
        nodeIds.push(id);

        nodes.set(id, {
          id,
          blueprint: name,
          instance: i,
          dependencies: [],
          dependents: [],
        });
      }

      nodesByBlueprint.set(name, nodeIds);
    }

    // ── Wire dependencies ───────────────────────────────────────────
    // Each instance of a blueprint depends on ALL instances of its
    // dependency blueprints (fan-in pattern).
    for (const name of selectedNames) {
      const bp: Blueprint = blueprints.get(name)!;
      const myNodeIds: ReadonlyArray<string> =
        nodesByBlueprint.get(name) ?? [];

      for (const depName of bp.depends_on) {
        const depNodeIds: ReadonlyArray<string> =
          nodesByBlueprint.get(depName) ?? [];

        for (const myId of myNodeIds) {
          const myNode: DagNode = nodes.get(myId)!;
          const updatedDeps: string[] = [
            ...myNode.dependencies,
            ...depNodeIds,
          ];
          nodes.set(myId, { ...myNode, dependencies: updatedDeps });

          // Wire reverse (dependents)
          for (const depId of depNodeIds) {
            const depNode: DagNode = nodes.get(depId)!;
            const updatedDependents: string[] = [
              ...depNode.dependents,
              myId,
            ];
            nodes.set(depId, {
              ...depNode,
              dependents: updatedDependents,
            });
          }
        }
      }
    }

    // ── Topological sort (Kahn's algorithm) ─────────────────────────
    const topologicalOrder: string[] = [];
    const inDegree: Map<string, number> = new Map();

    for (const [id, node] of nodes) {
      inDegree.set(id, node.dependencies.length);
    }

    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) {
        queue.push(id);
      }
    }

    while (queue.length > 0) {
      const id: string = queue.shift()!;
      topologicalOrder.push(id);
      const node: DagNode = nodes.get(id)!;

      for (const depId of node.dependents) {
        const currentDegree: number = inDegree.get(depId)!;
        const newDegree: number = currentDegree - 1;
        inDegree.set(depId, newDegree);
        if (newDegree === 0) {
          queue.push(depId);
        }
      }
    }

    if (topologicalOrder.length !== nodes.size) {
      throw new Error(
        "Cycle detected in blueprint dependencies. " +
          `Sorted ${String(topologicalOrder.length)} of ${String(nodes.size)} nodes.`,
      );
    }

    // ── Compute parallel groups ─────────────────────────────────────
    const parallelGroups: string[][] = this.computeParallelGroups(
      nodes,
      topologicalOrder,
    );

    return {
      nodes,
      topological_order: topologicalOrder,
      parallel_groups: parallelGroups,
    };
  }

  /**
   * Compute groups of nodes that can execute in parallel.
   * Nodes in the same group have no dependencies on each other.
   */
  private computeParallelGroups(
    nodes: ReadonlyMap<string, DagNode>,
    topologicalOrder: ReadonlyArray<string>,
  ): string[][] {
    const levels: Map<string, number> = new Map();

    for (const id of topologicalOrder) {
      const node: DagNode = nodes.get(id)!;
      let maxDepLevel = -1;

      for (const depId of node.dependencies) {
        const depLevel: number = levels.get(depId) ?? 0;
        if (depLevel > maxDepLevel) {
          maxDepLevel = depLevel;
        }
      }

      levels.set(id, maxDepLevel + 1);
    }

    const groupMap: Map<number, string[]> = new Map();
    for (const [id, level] of levels) {
      const existing: string[] | undefined = groupMap.get(level);
      if (existing !== undefined) {
        existing.push(id);
      } else {
        groupMap.set(level, [id]);
      }
    }

    const sortedLevels: number[] = Array.from(groupMap.keys()).sort(
      (a: number, b: number): number => a - b,
    );

    return sortedLevels.map(
      (level: number): string[] => groupMap.get(level)!,
    );
  }
}
