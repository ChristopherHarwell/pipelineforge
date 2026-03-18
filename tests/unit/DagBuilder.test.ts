import { describe, it, expect } from "vitest";
import { DagBuilder } from "../../src/core/DagBuilder.js";
import type { Blueprint } from "../../src/types/Blueprint.js";
import type { DagGraph } from "../../src/types/Graph.js";

// ===========================================================================
// DagBuilder
// ===========================================================================

// ── Test Helpers ────────────────────────────────────────────────────

function createBlueprint(
  overrides: Partial<Blueprint> & { readonly name: string },
): Blueprint {
  return {
    description: "test blueprint",
    skill_path: "~/.claude/skills/test/SKILL.md",
    execution: {
      prompt_template: "test",
      model: "sonnet",
      max_turns: 50,
      timeout_minutes: 10,
      allowed_tools: ["Read"],
      output_format: "json",
    },
    parallel: { instances: 1, naming: "{name}-{i}" },
    depends_on: [],
    gate: { type: "quality" },
    outputs: {},
    review_mode: { enabled: false, dry_run_disallowed_tools: ["Edit", "Write", "NotebookEdit"] },
    requires_repo: true,
    ...overrides,
  };
}

describe("DagBuilder", () => {
  const builder: DagBuilder = new DagBuilder();

  // ── Linear chain ────────────────────────────────────────────────────

  describe("— linear chain", () => {
    it("should build a simple A → B → C chain", () => {
      const blueprints: Map<string, Blueprint> = new Map([
        ["a", createBlueprint({ name: "a" })],
        ["b", createBlueprint({ name: "b", depends_on: ["a"] })],
        ["c", createBlueprint({ name: "c", depends_on: ["b"] })],
      ]);

      const graph: DagGraph = builder.build(blueprints, ["a", "b", "c"]);

      expect(graph.topological_order).toEqual(["a", "b", "c"]);
      expect(graph.nodes.size).toBe(3);
    });

    it("should compute 3 sequential parallel groups", () => {
      const blueprints: Map<string, Blueprint> = new Map([
        ["a", createBlueprint({ name: "a" })],
        ["b", createBlueprint({ name: "b", depends_on: ["a"] })],
        ["c", createBlueprint({ name: "c", depends_on: ["b"] })],
      ]);

      const graph: DagGraph = builder.build(blueprints, ["a", "b", "c"]);

      expect(graph.parallel_groups).toEqual([["a"], ["b"], ["c"]]);
    });
  });

  // ── Parallel fan-out ────────────────────────────────────────────────

  describe("— parallel fan-out", () => {
    it("should group independent nodes together", () => {
      const blueprints: Map<string, Blueprint> = new Map([
        ["root", createBlueprint({ name: "root" })],
        ["qa", createBlueprint({ name: "qa", depends_on: ["root"] })],
        ["type", createBlueprint({ name: "type", depends_on: ["root"] })],
        ["sec", createBlueprint({ name: "sec", depends_on: ["root"] })],
      ]);

      const graph: DagGraph = builder.build(
        blueprints,
        ["root", "qa", "type", "sec"],
      );

      expect(graph.parallel_groups[0]).toEqual(["root"]);
      expect(graph.parallel_groups[1]).toHaveLength(3);
      expect(graph.parallel_groups[1]).toContain("qa");
      expect(graph.parallel_groups[1]).toContain("type");
      expect(graph.parallel_groups[1]).toContain("sec");
    });
  });

  // ── Parallel instances ──────────────────────────────────────────────

  describe("— parallel instances", () => {
    it("should expand 6 instances of a blueprint", () => {
      const blueprints: Map<string, Blueprint> = new Map([
        ["impl", createBlueprint({ name: "impl" })],
        [
          "qa",
          createBlueprint({
            name: "qa",
            depends_on: ["impl"],
            parallel: { instances: 6, naming: "qa-{i}" },
          }),
        ],
      ]);

      const graph: DagGraph = builder.build(blueprints, ["impl", "qa"]);

      expect(graph.nodes.size).toBe(7); // 1 impl + 6 qa
      expect(graph.nodes.has("qa-1")).toBe(true);
      expect(graph.nodes.has("qa-6")).toBe(true);

      // Each qa instance depends on impl
      const qa1 = graph.nodes.get("qa-1")!;
      expect(qa1.dependencies).toContain("impl");
    });
  });

  // ── Fan-in ──────────────────────────────────────────────────────────

  describe("— fan-in", () => {
    it("should wire fan-in node to all upstream instances", () => {
      const blueprints: Map<string, Blueprint> = new Map([
        [
          "qa",
          createBlueprint({
            name: "qa",
            parallel: { instances: 3, naming: "qa-{i}" },
          }),
        ],
        [
          "staff",
          createBlueprint({ name: "staff", depends_on: ["qa"] }),
        ],
      ]);

      const graph: DagGraph = builder.build(
        blueprints,
        ["qa", "staff"],
      );

      const staff = graph.nodes.get("staff")!;
      expect(staff.dependencies).toEqual(["qa-1", "qa-2", "qa-3"]);
    });
  });

  // ── Cycle detection ─────────────────────────────────────────────────

  describe("— cycle detection", () => {
    it("should throw on circular dependencies", () => {
      const blueprints: Map<string, Blueprint> = new Map([
        ["a", createBlueprint({ name: "a", depends_on: ["b"] })],
        ["b", createBlueprint({ name: "b", depends_on: ["a"] })],
      ]);

      expect(() => builder.build(blueprints, ["a", "b"])).toThrow(
        /Cycle detected/,
      );
    });
  });

  // ── Missing dependency ──────────────────────────────────────────────

  describe("— missing dependency", () => {
    it("should throw when a dependency is not in the pipeline", () => {
      const blueprints: Map<string, Blueprint> = new Map([
        ["a", createBlueprint({ name: "a", depends_on: ["missing"] })],
      ]);

      expect(() => builder.build(blueprints, ["a"])).toThrow(
        /depends on "missing" which is not in the pipeline/,
      );
    });
  });
});
