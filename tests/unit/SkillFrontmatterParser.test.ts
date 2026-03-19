import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStableTestId } from "../utils/mock-data.ts";
import type { DiscoveredSkill, SkillFrontmatter } from "@pftypes/SkillFrontmatter.ts";

// ===========================================================================
// SkillFrontmatterParser
// ===========================================================================

// ── Mock fs ─────────────────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

import { readFile, readdir } from "node:fs/promises";
import {
  parseSkillFrontmatter,
  discoverSkills,
} from "@core/SkillFrontmatterParser.ts";

const mockReadFile = vi.mocked(readFile);
const mockReaddir = vi.mocked(readdir);

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// parseSkillFrontmatter
// ===========================================================================

describe("parseSkillFrontmatter", () => {
  // ── valid SKILL.md content ────────────────────────────────────────

  describe("— valid content", () => {
    it("should parse a full SKILL.md frontmatter block", () => {
      const testName: string = `skill-${String(createStableTestId("name").value)}`;
      const testDesc: string = `desc-${String(createStableTestId("desc").value)}`;
      const testHint: string = `hint-${String(createStableTestId("hint").value)}`;

      const content: string = [
        "---",
        `name: ${testName}`,
        `description: "${testDesc}"`,
        `argument-hint: "${testHint}"`,
        "allowed-tools: Read, Write, Glob, Grep",
        "---",
        "",
        "# Skill Body",
        "This is the skill body.",
      ].join("\n");

      const result: SkillFrontmatter = parseSkillFrontmatter(content);
      expect(result.name).toBe(testName);
      expect(result.description).toBe(testDesc);
      expect(result["argument-hint"]).toBe(testHint);
      expect(result["allowed-tools"]).toEqual(["Read", "Write", "Glob", "Grep"]);
    });

    it("should handle allowed-tools as a YAML list", () => {
      const testName: string = `skill-${String(createStableTestId("name").value)}`;
      const testDesc: string = `desc-${String(createStableTestId("desc").value)}`;

      const content: string = [
        "---",
        `name: ${testName}`,
        `description: ${testDesc}`,
        "allowed-tools:",
        "  - Read",
        "  - Write",
        "---",
      ].join("\n");

      const result: SkillFrontmatter = parseSkillFrontmatter(content);
      expect(result["allowed-tools"]).toEqual(["Read", "Write"]);
    });

    it("should default allowed-tools to empty when absent", () => {
      const testName: string = `skill-${String(createStableTestId("name").value)}`;
      const testDesc: string = `desc-${String(createStableTestId("desc").value)}`;

      const content: string = [
        "---",
        `name: ${testName}`,
        `description: ${testDesc}`,
        "---",
      ].join("\n");

      const result: SkillFrontmatter = parseSkillFrontmatter(content);
      expect(result["allowed-tools"]).toEqual([]);
    });

    it("should handle comma-separated allowed-tools string with parens", () => {
      const testName: string = `skill-${String(createStableTestId("name").value)}`;
      const testDesc: string = `desc-${String(createStableTestId("desc").value)}`;

      const content: string = [
        "---",
        `name: ${testName}`,
        `description: ${testDesc}`,
        "allowed-tools: Bash(git *), Read, Write, Edit",
        "---",
      ].join("\n");

      const result: SkillFrontmatter = parseSkillFrontmatter(content);
      expect(result["allowed-tools"]).toEqual(["Bash(git *)", "Read", "Write", "Edit"]);
    });
  });

  // ── invalid content ───────────────────────────────────────────────

  describe("— invalid content", () => {
    it("should throw when no frontmatter delimiters found", () => {
      expect(() => parseSkillFrontmatter("# No frontmatter")).toThrow(
        /frontmatter/i,
      );
    });

    it("should throw when frontmatter is missing closing delimiter", () => {
      const testName: string = `skill-${String(createStableTestId("name").value)}`;
      const content: string = [
        "---",
        `name: ${testName}`,
        "description: No closing",
      ].join("\n");

      expect(() => parseSkillFrontmatter(content)).toThrow(/frontmatter/i);
    });

    it("should throw when required name field is missing", () => {
      const content: string = [
        "---",
        "description: Missing name field",
        "---",
      ].join("\n");

      expect(() => parseSkillFrontmatter(content)).toThrow();
    });

    it("should throw when required description field is missing", () => {
      const testName: string = `skill-${String(createStableTestId("name").value)}`;
      const content: string = [
        "---",
        `name: ${testName}`,
        "---",
      ].join("\n");

      expect(() => parseSkillFrontmatter(content)).toThrow();
    });

    it("should throw for empty frontmatter", () => {
      const content: string = ["---", "---"].join("\n");
      expect(() => parseSkillFrontmatter(content)).toThrow();
    });
  });
});

// ===========================================================================
// discoverSkills
// ===========================================================================

describe("discoverSkills", () => {
  it("should discover SKILL.md files in subdirectories", async () => {
    const dirA: string = `skill-${String(createStableTestId("dir-a").value)}`;
    const dirB: string = `skill-${String(createStableTestId("dir-b").value)}`;
    const nameA: string = `name-${String(createStableTestId("name-a").value)}`;
    const nameB: string = `name-${String(createStableTestId("name-b").value)}`;
    const descA: string = `desc-${String(createStableTestId("desc-a").value)}`;
    const descB: string = `desc-${String(createStableTestId("desc-b").value)}`;

    mockReaddir.mockResolvedValue([
      { name: dirA, isDirectory: () => true, isFile: () => false },
      { name: dirB, isDirectory: () => true, isFile: () => false },
      { name: "README.md", isDirectory: () => false, isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    mockReadFile.mockImplementation(async (path: unknown): Promise<string> => {
      const pathStr: string = String(path);
      if (pathStr.includes(dirA)) {
        return [
          "---",
          `name: ${nameA}`,
          `description: ${descA}`,
          "allowed-tools:",
          "  - Read",
          "  - Glob",
          "---",
          "Body content",
        ].join("\n");
      }
      if (pathStr.includes(dirB)) {
        return [
          "---",
          `name: ${nameB}`,
          `description: ${descB}`,
          "---",
        ].join("\n");
      }
      throw new Error(`Unexpected read: ${pathStr}`);
    });

    const skills: ReadonlyArray<DiscoveredSkill> =
      await discoverSkills("/skills");

    expect(skills).toHaveLength(2);
    expect(skills[0]!.name).toBe(nameA);
    expect(skills[0]!.allowedTools).toEqual(["Read", "Glob"]);
    expect(skills[0]!.skillPath).toBe(`/skills/${dirA}`);
    expect(skills[1]!.name).toBe(nameB);
    expect(skills[1]!.allowedTools).toEqual([]);
  });

  it("should skip directories without SKILL.md", async () => {
    const validDir: string = `valid-${String(createStableTestId("valid").value)}`;
    const emptyDir: string = `empty-${String(createStableTestId("empty").value)}`;
    const validName: string = `name-${String(createStableTestId("name").value)}`;
    const validDesc: string = `desc-${String(createStableTestId("desc").value)}`;

    mockReaddir.mockResolvedValue([
      { name: validDir, isDirectory: () => true, isFile: () => false },
      { name: emptyDir, isDirectory: () => true, isFile: () => false },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    mockReadFile.mockImplementation(async (path: unknown): Promise<string> => {
      const pathStr: string = String(path);
      if (pathStr.includes(validDir)) {
        return `---\nname: ${validName}\ndescription: ${validDesc}\n---\n`;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const skills: ReadonlyArray<DiscoveredSkill> =
      await discoverSkills("/skills");

    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe(validName);
  });

  it("should skip skills with invalid frontmatter", async () => {
    const brokenDir: string = `broken-${String(createStableTestId("broken").value)}`;

    mockReaddir.mockResolvedValue([
      { name: brokenDir, isDirectory: () => true, isFile: () => false },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    mockReadFile.mockResolvedValue("# No frontmatter at all");

    const skills: ReadonlyArray<DiscoveredSkill> =
      await discoverSkills("/skills");

    expect(skills).toHaveLength(0);
  });

  it("should return empty array for empty skill directory", async () => {
    mockReaddir.mockResolvedValue([]);

    const skills: ReadonlyArray<DiscoveredSkill> =
      await discoverSkills("/skills");

    expect(skills).toHaveLength(0);
  });
});
