import { readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import yaml from "js-yaml";
import { BlueprintSchema, type Blueprint } from "@pftypes/Blueprint.ts";

// ── Blueprint Registry ──────────────────────────────────────────────
// Loads, validates, and stores blueprint YAML definitions.

export class BlueprintRegistry {
  private readonly blueprints: Map<string, Blueprint> = new Map();

  /**
   * Load all blueprint YAML files from a directory.
   *
   * @param dir - Path to the blueprints directory
   * @throws Error if any blueprint fails validation
   */
  async loadFromDirectory(dir: string): Promise<void> {
    const files: ReadonlyArray<string> = await readdir(dir);
    const yamlFiles: ReadonlyArray<string> = files.filter(
      (f: string): boolean =>
        extname(f) === ".yaml" || extname(f) === ".yml",
    );

    const errors: string[] = [];

    for (const file of yamlFiles) {
      const filePath: string = join(dir, file);
      const content: string = await readFile(filePath, "utf-8");
      const raw: unknown = yaml.load(content);

      const result = BlueprintSchema.safeParse(raw);
      if (result.success) {
        this.blueprints.set(result.data.name, result.data as Blueprint);
      } else {
        const issues: string = result.error.issues
          .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
          .join("\n");
        errors.push(`${file}:\n${issues}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Blueprint validation failed:\n${errors.join("\n\n")}`,
      );
    }
  }

  /**
   * Get a blueprint by name.
   *
   * @param name - Blueprint name
   * @returns The blueprint definition
   * @throws Error if blueprint not found
   */
  get(name: string): Blueprint {
    const blueprint: Blueprint | undefined = this.blueprints.get(name);
    if (blueprint === undefined) {
      throw new Error(`Blueprint not found: ${name}`);
    }
    return blueprint;
  }

  /**
   * Check if a blueprint exists.
   *
   * @param name - Blueprint name
   * @returns true if the blueprint is registered
   */
  has(name: string): boolean {
    return this.blueprints.has(name);
  }

  /**
   * Get all registered blueprint names.
   *
   * @returns Array of blueprint names
   */
  names(): ReadonlyArray<string> {
    return Array.from(this.blueprints.keys());
  }

  /**
   * Get all registered blueprints.
   *
   * @returns ReadonlyMap of name → blueprint
   */
  all(): ReadonlyMap<string, Blueprint> {
    return this.blueprints;
  }

  /**
   * Get the number of registered blueprints.
   *
   * @returns Blueprint count
   */
  get size(): number {
    return this.blueprints.size;
  }
}
