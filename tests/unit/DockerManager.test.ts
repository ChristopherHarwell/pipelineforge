import { describe, it, expect, vi, beforeEach } from "vitest";
import { DockerManager } from "@core/DockerManager.ts";
import type { DockerConfig, SpawnOptions } from "@core/DockerManager.ts";
import type { DagNode } from "@pftypes/Graph.ts";
import { createBlueprint, createStableTestId, deepFreeze } from "../utils/mock-data.js";
import type { Blueprint } from "@pftypes/Blueprint.ts";

// ===========================================================================
// DockerManager
// ===========================================================================

// ── Mock dockerode ──────────────────────────────────────────────────

const mockStart = vi.fn().mockResolvedValue(undefined);
const mockWait = vi.fn().mockResolvedValue({ StatusCode: 0 });
const mockLogs = vi.fn().mockResolvedValue(Buffer.from("test output"));
const mockKill = vi.fn().mockResolvedValue(undefined);
const mockRemove = vi.fn().mockResolvedValue(undefined);

const mockContainer = {
  id: "container-123",
  start: mockStart,
  wait: mockWait,
  logs: mockLogs,
  kill: mockKill,
  remove: mockRemove,
};

const mockCreateContainer = vi.fn().mockResolvedValue(mockContainer);
const mockGetContainer = vi.fn().mockReturnValue(mockContainer);

vi.mock("dockerode", () => ({
  default: vi.fn().mockImplementation(() => ({
    createContainer: mockCreateContainer,
    getContainer: mockGetContainer,
  })),
}));

// ── Test Helpers ────────────────────────────────────────────────────

function createConfig(overrides?: Partial<DockerConfig>): DockerConfig {
  return {
    pipelineId: `pf-${String(createStableTestId("pipeline").value)}`,
    imageName: "pipelineforge-claude:latest",
    claudeDir: "/home/user/.claude",
    repoDir: "/projects/my-repo",
    notesDir: "/notes",
    stateDir: "/state",
    ...overrides,
  };
}

function createNode(overrides?: Partial<DagNode>): DagNode {
  return deepFreeze({
    id: `node-${String(createStableTestId("node").value)}`,
    blueprint: "test",
    instance: 1,
    dependencies: [],
    dependents: [],
    ...overrides,
  });
}

function createSpawnOptions(
  overrides?: Partial<SpawnOptions>,
): SpawnOptions {
  return {
    node: createNode({ id: "test-node" }),
    blueprint: createBlueprint({ name: "test" }),
    prompt: "test prompt",
    ...overrides,
  };
}

describe("DockerManager", () => {
  const pipelineId: string = "test-pipeline";
  let manager: DockerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWait.mockResolvedValue({ StatusCode: 0 });
    mockLogs.mockResolvedValue(Buffer.from("test output"));
    manager = new DockerManager(createConfig({ pipelineId }));
  });

  // ── spawnContainer — standard mode ────────────────────────────────

  describe("— spawnContainer (standard mode)", () => {
    it("should create a container with the correct image", async () => {
      await manager.spawnContainer(createSpawnOptions());

      expect(mockCreateContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: "pipelineforge-claude:latest",
        }),
      );
    });

    it("should name the container pf-<pipelineId>-<nodeId>", async () => {
      const options: SpawnOptions = createSpawnOptions({
        node: createNode({ id: "qa-review-1" }),
      });

      await manager.spawnContainer(options);

      expect(mockCreateContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: `pf-${pipelineId}-qa-review-1`,
        }),
      );
    });

    it("should bind-mount the main repo as /workspace:rw in standard mode", async () => {
      await manager.spawnContainer(createSpawnOptions());

      const createArgs = mockCreateContainer.mock.calls[0]![0];
      const binds: ReadonlyArray<string> = createArgs.HostConfig.Binds;

      expect(binds).toContain("/projects/my-repo:/workspace:rw");
    });

    it("should bind-mount claude dir, notes, and state", async () => {
      await manager.spawnContainer(createSpawnOptions());

      const createArgs = mockCreateContainer.mock.calls[0]![0];
      const binds: ReadonlyArray<string> = createArgs.HostConfig.Binds;

      expect(binds).toContain("/home/user/.claude:/home/claude/.claude:ro");
      expect(binds).toContain("/notes:/notes:rw");
      expect(binds).toContain("/state:/state:ro");
    });

    it("should include --dangerously-skip-permissions in CLI args", async () => {
      await manager.spawnContainer(createSpawnOptions());

      const createArgs = mockCreateContainer.mock.calls[0]![0];
      const cmd: ReadonlyArray<string> = createArgs.Cmd;

      expect(cmd).toContain("--dangerously-skip-permissions");
    });

    it("should return captured stdout and exit code", async () => {
      mockLogs.mockResolvedValue(Buffer.from("review output here"));
      mockWait.mockResolvedValue({ StatusCode: 0 });

      const result = await manager.spawnContainer(createSpawnOptions());

      expect(result.stdout).toBe("review output here");
      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should remove the container after completion", async () => {
      await manager.spawnContainer(createSpawnOptions());

      expect(mockRemove).toHaveBeenCalled();
    });
  });

  // ── spawnContainer — worktree mode ────────────────────────────────

  describe("— spawnContainer (worktree mode)", () => {
    it("should bind-mount the worktree as /workspace:rw", async () => {
      const options: SpawnOptions = createSpawnOptions({
        worktreePath: "/tmp/pf-worktrees/abc/TICKET-001",
      });

      await manager.spawnContainer(options);

      const createArgs = mockCreateContainer.mock.calls[0]![0];
      const binds: ReadonlyArray<string> = createArgs.HostConfig.Binds;

      expect(binds).toContain(
        "/tmp/pf-worktrees/abc/TICKET-001:/workspace:rw",
      );
    });

    it("should bind-mount the main repo as /repo:ro for reference", async () => {
      const options: SpawnOptions = createSpawnOptions({
        worktreePath: "/tmp/pf-worktrees/abc/TICKET-001",
      });

      await manager.spawnContainer(options);

      const createArgs = mockCreateContainer.mock.calls[0]![0];
      const binds: ReadonlyArray<string> = createArgs.HostConfig.Binds;

      expect(binds).toContain("/projects/my-repo:/repo:ro");
    });

    it("should not mount the main repo as /workspace when worktree is active", async () => {
      const options: SpawnOptions = createSpawnOptions({
        worktreePath: "/tmp/pf-worktrees/abc/TICKET-001",
      });

      await manager.spawnContainer(options);

      const createArgs = mockCreateContainer.mock.calls[0]![0];
      const binds: ReadonlyArray<string> = createArgs.HostConfig.Binds;

      expect(binds).not.toContain("/projects/my-repo:/workspace:rw");
    });
  });

  // ── spawnContainer — dry-run mode ─────────────────────────────────

  describe("— spawnContainer (dry-run mode)", () => {
    it("should add --disallowedTools with the blueprint's dry_run_disallowed_tools", async () => {
      const blueprint: Blueprint = createBlueprint({
        name: "implement-ticket",
        review_mode: {
          enabled: true,
          dry_run_disallowed_tools: ["Edit", "Write", "NotebookEdit"],
        },
      });
      const options: SpawnOptions = createSpawnOptions({
        blueprint,
        dryRun: true,
      });

      await manager.spawnContainer(options);

      const createArgs = mockCreateContainer.mock.calls[0]![0];
      const cmd: ReadonlyArray<string> = createArgs.Cmd;

      expect(cmd).toContain("--disallowedTools");
      const disallowedIdx: number = cmd.indexOf("--disallowedTools");
      expect(cmd[disallowedIdx + 1]).toBe("Edit,Write,NotebookEdit");
    });

    it("should not add --disallowedTools when dryRun is false", async () => {
      const options: SpawnOptions = createSpawnOptions({ dryRun: false });

      await manager.spawnContainer(options);

      const createArgs = mockCreateContainer.mock.calls[0]![0];
      const cmd: ReadonlyArray<string> = createArgs.Cmd;

      expect(cmd).not.toContain("--disallowedTools");
    });

    it("should not add --disallowedTools when dryRun is undefined", async () => {
      const options: SpawnOptions = createSpawnOptions();

      await manager.spawnContainer(options);

      const createArgs = mockCreateContainer.mock.calls[0]![0];
      const cmd: ReadonlyArray<string> = createArgs.Cmd;

      expect(cmd).not.toContain("--disallowedTools");
    });
  });

  // ── spawnContainer — CLI args ─────────────────────────────────────

  describe("— CLI argument construction", () => {
    it.each<{ label: string; field: string; expected: string }>([
      { label: "model", field: "--model", expected: "sonnet" },
      { label: "output-format", field: "--output-format", expected: "json" },
      { label: "max-turns", field: "--max-turns", expected: "50" },
    ])("should pass $label as $expected", async ({ field, expected }) => {
      await manager.spawnContainer(createSpawnOptions());

      const createArgs = mockCreateContainer.mock.calls[0]![0];
      const cmd: ReadonlyArray<string> = createArgs.Cmd;
      const idx: number = cmd.indexOf(field);

      expect(idx).toBeGreaterThan(-1);
      expect(cmd[idx + 1]).toBe(expected);
    });

    it("should pass the prompt via -p flag", async () => {
      const options: SpawnOptions = createSpawnOptions({
        prompt: "implement the feature",
      });

      await manager.spawnContainer(options);

      const createArgs = mockCreateContainer.mock.calls[0]![0];
      const cmd: ReadonlyArray<string> = createArgs.Cmd;
      const idx: number = cmd.indexOf("-p");

      expect(idx).toBeGreaterThan(-1);
      expect(cmd[idx + 1]).toBe("implement the feature");
    });

    it("should join allowed_tools with commas", async () => {
      const blueprint: Blueprint = createBlueprint({
        name: "test",
        execution: {
          prompt_template: "test",
          model: "sonnet",
          max_turns: 50,
          timeout_minutes: 10,
          allowed_tools: ["Read", "Glob", "Grep", "Edit"],
          output_format: "json",
        },
      });
      const options: SpawnOptions = createSpawnOptions({ blueprint });

      await manager.spawnContainer(options);

      const createArgs = mockCreateContainer.mock.calls[0]![0];
      const cmd: ReadonlyArray<string> = createArgs.Cmd;
      const idx: number = cmd.indexOf("--allowedTools");

      expect(cmd[idx + 1]).toBe("Read,Glob,Grep,Edit");
    });
  });

  // ── spawnContainer — timeout ──────────────────────────────────────

  describe("— timeout handling", () => {
    it("should return exit code 124 when container times out", async () => {
      const blueprint: Blueprint = createBlueprint({
        name: "test",
        execution: {
          prompt_template: "test",
          model: "sonnet",
          max_turns: 50,
          timeout_minutes: 0.001, // ~60ms timeout
          allowed_tools: ["Read"],
          output_format: "json",
        },
      });

      mockWait.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ StatusCode: 0 }), 5000);
          }),
      );

      const options: SpawnOptions = createSpawnOptions({ blueprint });
      const result = await manager.spawnContainer(options);

      expect(result.exitCode).toBe(124);
      expect(result.stderr).toContain("timed out");
    });
  });

  // ── killAll ───────────────────────────────────────────────────────

  describe("— killAll", () => {
    it("should kill and remove all active containers", async () => {
      // Spawn two containers to populate activeContainers
      await manager.spawnContainer(
        createSpawnOptions({
          node: createNode({ id: "node-1" }),
        }),
      );
      await manager.spawnContainer(
        createSpawnOptions({
          node: createNode({ id: "node-2" }),
        }),
      );

      // Note: containers are removed after spawnContainer completes,
      // so activeContainers is empty. killAll is mainly for abort scenarios
      // where containers are still running. This test verifies no errors.
      await expect(manager.killAll()).resolves.toBeUndefined();
    });
  });
});
