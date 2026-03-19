import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStableTestId } from "../utils/mock-data.ts";
import type { DiscoveredSkill } from "@pftypes/SkillFrontmatter.ts";
import { toSkillName } from "@pftypes/SkillFrontmatter.ts";
import type { SyncReport } from "@pftypes/SyncResult.ts";

// ===========================================================================
// BlueprintSyncer
// ===========================================================================

// ── Mock fs ─────────────────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn(),
  access: vi.fn(),
}));

import { readFile, writeFile, readdir } from "node:fs/promises";
import { BlueprintSyncer } from "@core/BlueprintSyncer.ts";

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockReaddir = vi.mocked(readdir);

beforeEach(() => {
  vi.clearAllMocks();
  mockWriteFile.mockResolvedValue(undefined);
});

// ── Test Factories ──────────────────────────────────────────────────

function createDiscoveredSkill(
  overrides?: Partial<DiscoveredSkill>,
): DiscoveredSkill {
  const id: string = String(createStableTestId("skill").value);
  return {
    name: toSkillName(`skill-${id}`),
    description: `desc-${id}`,
    argumentHint: undefined,
    allowedTools: ["Read", "Write"],
    skillPath: `/skills/skill-${id}`,
    ...overrides,
  };
}

describe("BlueprintSyncer", () => {
  const syncer: BlueprintSyncer = new BlueprintSyncer();

  // ── scaffolding new blueprints ────────────────────────────────────

  describe("— creating new blueprints", () => {
    it("should scaffold a new blueprint from a discovered skill", async () => {
      const skillName: string = `skill-${String(createStableTestId("qa").value)}`;
      const skillDesc: string = `desc-${String(createStableTestId("qa-desc").value)}`;
      const skillPath: string = `/skills/${skillName}`;
      const skills: ReadonlyArray<DiscoveredSkill> = [
        createDiscoveredSkill({
          name: toSkillName(skillName),
          description: skillDesc,
          allowedTools: ["Read", "Glob", "Grep"],
          skillPath,
        }),
      ];

      mockReaddir.mockResolvedValue([]);

      const report: SyncReport = await syncer.sync(skills, "/blueprints");

      expect(report.entries).toHaveLength(1);
      expect(report.entries[0]!.outcome).toBe("created");
      expect(report.entries[0]!.name).toBe(skillName);

      expect(mockWriteFile).toHaveBeenCalledOnce();
      const writtenContent: string = mockWriteFile.mock.calls[0]![1] as string;
      expect(writtenContent).toContain(`name: ${skillName}`);
      expect(writtenContent).toContain(`description: ${skillDesc}`);
      expect(writtenContent).toContain(`skill_path: ${skillPath}/SKILL.md`);
      expect(writtenContent).toContain("Read");
      expect(writtenContent).toContain("Glob");
      expect(writtenContent).toContain("Grep");
    });

    it("should include sensible defaults in scaffolded blueprints", async () => {
      const skills: ReadonlyArray<DiscoveredSkill> = [
        createDiscoveredSkill(),
      ];
      mockReaddir.mockResolvedValue([]);

      await syncer.sync(skills, "/blueprints");

      const writtenContent: string = mockWriteFile.mock.calls[0]![1] as string;
      expect(writtenContent).toContain("model: sonnet");
      expect(writtenContent).toContain("max_turns: 50");
      expect(writtenContent).toContain("timeout_minutes: 10");
      expect(writtenContent).toContain("type: quality");
    });
  });

  // ── merging into existing blueprints ──────────────────────────────

  describe("— updating existing blueprints", () => {
    it("should merge derivable fields without overwriting manual config", async () => {
      const skillName: string = `skill-${String(createStableTestId("merge").value)}`;
      const newDesc: string = `updated-desc-${String(createStableTestId("new-desc").value)}`;
      const newPath: string = `/skills/${skillName}`;
      const depName: string = `dep-${String(createStableTestId("dep").value)}`;

      const skills: ReadonlyArray<DiscoveredSkill> = [
        createDiscoveredSkill({
          name: toSkillName(skillName),
          description: newDesc,
          allowedTools: ["Read", "Glob", "Grep", "Write"],
          skillPath: newPath,
        }),
      ];

      mockReaddir.mockResolvedValue([
        `${skillName}.yaml`,
      ] as unknown as Awaited<ReturnType<typeof readdir>>);

      const existingYaml: string = [
        `name: ${skillName}`,
        "description: Old description",
        "skill_path: /old/path/SKILL.md",
        "execution:",
        "  prompt_template: '{{ .skill_content }}'",
        "  model: opus",
        "  max_turns: 100",
        "  timeout_minutes: 30",
        "  allowed_tools:",
        "    - Read",
        "  output_format: json",
        "parallel:",
        "  instances: 6",
        '  naming: "{name}-{i}"',
        "depends_on:",
        `  - ${depName}`,
        "gate:",
        "  type: approval",
        "  required: 6",
        "  total: 6",
        "requires_repo: true",
      ].join("\n");

      mockReadFile.mockResolvedValue(existingYaml);

      const report: SyncReport = await syncer.sync(skills, "/blueprints");

      expect(report.entries).toHaveLength(1);
      expect(report.entries[0]!.outcome).toBe("updated");

      const writtenContent: string = mockWriteFile.mock.calls[0]![1] as string;

      // Derivable fields should be updated
      expect(writtenContent).toContain(`description: ${newDesc}`);
      expect(writtenContent).toContain(`skill_path: ${newPath}/SKILL.md`);
      expect(writtenContent).toContain("Glob");
      expect(writtenContent).toContain("Grep");
      expect(writtenContent).toContain("Write");

      // Manual config should be preserved
      expect(writtenContent).toContain("model: opus");
      expect(writtenContent).toContain("max_turns: 100");
      expect(writtenContent).toContain("timeout_minutes: 30");
      expect(writtenContent).toContain("instances: 6");
      expect(writtenContent).toContain("type: approval");
      expect(writtenContent).toContain("required: 6");
      expect(writtenContent).toContain(depName);
    });

    it("should report unchanged when no derivable fields differ", async () => {
      const skillName: string = `skill-${String(createStableTestId("unchanged").value)}`;
      const desc: string = `desc-${String(createStableTestId("same").value)}`;
      const skillPath: string = `/skills/${skillName}`;

      const skills: ReadonlyArray<DiscoveredSkill> = [
        createDiscoveredSkill({
          name: toSkillName(skillName),
          description: desc,
          allowedTools: ["Read"],
          skillPath,
        }),
      ];

      mockReaddir.mockResolvedValue([
        `${skillName}.yaml`,
      ] as unknown as Awaited<ReturnType<typeof readdir>>);

      const existingYaml: string = [
        `name: ${skillName}`,
        `description: ${desc}`,
        `skill_path: ${skillPath}/SKILL.md`,
        "execution:",
        "  prompt_template: test",
        "  model: sonnet",
        "  max_turns: 50",
        "  timeout_minutes: 10",
        "  allowed_tools:",
        "    - Read",
        "  output_format: json",
        "gate:",
        "  type: quality",
        "requires_repo: true",
      ].join("\n");

      mockReadFile.mockResolvedValue(existingYaml);

      const report: SyncReport = await syncer.sync(skills, "/blueprints");

      expect(report.entries).toHaveLength(1);
      expect(report.entries[0]!.outcome).toBe("unchanged");
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  // ── error handling ────────────────────────────────────────────────

  describe("— error handling", () => {
    it("should report error for skills that fail sync", async () => {
      const skillName: string = `broken-${String(createStableTestId("err").value)}`;

      const skills: ReadonlyArray<DiscoveredSkill> = [
        createDiscoveredSkill({ name: toSkillName(skillName) }),
      ];

      mockReaddir.mockResolvedValue([
        `${skillName}.yaml`,
      ] as unknown as Awaited<ReturnType<typeof readdir>>);

      mockReadFile.mockRejectedValue(new Error("Permission denied"));

      const report: SyncReport = await syncer.sync(skills, "/blueprints");

      expect(report.entries).toHaveLength(1);
      expect(report.entries[0]!.outcome).toBe("error");
      expect(report.entries[0]!.detail).toContain("Permission denied");
    });
  });

  // ── report structure ──────────────────────────────────────────────

  describe("— sync report", () => {
    it("should generate a valid SyncReport with timestamp", async () => {
      const skills: ReadonlyArray<DiscoveredSkill> = [
        createDiscoveredSkill(),
        createDiscoveredSkill(),
      ];

      mockReaddir.mockResolvedValue([]);

      const report: SyncReport = await syncer.sync(skills, "/blueprints");

      expect(report.entries).toHaveLength(2);
      expect(report.timestamp).toBeDefined();
      expect(() => new Date(report.timestamp)).not.toThrow();
      expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp);
    });

    it("should handle empty skills list", async () => {
      mockReaddir.mockResolvedValue([]);

      const report: SyncReport = await syncer.sync([], "/blueprints");

      expect(report.entries).toHaveLength(0);
      expect(report.timestamp).toBeDefined();
    });
  });
});
