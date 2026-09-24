// observation-overdue now holds only the shared due-soon window constant.
//
// Deadline classification + badge copy moved to lib/domain/due-state.ts
// (computeDueInfo / dueDateBadge), where /admin/observaciones and the
// /gob/acciones worklist share one implementation — those are exercised by
// due-state.test.ts and worklist-core.test.ts. All that remains to pin here is
// the window value both call sites pass, so it can't drift silently.

import { describe, expect, it } from "vitest";

import { OBSERVATION_DUE_SOON_DAYS } from "@/src/modules/surveillance/domain/observation-overdue";

describe("OBSERVATION_DUE_SOON_DAYS", () => {
  it("is the 2-day warning window (deadline day, tomorrow, day after)", () => {
    expect(OBSERVATION_DUE_SOON_DAYS).toBe(2);
  });
});
