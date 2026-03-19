import { describe, it, expect } from "vitest";
import { SyncEntrySchema, SyncReportSchema } from "@pftypes/SyncResult.ts";
import { createStableTestId } from "../utils/mock-data.ts";

// ===========================================================================
// SyncResult — Schema Validation
// ===========================================================================

describe("SyncEntrySchema", () => {
  // ── valid entries ─────────────────────────────────────────────────

  it.each([
    {
      name: `skill-${String(createStableTestId("created").value)}`,
      outcome: "created" as const,
      detail: `detail-${String(createStableTestId("detail-c").value)}`,
    },
    {
      name: `skill-${String(createStableTestId("updated").value)}`,
      outcome: "updated" as const,
      detail: `detail-${String(createStableTestId("detail-u").value)}`,
    },
    {
      name: `skill-${String(createStableTestId("unchanged").value)}`,
      outcome: "unchanged" as const,
      detail: `detail-${String(createStableTestId("detail-n").value)}`,
    },
    {
      name: `skill-${String(createStableTestId("error").value)}`,
      outcome: "error" as const,
      detail: `detail-${String(createStableTestId("detail-e").value)}`,
    },
  ])("should accept entry with outcome=$outcome", (entry: {
    readonly name: string;
    readonly outcome: string;
    readonly detail: string;
  }) => {
    const result = SyncEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  // ── invalid entries ───────────────────────────────────────────────

  it("should reject empty name", () => {
    const result = SyncEntrySchema.safeParse({
      name: "",
      outcome: "created",
      detail: `detail-${String(createStableTestId("empty-name").value)}`,
    });
    expect(result.success).toBe(false);
  });

  it("should reject invalid outcome", () => {
    const result = SyncEntrySchema.safeParse({
      name: `skill-${String(createStableTestId("inv-outcome").value)}`,
      outcome: "invalid",
      detail: `detail-${String(createStableTestId("inv-detail").value)}`,
    });
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// SyncReportSchema
// ===========================================================================

describe("SyncReportSchema", () => {
  it("should accept a valid report", () => {
    const nameA: string = `skill-${String(createStableTestId("report-a").value)}`;
    const nameB: string = `skill-${String(createStableTestId("report-b").value)}`;

    const result = SyncReportSchema.safeParse({
      entries: [
        { name: nameA, outcome: "created", detail: "Scaffolded" },
        { name: nameB, outcome: "unchanged", detail: "No change" },
      ],
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("should accept a report with empty entries", () => {
    const result = SyncReportSchema.safeParse({
      entries: [],
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("should reject invalid timestamp", () => {
    const result = SyncReportSchema.safeParse({
      entries: [],
      timestamp: "not-a-date",
    });
    expect(result.success).toBe(false);
  });
});
