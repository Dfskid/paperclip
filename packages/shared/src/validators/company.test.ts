import { describe, expect, it } from "vitest";
import { updateCompanySchema } from "./company.js";

describe("company productivity review settings", () => {
  it("accepts a positive per-company resolved-review snooze duration", () => {
    const snoozeMs = 12 * 60 * 60 * 1000;
    const parsed = updateCompanySchema.parse({ productivityReviewResolvedSnoozeMs: snoozeMs });

    expect(parsed.productivityReviewResolvedSnoozeMs).toBe(snoozeMs);
  });
});
