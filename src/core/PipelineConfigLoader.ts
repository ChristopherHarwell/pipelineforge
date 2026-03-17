import { readFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { PipelineConfig } from "../types/Pipeline.js";

// ── Pipeline Config Schema ──────────────────────────────────────────

const PipelineConfigSchema: z.ZodType = z.object({
  name: z.string().min(1),
  description: z.string(),
  blueprints: z.array(z.string()),
  defaults: z.object({
    model: z.string().default("sonnet"),
    timeout_minutes: z.number().positive().default(10),
    max_concurrent_containers: z.number().positive().default(20),
  }),
  human_gates: z
    .array(
      z.object({
        after: z.string(),
      }),
    )
    .default([]),
});

// ── Pipeline Config Loader ──────────────────────────────────────────

/**
 * Load and validate a pipeline configuration from a YAML file.
 *
 * @param pipelinesDir - Directory containing pipeline YAML files
 * @param name - Pipeline name (without extension)
 * @returns Validated PipelineConfig
 * @throws Error if file not found or validation fails
 */
export async function loadPipelineConfig(
  pipelinesDir: string,
  name: string,
): Promise<PipelineConfig> {
  const filePath: string = join(pipelinesDir, `${name}.yaml`);
  const content: string = await readFile(filePath, "utf-8");
  const raw: unknown = yaml.load(content);

  const result = PipelineConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues: string = result.error.issues
      .map(
        (i: z.ZodIssue): string => `  - ${i.path.join(".")}: ${i.message}`,
      )
      .join("\n");
    throw new Error(
      `Pipeline config validation failed for "${name}":\n${issues}`,
    );
  }

  return result.data as PipelineConfig;
}
