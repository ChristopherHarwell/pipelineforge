import { z } from "zod";
import type { DeepReadonly } from "@utils/deepfreeze.ts";

// ── Branded SkillName Type ──────────────────────────────────────────

declare const __skillNameBrand: unique symbol;

/**
 * Branded type for skill names — prevents accidental string substitution.
 */
export type SkillName = string & { readonly [__skillNameBrand]: typeof __skillNameBrand };

/**
 * Cast a raw string to a branded SkillName.
 *
 * @param name - The raw skill name string
 * @returns A branded SkillName
 */
export function toSkillName(name: string): SkillName {
  return name as SkillName;
}

// ── Skill Frontmatter Schema ────────────────────────────────────────

export const SkillFrontmatterSchema: z.ZodObject<{
  readonly name: z.ZodString;
  readonly description: z.ZodString;
  readonly "argument-hint": z.ZodOptional<z.ZodString>;
  readonly "allowed-tools": z.ZodDefault<z.ZodArray<z.ZodString>>;
}> = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  "argument-hint": z.string().optional(),
  "allowed-tools": z.array(z.string()).default([]),
});

/**
 * Validated SKILL.md frontmatter — deeply immutable at the type level.
 */
export type SkillFrontmatter = DeepReadonly<z.infer<typeof SkillFrontmatterSchema>>;

// ── Discovered Skill ────────────────────────────────────────────────

/**
 * A discovered skill with its parsed frontmatter and filesystem path.
 */
export interface DiscoveredSkill {
  readonly name: SkillName;
  readonly description: string;
  readonly argumentHint: string | undefined;
  readonly allowedTools: ReadonlyArray<string>;
  readonly skillPath: string;
}
