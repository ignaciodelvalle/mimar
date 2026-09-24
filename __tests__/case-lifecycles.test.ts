// Coverage tests for case lifecycles.
//
// Enforces:
//  - Every V1_CASE_KIND has a lifecycle file resolvable via getLifecycle().
//  - Every lifecycle's `kind` matches the registry key.
//  - Cron-having lifecycles have both cronCloseRoute + cronCloseScheduleHours.
//  - Lifecycles without manualOpenAllowed must declare at least one opensEvent.
//  - Only adoption_listing has reopenAllowed=true (V1 invariant).

import { describe, expect, it } from "vitest";

import { V1_CASE_KINDS } from "@/src/modules/cases/domain/case-kinds";
import { allLifecycles, getLifecycle } from "@/src/modules/cases/domain/lifecycles";

describe("case-lifecycles — coverage", () => {
  for (const kind of V1_CASE_KINDS) {
    it(`getLifecycle(${kind}) returns a lifecycle whose kind matches`, () => {
      const lifecycle = getLifecycle(kind);
      expect(lifecycle).not.toBeNull();
      expect(lifecycle?.kind).toBe(kind);
    });
  }

  it("allLifecycles returns exactly the V1 set", () => {
    const all = allLifecycles()
      .map((l) => l.kind)
      .sort();
    expect(all).toEqual([...V1_CASE_KINDS].sort());
  });
});

describe("case-lifecycles — invariants", () => {
  for (const lifecycle of allLifecycles()) {
    if (lifecycle.cronCloseRoute) {
      it(`${lifecycle.kind}: cron route + schedule hours are both set`, () => {
        expect(lifecycle.cronCloseRoute).toBeTruthy();
        expect(lifecycle.cronCloseScheduleHours).toBeGreaterThan(0);
      });
    }

    if (!lifecycle.manualOpenAllowed) {
      it(`${lifecycle.kind}: declares at least one opensEvent when not manually opened`, () => {
        expect(lifecycle.opensEvents.length).toBeGreaterThan(0);
      });
    }
  }

  it("only adoption_listing has reopenAllowed=true in V1", () => {
    for (const lifecycle of allLifecycles()) {
      if (lifecycle.kind === "adoption_listing") {
        expect(lifecycle.reopenAllowed).toBe(true);
      } else {
        expect(lifecycle.reopenAllowed).toBeFalsy();
      }
    }
  });
});
