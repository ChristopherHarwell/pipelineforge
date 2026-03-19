import { describe, it, expect } from "vitest";
import {
  SkillFrontmatterSchema,
  toSkillName,
  type SkillName,
} from "@pftypes/SkillFrontmatter.ts";
import { createStableTestId } from "../utils/mock-data.ts";

// ===========================================================================
// SkillFrontmatter — Type & Schema Validation
// ===========================================================================

describe("SkillFrontmatterSchema", () => {
  // ── valid frontmatter ─────────────────────────────────────────────

  describe("— valid inputs", () => {
    it("should parse a full frontmatter object", () => {
      const testName: string = `skill-${String(createStableTestId("name").value)}`;
      const testDesc: string = `desc-${String(createStableTestId("desc").value)}`;
      const testHint: string = `hint-${String(createStableTestId("hint").value)}`;
      const testTools: ReadonlyArray<string> = ["Read", "Write", "Glob"];

      const input: unknown = {
        name: testName,
        description: testDesc,
        "argument-hint": testHint,
        "allowed-tools": [...testTools],
      };
      const result = SkillFrontmatterSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe(testName);
        expect(result.data.description).toBe(testDesc);
        expect(result.data["argument-hint"]).toBe(testHint);
        expect(result.data["allowed-tools"]).toEqual(testTools);
      }
    });

    it("should default allowed-tools to empty array when missing", () => {
      const testName: string = `skill-${String(createStableTestId("name").value)}`;
      const testDesc: string = `desc-${String(createStableTestId("desc").value)}`;

      const input: unknown = {
        name: testName,
        description: testDesc,
      };
      const result = SkillFrontmatterSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data["allowed-tools"]).toEqual([]);
      }
    });

    it("should allow missing argument-hint", () => {
      const testName: string = `skill-${String(createStableTestId("name").value)}`;
      const testDesc: string = `desc-${String(createStableTestId("desc").value)}`;

      const input: unknown = {
        name: testName,
        description: testDesc,
        "allowed-tools": ["Read"],
      };
      const result = SkillFrontmatterSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data["argument-hint"]).toBeUndefined();
      }
    });

    it("should strip extra/unknown fields gracefully", () => {
      const testName: string = `skill-${String(createStableTestId("name").value)}`;
      const testDesc: string = `desc-${String(createStableTestId("desc").value)}`;

      const input: unknown = {
        name: testName,
        description: testDesc,
        "unknown-field": "ignored",
        extra: 42,
      };
      const result = SkillFrontmatterSchema.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

  // ── invalid frontmatter ───────────────────────────────────────────

  describe("— invalid inputs", () => {
    it("should reject missing name", () => {
      const testDesc: string = `desc-${String(createStableTestId("desc").value)}`;
      const input: unknown = { description: testDesc };
      const result = SkillFrontmatterSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("should reject empty name", () => {
      const testDesc: string = `desc-${String(createStableTestId("desc").value)}`;
      const input: unknown = { name: "", description: testDesc };
      const result = SkillFrontmatterSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("should reject missing description", () => {
      const testName: string = `skill-${String(createStableTestId("name").value)}`;
      const input: unknown = { name: testName };
      const result = SkillFrontmatterSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("should reject empty description", () => {
      const testName: string = `skill-${String(createStableTestId("name").value)}`;
      const input: unknown = { name: testName, description: "" };
      const result = SkillFrontmatterSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it("should reject non-array allowed-tools", () => {
      const testName: string = `skill-${String(createStableTestId("name").value)}`;
      const testDesc: string = `desc-${String(createStableTestId("desc").value)}`;
      const input: unknown = {
        name: testName,
        description: testDesc,
        "allowed-tools": "Read",
      };
      const result = SkillFrontmatterSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });
});

// ===========================================================================
// toSkillName — Branded Type
// ===========================================================================

describe("toSkillName", () => {
  it("should return a branded SkillName", () => {
    const raw: string = `skill-${String(createStableTestId("brand").value)}`;
    const name: SkillName = toSkillName(raw);
    expect(typeof name).toBe("string");
    expect(name).toBe(raw);
  });

  it("should preserve the original string value", () => {
    const raw: string = `skill-${String(createStableTestId("preserve").value)}`;
    const branded: SkillName = toSkillName(raw);
    expect(branded as string).toBe(raw);
  });
});
