import { z } from "zod";

// ── Execution Schema ────────────────────────────────────────────────

const ExecutionSchema = z.object({
  prompt_template: z.string(),
  model: z.enum(["opus", "sonnet", "haiku"]),
  max_turns: z.number().int().positive().default(50),
  timeout_minutes: z.number().positive().default(10),
  allowed_tools: z.array(z.string()).default(["Read", "Glob", "Grep"]),
  output_format: z.enum(["text", "json", "stream-json"]).default("json"),
});

// ── Parallelization Schema ──────────────────────────────────────────

const ParallelSchema = z.object({
  instances: z.number().int().positive().default(1),
  naming: z.string().default("{name}-{i}"),
});

// ── Quality Check Schema ────────────────────────────────────────────

const QualityCheckSchema = z.object({
  check: z.enum(["exit_code", "tests_pass", "lint_clean", "pattern_match"]),
  pattern: z.string().optional(),
});

// ── Gate Schema ─────────────────────────────────────────────────────

const GateSchema = z.object({
  type: z.enum(["approval", "quality", "human", "composite"]),
  required: z.number().int().positive().optional(),
  total: z.number().int().positive().optional(),
  approval_marker: z.string().optional(),
  rejection_marker: z.string().optional(),
  rejection_routes_to: z.string().optional(),
  quality_checks: z.array(QualityCheckSchema).optional(),
});

// ── Docker Overrides Schema ─────────────────────────────────────────

const DockerOverridesSchema = z.object({
  memory: z.string().optional(),
  cpus: z.string().optional(),
  extra_mounts: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

// ── Output Schema ───────────────────────────────────────────────────

const OutputsSchema = z.record(z.string());

// ── Review Mode Schema ──────────────────────────────────────────────

const ReviewModeSchema = z.object({
  enabled: z.boolean().default(false),
  dry_run_disallowed_tools: z
    .array(z.string())
    .default(["Edit", "Write", "NotebookEdit"]),
});

// ── Blueprint Schema ────────────────────────────────────────────────

export const BlueprintSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  skill_path: z.string(),
  execution: ExecutionSchema,
  parallel: ParallelSchema.default({ instances: 1, naming: "{name}-{i}" }),
  depends_on: z.array(z.string()).default([]),
  gate: GateSchema,
  outputs: OutputsSchema.default({}),
  docker: DockerOverridesSchema.optional(),
  review_mode: ReviewModeSchema.default({ enabled: false }),
});

export type Blueprint = Readonly<z.infer<typeof BlueprintSchema>>;
export type Execution = Readonly<z.infer<typeof ExecutionSchema>>;
export type Gate = Readonly<z.infer<typeof GateSchema>>;
export type Parallel = Readonly<z.infer<typeof ParallelSchema>>;
export type DockerOverrides = Readonly<z.infer<typeof DockerOverridesSchema>>;
export type QualityCheck = Readonly<z.infer<typeof QualityCheckSchema>>;
export type ReviewMode = Readonly<z.infer<typeof ReviewModeSchema>>;
