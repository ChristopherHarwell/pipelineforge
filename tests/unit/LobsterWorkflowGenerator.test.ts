import { describe, it, expect } from "vitest";
import { createStableTestId, createBlueprint } from "../utils/mock-data.ts";
import { generateLobsterWorkflow } from "@core/LobsterWorkflowGenerator.ts";
import type { PipelineConfig } from "@pftypes/Pipeline.ts";
import type { Blueprint } from "@pftypes/Blueprint.ts";

// ===========================================================================
// LobsterWorkflowGenerator
// ===========================================================================

// ── Test Factories ──────────────────────────────────────────────────

function createTestPipelineConfig(
  overrides?: Partial<PipelineConfig>,
): PipelineConfig {
  const name: string = `pipeline-${String(createStableTestId("pipeline").value)}`;
  return {
    name,
    description: `desc-${String(createStableTestId("desc").value)}`,
    blueprints: [],
    defaults: {
      model: "sonnet",
      timeout_minutes: 15,
      max_concurrent_containers: 20,
    },
    human_gates: [],
    ...overrides,
  };
}

function createBlueprintMap(
  entries: ReadonlyArray<Blueprint>,
): ReadonlyMap<string, Blueprint> {
  const map: Map<string, Blueprint> = new Map();
  for (const bp of entries) {
    map.set(bp.name, bp);
  }
  return map;
}

describe("generateLobsterWorkflow", () => {
  // ── basic generation ──────────────────────────────────────────────

  describe("— basic workflow generation", () => {
    it("should generate a Lobster workflow with openclaw sessions spawn for each step", () => {
      const bpNameA: string = `step-${String(createStableTestId("a").value)}`;
      const bpNameB: string = `step-${String(createStableTestId("b").value)}`;

      const config: PipelineConfig = createTestPipelineConfig({
        blueprints: [bpNameA, bpNameB],
      });

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({
          name: bpNameA,
          skill_path: `~/.claude/skills/${bpNameA}/SKILL.md`,
        }),
        createBlueprint({
          name: bpNameB,
          skill_path: `~/.claude/skills/${bpNameB}/SKILL.md`,
          depends_on: [bpNameA],
        }),
      ]);

      const output: string = generateLobsterWorkflow(config, blueprints);

      expect(output).toContain(`name: ${config.name}`);
      expect(output).toContain(`id: ${bpNameA}`);
      expect(output).toContain(`id: ${bpNameB}`);
      expect(output).toContain("openclaw sessions spawn");
      expect(output).toContain(`--agent ${bpNameA}`);
      expect(output).toContain(`--agent ${bpNameB}`);
    });

    it("should reference the gateway URL variable in spawn commands", () => {
      const bpName: string = `step-${String(createStableTestId("gw").value)}`;

      const config: PipelineConfig = createTestPipelineConfig({
        blueprints: [bpName],
      });

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({ name: bpName }),
      ]);

      const output: string = generateLobsterWorkflow(config, blueprints);

      expect(output).toContain("--gateway ${gateway_url}");
    });

    it("should include skill content in the message via cat", () => {
      const bpName: string = `step-${String(createStableTestId("cat").value)}`;
      const skillPath: string = `~/.claude/skills/${bpName}/SKILL.md`;

      const config: PipelineConfig = createTestPipelineConfig({
        blueprints: [bpName],
      });

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({ name: bpName, skill_path: skillPath }),
      ]);

      const output: string = generateLobsterWorkflow(config, blueprints);

      expect(output).toContain(`$(cat ${skillPath})`);
    });
  });

  // ── approval gates ────────────────────────────────────────────────

  describe("— approval gates", () => {
    it("should insert approval steps after gated blueprints", () => {
      const bpA: string = `step-${String(createStableTestId("gate-a").value)}`;
      const bpB: string = `step-${String(createStableTestId("gate-b").value)}`;
      const bpC: string = `step-${String(createStableTestId("gate-c").value)}`;

      const config: PipelineConfig = createTestPipelineConfig({
        blueprints: [bpA, bpB, bpC],
        human_gates: [{ after: bpA }, { after: bpB }],
      });

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({ name: bpA }),
        createBlueprint({ name: bpB, depends_on: [bpA] }),
        createBlueprint({ name: bpC, depends_on: [bpB] }),
      ]);

      const output: string = generateLobsterWorkflow(config, blueprints);

      expect(output).toContain(`id: approve-${bpA}`);
      expect(output).toContain(`id: approve-${bpB}`);
      expect(output).toContain("approval:");
      expect(output).toContain("prompt:");
      expect(output).toContain(`when: $approve-${bpA}.approved`);
      expect(output).toContain(`when: $approve-${bpB}.approved`);
    });

    it("should not include approval steps when no gates configured", () => {
      const bpA: string = `step-${String(createStableTestId("no-gate-a").value)}`;
      const bpB: string = `step-${String(createStableTestId("no-gate-b").value)}`;

      const config: PipelineConfig = createTestPipelineConfig({
        blueprints: [bpA, bpB],
        human_gates: [],
      });

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({ name: bpA }),
        createBlueprint({ name: bpB }),
      ]);

      const output: string = generateLobsterWorkflow(config, blueprints);

      expect(output).not.toContain("approval:");
      expect(output).not.toContain("when:");
    });
  });

  // ── stdin piping ──────────────────────────────────────────────────

  describe("— inter-step data flow", () => {
    it("should pipe stdin from dependency step output", () => {
      const bpA: string = `step-${String(createStableTestId("pipe-a").value)}`;
      const bpB: string = `step-${String(createStableTestId("pipe-b").value)}`;

      const config: PipelineConfig = createTestPipelineConfig({
        blueprints: [bpA, bpB],
      });

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({ name: bpA }),
        createBlueprint({ name: bpB, depends_on: [bpA] }),
      ]);

      const output: string = generateLobsterWorkflow(config, blueprints);

      expect(output).toContain(`stdin: $${bpA}.json`);
    });

    it("should include prior step output in message context", () => {
      const bpA: string = `step-${String(createStableTestId("ctx-a").value)}`;
      const bpB: string = `step-${String(createStableTestId("ctx-b").value)}`;

      const config: PipelineConfig = createTestPipelineConfig({
        blueprints: [bpA, bpB],
      });

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({ name: bpA }),
        createBlueprint({ name: bpB, depends_on: [bpA] }),
      ]);

      const output: string = generateLobsterWorkflow(config, blueprints);

      // The message should reference the previous step's stdout
      expect(output).toContain(`$${bpA}.stdout`);
    });
  });

  // ── args and env ──────────────────────────────────────────────────

  describe("— workflow metadata", () => {
    it("should include gateway_url in args block", () => {
      const bpName: string = `step-${String(createStableTestId("args").value)}`;

      const config: PipelineConfig = createTestPipelineConfig({
        blueprints: [bpName],
      });

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({ name: bpName }),
      ]);

      const output: string = generateLobsterWorkflow(config, blueprints);

      expect(output).toContain("args:");
      expect(output).toContain("gateway_url:");
      expect(output).toContain("feature:");
      expect(output).toContain("repo_dir:");
      expect(output).toContain("notes_dir:");
    });

    it("should include env block to unset CLAUDECODE and ANTHROPIC_API_KEY", () => {
      const bpName: string = `step-${String(createStableTestId("env").value)}`;

      const config: PipelineConfig = createTestPipelineConfig({
        blueprints: [bpName],
      });

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({ name: bpName }),
      ]);

      const output: string = generateLobsterWorkflow(config, blueprints);

      expect(output).toContain("env:");
      expect(output).toContain('CLAUDECODE: ""');
      expect(output).toContain('ANTHROPIC_API_KEY: ""');
    });
  });

  // ── edge cases ────────────────────────────────────────────────────

  describe("— edge cases", () => {
    it("should handle single-blueprint pipeline", () => {
      const bpName: string = `only-${String(createStableTestId("single").value)}`;

      const config: PipelineConfig = createTestPipelineConfig({
        blueprints: [bpName],
      });

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({ name: bpName }),
      ]);

      const output: string = generateLobsterWorkflow(config, blueprints);

      expect(output).toContain(`id: ${bpName}`);
      expect(output).toContain("openclaw sessions spawn");
    });

    it("should skip blueprints not found in the map", () => {
      const bpName: string = `exists-${String(createStableTestId("exists").value)}`;
      const missingName: string = `missing-${String(createStableTestId("missing").value)}`;

      const config: PipelineConfig = createTestPipelineConfig({
        blueprints: [bpName, missingName],
      });

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({ name: bpName }),
      ]);

      const output: string = generateLobsterWorkflow(config, blueprints);

      expect(output).toContain(`id: ${bpName}`);
      expect(output).not.toContain(`id: ${missingName}`);
    });
  });
});
