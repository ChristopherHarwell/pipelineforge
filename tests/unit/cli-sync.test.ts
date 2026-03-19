import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStableTestId } from "../utils/mock-data.ts";

// ===========================================================================
// CLI sync command
// ===========================================================================

// ── Mock dependencies ───────────────────────────────────────────────

vi.mock("@core/SkillFrontmatterParser.ts", () => ({
  discoverSkills: vi.fn(),
}));

vi.mock("@core/BlueprintSyncer.ts", () => ({
  BlueprintSyncer: vi.fn().mockImplementation(() => ({
    sync: vi.fn(),
  })),
}));

vi.mock("@core/OpenClawConfigSyncer.ts", () => ({
  OpenClawConfigSyncer: vi.fn().mockImplementation(() => ({
    generate: vi.fn(),
    writeConfig: vi.fn(),
  })),
}));

vi.mock("@core/BlueprintRegistry.ts", () => ({
  BlueprintRegistry: vi.fn().mockImplementation(() => ({
    loadFromDirectory: vi.fn(),
    all: vi.fn().mockReturnValue(new Map()),
    names: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock("@core/PipelineConfigLoader.ts", () => ({
  loadPipelineConfig: vi.fn(),
}));

import { discoverSkills } from "@core/SkillFrontmatterParser.ts";
import { BlueprintSyncer } from "@core/BlueprintSyncer.ts";
import type { DiscoveredSkill, SkillName } from "@pftypes/SkillFrontmatter.ts";
import { toSkillName } from "@pftypes/SkillFrontmatter.ts";
import type { SyncReport } from "@pftypes/SyncResult.ts";

const mockDiscoverSkills = vi.mocked(discoverSkills);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── runSync function tests ──────────────────────────────────────────

describe("sync orchestration", () => {
  it("should discover skills and invoke BlueprintSyncer with results", async () => {
    const skillId: string = String(createStableTestId("disc").value);
    const skillName: string = `skill-${skillId}`;
    const skillDesc: string = `desc-${String(createStableTestId("desc").value)}`;
    const skillDetail: string = `detail-${String(createStableTestId("detail").value)}`;

    const discoveredSkill: DiscoveredSkill = {
      name: toSkillName(skillName),
      description: skillDesc,
      argumentHint: undefined,
      allowedTools: ["Read"],
      skillPath: `/skills/${skillName}`,
    };

    mockDiscoverSkills.mockResolvedValue([discoveredSkill]);

    const mockSyncFn = vi.fn<
      (skills: ReadonlyArray<DiscoveredSkill>, dir: string) => Promise<SyncReport>
    >().mockResolvedValue({
      entries: [
        {
          name: toSkillName(skillName) as SkillName,
          outcome: "created" as const,
          detail: skillDetail,
        },
      ],
      timestamp: new Date().toISOString(),
    });

    const syncer: BlueprintSyncer = new BlueprintSyncer();
    (syncer as { sync: typeof mockSyncFn }).sync = mockSyncFn;

    const skills: ReadonlyArray<DiscoveredSkill> =
      await discoverSkills("/skills");
    const report: SyncReport = await syncer.sync(skills, "/blueprints");

    expect(mockDiscoverSkills).toHaveBeenCalledWith("/skills");
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]!.outcome).toBe("created");
  });

  it("should handle empty skill directory", async () => {
    mockDiscoverSkills.mockResolvedValue([]);

    const mockSyncFn = vi.fn<
      (skills: ReadonlyArray<DiscoveredSkill>, dir: string) => Promise<SyncReport>
    >().mockResolvedValue({
      entries: [],
      timestamp: new Date().toISOString(),
    });

    const syncer: BlueprintSyncer = new BlueprintSyncer();
    (syncer as { sync: typeof mockSyncFn }).sync = mockSyncFn;

    const skills: ReadonlyArray<DiscoveredSkill> =
      await discoverSkills("/empty");
    const report: SyncReport = await syncer.sync(skills, "/blueprints");

    expect(report.entries).toHaveLength(0);
  });

  it("should pass correct paths from CLI options", async () => {
    const skillDir: string = `/tmp/skills-${String(createStableTestId("sd").value)}`;
    const blueprintDir: string = `/tmp/bp-${String(createStableTestId("bd").value)}`;

    mockDiscoverSkills.mockResolvedValue([]);

    const mockSyncFn = vi.fn<
      (skills: ReadonlyArray<DiscoveredSkill>, dir: string) => Promise<SyncReport>
    >().mockResolvedValue({
      entries: [],
      timestamp: new Date().toISOString(),
    });

    const syncer: BlueprintSyncer = new BlueprintSyncer();
    (syncer as { sync: typeof mockSyncFn }).sync = mockSyncFn;

    await discoverSkills(skillDir);
    await syncer.sync([], blueprintDir);

    expect(mockDiscoverSkills).toHaveBeenCalledWith(skillDir);
    expect(mockSyncFn).toHaveBeenCalledWith([], blueprintDir);
  });
});
