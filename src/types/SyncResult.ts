import { z } from "zod";
import type { DeepReadonly } from "@utils/deepfreeze.ts";
import type { SkillName } from "@pftypes/SkillFrontmatter.ts";

// ── Sync Outcome ────────────────────────────────────────────────────

/**
 * Possible outcomes for a single blueprint sync operation.
 */
export type SyncOutcome = "created" | "updated" | "unchanged" | "error";

// ── Sync Entry Schema ───────────────────────────────────────────────

export const SyncEntrySchema: z.ZodObject<{
  readonly name: z.ZodString;
  readonly outcome: z.ZodEnum<["created", "updated", "unchanged", "error"]>;
  readonly detail: z.ZodString;
}> = z.object({
  name: z.string().min(1),
  outcome: z.enum(["created", "updated", "unchanged", "error"]),
  detail: z.string(),
});

/**
 * Result of syncing a single skill → blueprint.
 */
export type SyncEntry = DeepReadonly<z.infer<typeof SyncEntrySchema>> & {
  readonly name: SkillName;
};

// ── Sync Report Schema ──────────────────────────────────────────────

export const SyncReportSchema: z.ZodObject<{
  readonly entries: z.ZodArray<typeof SyncEntrySchema>;
  readonly timestamp: z.ZodString;
}> = z.object({
  entries: z.array(SyncEntrySchema),
  timestamp: z.string().datetime(),
});

/**
 * Full sync report — all entries plus a timestamp.
 */
export type SyncReport = DeepReadonly<z.infer<typeof SyncReportSchema>> & {
  readonly entries: ReadonlyArray<SyncEntry>;
};
