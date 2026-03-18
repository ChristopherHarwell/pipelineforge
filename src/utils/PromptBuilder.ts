import { readFile } from "node:fs/promises";
import type { Blueprint } from "../types/Blueprint.js";
import { TemplateEngine } from "./TemplateEngine.js";

// ── Prompt Context ──────────────────────────────────────────────────

export interface PromptContext {
  readonly instance: number;
  readonly total: number;
  readonly feature: string;
  readonly notesDir: string;
  readonly repoDir: string | null;
  readonly ticketId: string | null;
  readonly stepOutputs: Record<string, unknown>;
}

// ── Prompt Builder ──────────────────────────────────────────────────
// Since slash commands are NOT available in -p mode, the PromptBuilder
// reads SKILL.md content and embeds it directly into the prompt.

export class PromptBuilder {
  private readonly templateEngine: TemplateEngine;

  constructor(templateEngine: TemplateEngine) {
    this.templateEngine = templateEngine;
  }

  /**
   * Build a complete prompt for claude -p execution.
   * Reads SKILL.md content and injects it into the blueprint's prompt_template.
   *
   * @param blueprint - The blueprint definition
   * @param context - Runtime context (step outputs, file contents, etc.)
   * @returns The fully rendered prompt string
   */
  async buildPrompt(
    blueprint: Blueprint,
    context: PromptContext,
  ): Promise<string> {
    // 1. Read the SKILL.md file and strip YAML frontmatter
    const skillPath: string = this.expandPath(blueprint.skill_path);
    const rawSkillContent: string = await readFile(skillPath, "utf-8");
    const skillContent: string = this.stripFrontmatter(rawSkillContent);

    // 2. Render the prompt template with variable substitution
    const rendered: string = this.templateEngine.render(
      blueprint.execution.prompt_template,
      {
        skill_content: skillContent,
        feature: context.feature,
        instance: String(context.instance),
        total: String(context.total),
        notes_dir: context.notesDir,
        repo_dir: context.repoDir ?? "",
        ticket_id: context.ticketId ?? "",
        Steps: context.stepOutputs,
      },
    );

    return rendered;
  }

  /**
   * Strip YAML frontmatter (delimited by `---`) from skill file content.
   * SKILL.md files use frontmatter for Claude Code skill metadata (name,
   * description, allowed-tools, etc.) which is not part of the prompt.
   * Passing `---` to `claude -p` causes it to be interpreted as a flag.
   *
   * @param content - Raw SKILL.md file content
   * @returns Content with frontmatter stripped
   */
  private stripFrontmatter(content: string): string {
    const trimmed: string = content.trimStart();
    if (!trimmed.startsWith("---")) {
      return content;
    }

    // Find the closing `---` delimiter after the opening one
    const closingIndex: number = trimmed.indexOf("---", 3);
    if (closingIndex === -1) {
      return content;
    }

    // Return everything after the closing delimiter, trimmed of leading newlines
    const afterFrontmatter: string = trimmed.slice(closingIndex + 3);
    return afterFrontmatter.replace(/^\n+/, "");
  }

  /**
   * Expand ~ to HOME directory in paths.
   *
   * @param path - Path that may start with ~
   * @returns Expanded absolute path
   */
  private expandPath(path: string): string {
    if (path.startsWith("~")) {
      const home: string = process.env["HOME"] ?? "/home/claude";
      return path.replace("~", home);
    }
    return path;
  }
}
