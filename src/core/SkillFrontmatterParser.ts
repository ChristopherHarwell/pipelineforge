import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  SkillFrontmatterSchema,
  toSkillName,
  type SkillFrontmatter,
  type DiscoveredSkill,
} from "@pftypes/SkillFrontmatter.ts";
import { isJsonObject } from "@utils/json-guards.ts";

// ── Frontmatter Extraction ──────────────────────────────────────────

/**
 * Extract and parse YAML frontmatter from a SKILL.md file content string.
 *
 * Frontmatter is delimited by `---` at the start and a second `---`.
 * The YAML between the delimiters is validated against the SkillFrontmatterSchema.
 *
 * @param content - Raw SKILL.md file content
 * @returns Validated, deeply-readonly SkillFrontmatter
 * @throws Error if frontmatter delimiters are missing or validation fails
 *
 * @example
 * ```ts
 * const fm = parseSkillFrontmatter("---\nname: qa\ndescription: QA\n---\nbody");
 * // fm.name === "qa"
 * ```
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const lines: ReadonlyArray<string> = content.split("\n");

  // Find opening delimiter (must be first non-empty line or first line)
  const openIdx: number = lines.indexOf("---");
  if (openIdx === -1) {
    throw new Error("No frontmatter found: missing opening --- delimiter");
  }

  // Find closing delimiter after the opening one
  const closeIdx: number = lines.indexOf("---", openIdx + 1);
  if (closeIdx === -1) {
    throw new Error("No frontmatter found: missing closing --- delimiter");
  }

  const yamlBlock: string = lines.slice(openIdx + 1, closeIdx).join("\n");
  const raw: unknown = yaml.load(yamlBlock);

  // Handle comma-separated allowed-tools string → array
  const rawObj: Record<string, unknown> =
    isJsonObject(raw) ? { ...raw } : {};

  if (typeof rawObj["allowed-tools"] === "string") {
    rawObj["allowed-tools"] = (rawObj["allowed-tools"] as string)
      .split(/,\s*(?![^(]*\))/)
      .map((s: string): string => s.trim())
      .filter((s: string): boolean => s.length > 0);
  }

  const result = SkillFrontmatterSchema.parse(rawObj);
  return result as SkillFrontmatter;
}

// ── Skill Discovery ─────────────────────────────────────────────────

/**
 * Discover all skills in a directory by scanning for subdirectories
 * containing a SKILL.md file with valid frontmatter.
 *
 * Directories without SKILL.md or with invalid frontmatter are silently skipped.
 *
 * @param skillDir - Path to the skills root directory (e.g. ~/.claude/skills)
 * @returns Array of discovered skills with parsed frontmatter and paths
 *
 * @example
 * ```ts
 * const skills = await discoverSkills("~/.claude/skills");
 * // skills[0].name === "qa-review"
 * // skills[0].skillPath === "~/.claude/skills/qa-review"
 * ```
 */
export async function discoverSkills(
  skillDir: string,
): Promise<ReadonlyArray<DiscoveredSkill>> {
  const entries = await readdir(skillDir, { withFileTypes: true });
  const dirs: ReadonlyArray<string> = entries
    .filter((e): boolean => e.isDirectory())
    .map((e): string => e.name);

  const skills: DiscoveredSkill[] = [];

  for (const dir of dirs) {
    const skillMdPath: string = join(skillDir, dir, "SKILL.md");

    try {
      const content: string = await readFile(skillMdPath, "utf-8");
      const frontmatter: SkillFrontmatter = parseSkillFrontmatter(content);

      skills.push({
        name: toSkillName(frontmatter.name),
        description: frontmatter.description,
        argumentHint: frontmatter["argument-hint"],
        allowedTools: frontmatter["allowed-tools"],
        skillPath: join(skillDir, dir),
      });
    } catch {
      // Skip directories without valid SKILL.md
      continue;
    }
  }

  return skills;
}
