import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStableTestId } from "../utils/mock-data.ts";
import type { Blueprint } from "@pftypes/Blueprint.ts";
import { createBlueprint } from "../utils/mock-data.ts";
import type { OpenClawGatewayConfig } from "@pftypes/ProxySession.ts";
import { OpenClawConfigSyncer } from "@core/OpenClawConfigSyncer.ts";

// ===========================================================================
// OpenClawConfigSyncer
// ===========================================================================

// ── Mock fs ─────────────────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

import { writeFile, mkdir } from "node:fs/promises";

const mockWriteFile = vi.mocked(writeFile);
const mockMkdir = vi.mocked(mkdir);

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteFile.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);
});

// ── Test Factories ──────────────────────────────────────────────────

function createTestSyncerConfig(): {
  readonly workerImage: string;
  readonly hostRepoDir: string;
  readonly hostNotesDir: string;
  readonly hostStateDir: string;
  readonly hostClaudeDir: string;
  readonly maxConcurrent: number;
} {
  const id: string = String(createStableTestId("syncer-config").value);
  return {
    workerImage: `pipelineforge-claude-${id}`,
    hostRepoDir: `/tmp/repo-${id}`,
    hostNotesDir: `/tmp/notes-${id}`,
    hostStateDir: `/tmp/state-${id}`,
    hostClaudeDir: `/tmp/claude-${id}`,
    maxConcurrent: 20,
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

describe("OpenClawConfigSyncer", () => {
  // ── config generation ─────────────────────────────────────────────

  describe("— generating openclaw.json from blueprints", () => {
    it("should generate a gateway config with one agent per blueprint", () => {
      const config = createTestSyncerConfig();
      const syncer: OpenClawConfigSyncer = new OpenClawConfigSyncer(config);

      const bpNameA: string = `step-${String(createStableTestId("bp-a").value)}`;
      const bpNameB: string = `step-${String(createStableTestId("bp-b").value)}`;

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({
          name: bpNameA,
          description: "First step",
          execution: {
            prompt_template: "Do A",
            model: "sonnet",
            max_turns: 50,
            timeout_minutes: 10,
            allowed_tools: ["Read", "Write"],
            output_format: "json",
          },
        }),
        createBlueprint({
          name: bpNameB,
          description: "Second step",
          execution: {
            prompt_template: "Do B",
            model: "opus",
            max_turns: 100,
            timeout_minutes: 20,
            allowed_tools: ["Read", "Glob", "Grep"],
            output_format: "json",
          },
        }),
      ]);

      const pipelineBlueprints: ReadonlyArray<string> = [bpNameA, bpNameB];
      const result: OpenClawGatewayConfig = syncer.generate(
        blueprints,
        pipelineBlueprints,
      );

      expect(result.agents.list).toHaveLength(2);
      expect(result.agents.list[0]!.name).toBe(bpNameA);
      expect(result.agents.list[1]!.name).toBe(bpNameB);
      expect(result.maxConcurrent).toBe(20);
      expect(result.sandbox.docker.enabled).toBe(true);
    });

    it("should map model names to Anthropic model identifiers", () => {
      const config = createTestSyncerConfig();
      const syncer: OpenClawConfigSyncer = new OpenClawConfigSyncer(config);

      const bpName: string = `step-${String(createStableTestId("bp-model").value)}`;

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({
          name: bpName,
          execution: {
            prompt_template: "Test",
            model: "opus",
            max_turns: 50,
            timeout_minutes: 10,
            allowed_tools: ["Read"],
            output_format: "json",
          },
        }),
      ]);

      const result: OpenClawGatewayConfig = syncer.generate(
        blueprints,
        [bpName],
      );

      expect(result.agents.list[0]!.model).toBe("anthropic/claude-opus-4-6");
    });

    it("should include allowed_tools from blueprint execution config", () => {
      const config = createTestSyncerConfig();
      const syncer: OpenClawConfigSyncer = new OpenClawConfigSyncer(config);

      const bpName: string = `step-${String(createStableTestId("bp-tools").value)}`;
      const expectedTools: ReadonlyArray<string> = ["Read", "Write", "Glob", "Grep", "Bash"];

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({
          name: bpName,
          execution: {
            prompt_template: "Test",
            model: "sonnet",
            max_turns: 50,
            timeout_minutes: 10,
            allowed_tools: [...expectedTools],
            output_format: "json",
          },
        }),
      ]);

      const result: OpenClawGatewayConfig = syncer.generate(
        blueprints,
        [bpName],
      );

      expect(result.agents.list[0]!.tools).toEqual(expectedTools);
    });

    it("should configure sandbox with docker mounts", () => {
      const config = createTestSyncerConfig();
      const syncer: OpenClawConfigSyncer = new OpenClawConfigSyncer(config);

      const bpName: string = `step-${String(createStableTestId("bp-mounts").value)}`;

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({ name: bpName, requires_repo: true }),
      ]);

      const result: OpenClawGatewayConfig = syncer.generate(
        blueprints,
        [bpName],
      );

      const agent = result.agents.list[0]!;
      expect(agent.sandbox.docker.image).toBe(config.workerImage);
      expect(agent.sandbox.docker.mounts).toEqual(
        expect.arrayContaining([
          expect.stringContaining(config.hostClaudeDir),
          expect.stringContaining(config.hostRepoDir),
        ]),
      );
      expect(agent.sandbox.docker.workingDir).toBe("/workspace");
    });

    it("should use /notes as workingDir when requires_repo is false", () => {
      const config = createTestSyncerConfig();
      const syncer: OpenClawConfigSyncer = new OpenClawConfigSyncer(config);

      const bpName: string = `step-${String(createStableTestId("bp-norepo").value)}`;

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({ name: bpName, requires_repo: false }),
      ]);

      const result: OpenClawGatewayConfig = syncer.generate(
        blueprints,
        [bpName],
      );

      const agent = result.agents.list[0]!;
      expect(agent.sandbox.docker.workingDir).toBe("/notes");
    });

    it("should include disallowedTools when review_mode is enabled", () => {
      const config = createTestSyncerConfig();
      const syncer: OpenClawConfigSyncer = new OpenClawConfigSyncer(config);

      const bpName: string = `step-${String(createStableTestId("bp-review").value)}`;

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({
          name: bpName,
          review_mode: {
            enabled: true,
            dry_run_disallowed_tools: ["Edit", "Write", "NotebookEdit"],
          },
        }),
      ]);

      const result: OpenClawGatewayConfig = syncer.generate(
        blueprints,
        [bpName],
      );

      expect(result.agents.list[0]!.disallowedTools).toEqual([
        "Edit",
        "Write",
        "NotebookEdit",
      ]);
    });

    it("should skip blueprints not found in the map", () => {
      const config = createTestSyncerConfig();
      const syncer: OpenClawConfigSyncer = new OpenClawConfigSyncer(config);

      const bpName: string = `step-${String(createStableTestId("bp-exists").value)}`;

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({ name: bpName }),
      ]);

      const result: OpenClawGatewayConfig = syncer.generate(
        blueprints,
        [bpName, "nonexistent-step"],
      );

      expect(result.agents.list).toHaveLength(1);
      expect(result.agents.list[0]!.name).toBe(bpName);
    });
  });

  // ── optional discord config ───────────────────────────────────────

  describe("— discord integration", () => {
    it("should include discord config when channel ID is provided", () => {
      const config = createTestSyncerConfig();
      const syncer: OpenClawConfigSyncer = new OpenClawConfigSyncer(config);

      const bpName: string = `step-${String(createStableTestId("bp-discord").value)}`;
      const channelId: string = String(createStableTestId("channel").value);

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({ name: bpName }),
      ]);

      const result: OpenClawGatewayConfig = syncer.generate(
        blueprints,
        [bpName],
        channelId,
      );

      expect(result.discord).toBeDefined();
      expect(result.discord!.enabled).toBe(true);
      expect(result.discord!.channelId).toBe(channelId);
    });

    it("should omit discord config when no channel ID provided", () => {
      const config = createTestSyncerConfig();
      const syncer: OpenClawConfigSyncer = new OpenClawConfigSyncer(config);

      const bpName: string = `step-${String(createStableTestId("bp-no-discord").value)}`;

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({ name: bpName }),
      ]);

      const result: OpenClawGatewayConfig = syncer.generate(
        blueprints,
        [bpName],
      );

      expect(result.discord).toBeUndefined();
    });
  });

  // ── write to disk ─────────────────────────────────────────────────

  describe("— writing config to disk", () => {
    it("should write serialized JSON to the specified path", async () => {
      const config = createTestSyncerConfig();
      const syncer: OpenClawConfigSyncer = new OpenClawConfigSyncer(config);

      const bpName: string = `step-${String(createStableTestId("bp-write").value)}`;
      const outputPath: string = `/tmp/test-${String(createStableTestId("path").value)}/openclaw.json`;

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({ name: bpName }),
      ]);

      const gatewayConfig: OpenClawGatewayConfig = syncer.generate(
        blueprints,
        [bpName],
      );

      await syncer.writeConfig(gatewayConfig, outputPath);

      expect(mockMkdir).toHaveBeenCalledOnce();
      expect(mockWriteFile).toHaveBeenCalledOnce();

      const writtenContent: string = mockWriteFile.mock.calls[0]![1] as string;
      const parsed: unknown = JSON.parse(writtenContent);
      expect(parsed).toEqual(gatewayConfig);
    });
  });

  // ── serialization ─────────────────────────────────────────────────

  describe("— serialization", () => {
    it("should produce valid JSON with 2-space indentation", () => {
      const config = createTestSyncerConfig();
      const syncer: OpenClawConfigSyncer = new OpenClawConfigSyncer(config);

      const bpName: string = `step-${String(createStableTestId("bp-json").value)}`;

      const blueprints: ReadonlyMap<string, Blueprint> = createBlueprintMap([
        createBlueprint({ name: bpName }),
      ]);

      const gatewayConfig: OpenClawGatewayConfig = syncer.generate(
        blueprints,
        [bpName],
      );

      const json: string = syncer.serialize(gatewayConfig);

      expect(() => JSON.parse(json)).not.toThrow();
      expect(json).toContain("  "); // 2-space indent
      expect(JSON.parse(json)).toEqual(gatewayConfig);
    });
  });
});
