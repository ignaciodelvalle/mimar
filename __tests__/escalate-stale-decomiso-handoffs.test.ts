// Module-boundary test for the escalate-stale-decomiso-handoffs use-case.
//
// Verifies the use-case at
// src/modules/cases/application/escalate-stale-decomiso-handoffs.ts can be
// imported independently of the lib shim and keeps its API contract stable
// after the strangler migration.
//
// Behavior invariants (stale-included / fresh-excluded clock-on-latest-
// proposal, notification insertion, idempotency, non-sanitary-org exclusion)
// live in __tests__/cron-escalate-stale-decomiso-handoffs.test.ts, which
// exercises the full DB path via the lib shim. The duplicated DB scenario
// suite that used to live here was deleted in the 2026-07 test-suite audit —
// it re-proved the same invariants with a second fixture set.

import { describe, expect, it } from "vitest";

import {
  escalateStaleDecomiso,
  findStaleDecomisoCandidates,
} from "@/src/modules/cases/application/escalate-stale-decomiso-handoffs";

describe("escalate-stale-decomiso-handoffs use-case — API contract", () => {
  it("exports findStaleDecomisoCandidates and escalateStaleDecomiso as functions", () => {
    expect(typeof findStaleDecomisoCandidates).toBe("function");
    expect(typeof escalateStaleDecomiso).toBe("function");
  });
});
