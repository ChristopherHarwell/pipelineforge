import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { Document as YamlDocument, parseDocument } from "yaml";
import type { DiscoveredSkill } from "@pftypes/SkillFrontmatter.ts";
import type { SyncEntry, SyncOutcome, SyncReport } from "@pftypes/SyncResult.ts";
import { isJsonObject } from "@utils/json-guards.ts";

// ── Blueprint Syncer ────────────────────────────────────────────────
// Merges derivable fields from SKILL.md frontmatter into blueprint
// YAML files. Manual config (model, max_turns, gate, depends_on, etc.)
// is never overwritten.

// ── Default Blueprint Template ──────────────────────────────────────

function scaffoldBlueprint(skill: DiscoveredSkill): string {
  const doc: YamlDocument = new YamlDocument();
  const blueprint: Record<string, unknown> = {
    name: skill.name as string,
    description: skill.description,
    skill_path: `${skill.skillPath}/SKILL.md`,
    execution: {
      prompt_template: "{{ .skill_content }}\n\n## Input\n{{ .input }}",
      model: "sonnet",
      max_turns: 50,
      timeout_minutes: 10,
      allowed_tools: [...skill.allowedTools],
      output_format: "json",
    },
    parallel: {
      instances: 1,
      naming: "{name}-{i}",
    },
    depends_on: [],
    gate: {
      type: "quality",
      quality_checks: [{ check: "exit_code" }],
    },
    outputs: {},
    review_mode: {
      enabled: false,
    },
    requires_repo: true,
  };

  doc.contents = doc.createNode(blueprint);
  return doc.toString();
}

// ── Comparison Helpers ──────────────────────────────────────────────

function arraysEqual(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i: number = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/**
 * BlueprintSyncer merges derivable fields from discovered SKILL.md
 * frontmatter into blueprint YAML files.
 *
 * Only 4 fields are derived from SKILL.md:
 * - `name` — from frontmatter `name`
 * - `description` — from frontmatter `description`
 * - `skill_path` — directory path + /SKILL.md
 * - `execution.allowed_tools` — from frontmatter `allowed-tools`
 *
 * All other fields require manual config and are never overwritten.
 *
 * @example
 * ```ts
 * const syncer = new BlueprintSyncer();
 * const report = await syncer.sync(discoveredSkills, "./blueprints");
 * ```
 */
export class BlueprintSyncer {
  /**
   * Sync discovered skills into blueprint YAML files.
   *
   * @param skills - Array of discovered skills from discoverSkills()
   * @param blueprintDir - Path to the blueprints directory
   * @returns SyncReport with per-skill outcomes
   */
  async sync(
    skills: ReadonlyArray<DiscoveredSkill>,
    blueprintDir: string,
  ): Promise<SyncReport> {
    // Load existing blueprint filenames
    const existingFiles: ReadonlyArray<string> = await this.listBlueprintFiles(blueprintDir);
    const existingNames: ReadonlySet<string> = new Set(
      existingFiles.map((f: string): string => f.replace(/\.ya?ml$/, "")),
    );

    const entries: SyncEntry[] = [];

    for (const skill of skills) {
      const entry: SyncEntry = await this.syncSkill(
        skill,
        blueprintDir,
        existingNames.has(skill.name as string),
      );
      entries.push(entry);
    }

    const report: SyncReport = {
      entries,
      timestamp: new Date().toISOString(),
    };

    return report;
  }

  // ── Private Helpers ─────────────────────────────────────────────

  private async listBlueprintFiles(
    blueprintDir: string,
  ): Promise<ReadonlyArray<string>> {
    try {
      const files: ReadonlyArray<string> = await readdir(blueprintDir);
      return files.filter(
        (f: string): boolean =>
          extname(f) === ".yaml" || extname(f) === ".yml",
      );
    } catch {
      return [];
    }
  }

  private async syncSkill(
    skill: DiscoveredSkill,
    blueprintDir: string,
    exists: boolean,
  ): Promise<SyncEntry> {
    try {
      if (!exists) {
        return await this.createBlueprint(skill, blueprintDir);
      }
      return await this.mergeBlueprint(skill, blueprintDir);
    } catch (err: unknown) {
      const message: string =
        err instanceof Error ? err.message : "Unknown error";
      return {
        name: skill.name,
        outcome: "error" as SyncOutcome,
        detail: message,
      };
    }
  }

  private async createBlueprint(
    skill: DiscoveredSkill,
    blueprintDir: string,
  ): Promise<SyncEntry> {
    const content: string = scaffoldBlueprint(skill);
    const filePath: string = join(blueprintDir, `${skill.name as string}.yaml`);
    await writeFile(filePath, content, "utf-8");

    return {
      name: skill.name,
      outcome: "created" as SyncOutcome,
      detail: "New blueprint scaffolded with defaults",
    };
  }

  private async mergeBlueprint(
    skill: DiscoveredSkill,
    blueprintDir: string,
  ): Promise<SyncEntry> {
    const filePath: string = join(blueprintDir, `${skill.name as string}.yaml`);
    const rawContent: string = await readFile(filePath, "utf-8");
    const doc: YamlDocument = parseDocument(rawContent);
    const root: unknown = doc.toJSON();

    if (!isJsonObject(root)) {
      throw new Error(`Invalid blueprint YAML in ${filePath}`);
    }

    const existing: Record<string, unknown> = root;
    const expectedSkillPath: string = `${skill.skillPath}/SKILL.md`;

    // Check if any derivable fields differ
    const descriptionChanged: boolean =
      existing["description"] !== skill.description;
    const skillPathChanged: boolean =
      existing["skill_path"] !== expectedSkillPath;

    const existingExecution: Record<string, unknown> =
      (existing["execution"] as Record<string, unknown>) ?? {};
    const existingTools: ReadonlyArray<string> =
      Array.isArray(existingExecution["allowed_tools"])
        ? (existingExecution["allowed_tools"] as string[])
        : [];
    const toolsChanged: boolean = !arraysEqual(
      existingTools,
      skill.allowedTools,
    );

    if (!descriptionChanged && !skillPathChanged && !toolsChanged) {
      return {
        name: skill.name,
        outcome: "unchanged" as SyncOutcome,
        detail: "No derivable fields changed",
      };
    }

    // Update only derivable fields in the document
    doc.set("description", skill.description);
    doc.set("skill_path", expectedSkillPath);

    // Update allowed_tools in execution
    doc.setIn(["execution", "allowed_tools"], [...skill.allowedTools]);

    const updatedContent: string = doc.toString();
    await writeFile(filePath, updatedContent, "utf-8");

    const changes: string[] = [];
    if (descriptionChanged) {
      changes.push("description");
    }
    if (skillPathChanged) {
      changes.push("skill_path");
    }
    if (toolsChanged) {
      changes.push("allowed_tools");
    }

    return {
      name: skill.name,
      outcome: "updated" as SyncOutcome,
      detail: `Updated: ${changes.join(", ")}`,
    };
  }
}
