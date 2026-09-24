// Unit tests for lib/org-setup-checklist.ts — Wave 3 Item 19: Org onboarding checklist.
//
// Coverage:
//   1. deriveSetupSteps — base steps always present (coverage, members, verification).
//   1b. firstAnimal step — custody org types only, leads the actionable steps.
//   2. Services step omitted when canCreateServices=false; present when true.
//   3. Capacity step present for shelter; absent for clinic, rescue_network, other.
//   4. Each step's done/pending derived correctly from input fields.
//   4b. waitingOn — which steps the org can act on vs. which wait on miMAR.
//   5. isSetupComplete — true when every ORG-ACTIONABLE step is done.
//   6. firstPendingStep — first pending ORG-ACTIONABLE step; null when none.
//   7. Auto-hide: verified + configured org → all steps done.
//
// Pure unit tests — no DB access required.

import { describe, expect, it } from "vitest";

import {
  type OrgSetupInput,
  deriveSetupSteps,
  firstPendingStep,
  isSetupComplete,
} from "@/lib/infra/org-setup-checklist";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_INPUT: OrgSetupInput = {
  orgType: "shelter",
  hasEverHeldAnimal: false,
  hasSignedEvent: false,
  hasCoverage: false,
  memberCount: 1,
  canCreateServices: false,
  hasServices: false,
  hasCapacityDeclared: false,
  isVerified: false,
};

function makeInput(overrides: Partial<OrgSetupInput> = {}): OrgSetupInput {
  return { ...BASE_INPUT, ...overrides };
}

// ---------------------------------------------------------------------------
// 1. Base steps always present
// ---------------------------------------------------------------------------

describe("deriveSetupSteps — base steps", () => {
  it("always includes coverage, members, and verification steps", () => {
    const steps = deriveSetupSteps(makeInput());
    const keys = steps.map((s) => s.key);
    expect(keys).toContain("coverage");
    expect(keys).toContain("members");
    expect(keys).toContain("verification");
  });

  it("returns steps in deterministic order: [firstAnimal] → coverage → members → [services] → [capacity] → verification", () => {
    const steps = deriveSetupSteps(makeInput({ canCreateServices: true, orgType: "shelter" }));
    const keys = steps.map((s) => s.key);
    expect(keys).toEqual([
      "firstAnimal",
      "coverage",
      "members",
      "services",
      "capacity",
      "verification",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 1b. firstAnimal — the guided path finally leads to the product
// ---------------------------------------------------------------------------
//
// Org-first readiness finding #5: every step this checklist offered a refugio
// was configuration AROUND AN EMPTY ROSTER (zones for alerts about animals it
// does not have, members to help with animals it does not have, capacity to
// measure occupancy of animals it does not have). The one action that makes
// miMAR real for a shelter — registering the first animal — was missing, so a
// refugio could complete onboarding without ever touching intake.

describe("deriveSetupSteps — firstAnimal step", () => {
  it("leads the actionable steps for a shelter — it is not buried after configuration", () => {
    const steps = deriveSetupSteps(makeInput({ orgType: "shelter" }));
    const actionable = steps.filter((s) => s.waitingOn === "org");
    expect(actionable[0]?.key).toBe("firstAnimal");
  });

  it("applies to rescue_network too — a rescatista holds animals without declaring capacity", () => {
    const steps = deriveSetupSteps(makeInput({ orgType: "rescue_network" }));
    // The pair that makes the gate's WIDTH the point: intake applies, capacity
    // does not. Asserting only the presence of firstAnimal would pass just as
    // well if the step reused capacity's shelter-only gate by accident.
    expect(steps.find((s) => s.key === "firstAnimal")).toBeDefined();
    expect(steps.find((s) => s.key === "capacity")).toBeUndefined();
  });

  it.each(["clinic", "sanitary_authority", "other"])(
    "omits firstAnimal for %s — no custody, so intake is not a job it can finish",
    (orgType) => {
      const steps = deriveSetupSteps(makeInput({ orgType }));
      expect(steps.find((s) => s.key === "firstAnimal")).toBeUndefined();
    },
  );

  it("marks firstAnimal done when the org already holds an animal", () => {
    const steps = deriveSetupSteps(makeInput({ orgType: "shelter", hasEverHeldAnimal: true }));
    expect(steps.find((s) => s.key === "firstAnimal")?.done).toBe(true);
  });

  it("marks firstAnimal pending for an empty roster", () => {
    const steps = deriveSetupSteps(makeInput({ orgType: "shelter", hasEverHeldAnimal: false }));
    expect(steps.find((s) => s.key === "firstAnimal")?.done).toBe(false);
  });

  it("sends the org to the intake page and mentions the CSV alternative", () => {
    const step = deriveSetupSteps(makeInput({ orgType: "shelter" })).find(
      (s) => s.key === "firstAnimal",
    );
    // The route matters: /intake is where BOTH paths start (the individual form
    // and the "Importar CSV" link on the same screen), so one CTA covers the
    // shelter with one animal and the shelter with a spreadsheet of two hundred.
    expect(step?.href).toBe("intake");
    expect(step?.cta).toBeTruthy();
    expect(step?.waitingOn).toBe("org");
    // A refugio arriving with an existing roster must not read this row as
    // "type them in one by one" and bounce.
    expect(step?.hint).toMatch(/import/i);
    expect(step?.hint).toMatch(/CSV/);
  });
});

// ---------------------------------------------------------------------------
// 2. Services step gating
// ---------------------------------------------------------------------------

describe("deriveSetupSteps — services step", () => {
  it("omits services step when canCreateServices=false", () => {
    const steps = deriveSetupSteps(makeInput({ canCreateServices: false }));
    expect(steps.find((s) => s.key === "services")).toBeUndefined();
  });

  it("includes services step when canCreateServices=true", () => {
    const steps = deriveSetupSteps(makeInput({ canCreateServices: true }));
    expect(steps.find((s) => s.key === "services")).toBeDefined();
  });

  it("marks services done when hasServices=true", () => {
    const steps = deriveSetupSteps(makeInput({ canCreateServices: true, hasServices: true }));
    const svc = steps.find((s) => s.key === "services");
    expect(svc?.done).toBe(true);
  });

  it("marks services pending when hasServices=false", () => {
    const steps = deriveSetupSteps(makeInput({ canCreateServices: true, hasServices: false }));
    const svc = steps.find((s) => s.key === "services");
    expect(svc?.done).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Capacity step gating by org_type
// ---------------------------------------------------------------------------

describe("deriveSetupSteps — capacity step", () => {
  it("includes capacity step for shelter", () => {
    const steps = deriveSetupSteps(makeInput({ orgType: "shelter" }));
    expect(steps.find((s) => s.key === "capacity")).toBeDefined();
  });

  it("omits capacity step for clinic", () => {
    const steps = deriveSetupSteps(makeInput({ orgType: "clinic" }));
    expect(steps.find((s) => s.key === "capacity")).toBeUndefined();
  });

  it("omits capacity step for rescue_network", () => {
    const steps = deriveSetupSteps(makeInput({ orgType: "rescue_network" }));
    expect(steps.find((s) => s.key === "capacity")).toBeUndefined();
  });

  it("omits capacity step for other", () => {
    const steps = deriveSetupSteps(makeInput({ orgType: "other" }));
    expect(steps.find((s) => s.key === "capacity")).toBeUndefined();
  });

  it("marks capacity done when hasCapacityDeclared=true", () => {
    const steps = deriveSetupSteps(makeInput({ orgType: "shelter", hasCapacityDeclared: true }));
    const cap = steps.find((s) => s.key === "capacity");
    expect(cap?.done).toBe(true);
  });

  it("marks capacity pending when hasCapacityDeclared=false", () => {
    const steps = deriveSetupSteps(makeInput({ orgType: "shelter", hasCapacityDeclared: false }));
    const cap = steps.find((s) => s.key === "capacity");
    expect(cap?.done).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Each step's done/pending derivation
// ---------------------------------------------------------------------------

describe("deriveSetupSteps — step done/pending derivation", () => {
  it("coverage is done when hasCoverage=true", () => {
    const steps = deriveSetupSteps(makeInput({ hasCoverage: true }));
    expect(steps.find((s) => s.key === "coverage")?.done).toBe(true);
  });

  it("coverage is pending when hasCoverage=false", () => {
    const steps = deriveSetupSteps(makeInput({ hasCoverage: false }));
    expect(steps.find((s) => s.key === "coverage")?.done).toBe(false);
  });

  it("members is done when memberCount > 1 (someone beyond admin was invited)", () => {
    const steps = deriveSetupSteps(makeInput({ memberCount: 2 }));
    expect(steps.find((s) => s.key === "members")?.done).toBe(true);
  });

  it("members is pending when memberCount = 1 (only admin)", () => {
    const steps = deriveSetupSteps(makeInput({ memberCount: 1 }));
    expect(steps.find((s) => s.key === "members")?.done).toBe(false);
  });

  it("verification is done when isVerified=true", () => {
    const steps = deriveSetupSteps(makeInput({ isVerified: true }));
    expect(steps.find((s) => s.key === "verification")?.done).toBe(true);
  });

  it("verification is pending when isVerified=false", () => {
    const steps = deriveSetupSteps(makeInput({ isVerified: false }));
    expect(steps.find((s) => s.key === "verification")?.done).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4b. waitingOn — the dead-end fix
// ---------------------------------------------------------------------------
//
// Before this block, `verification` shipped as
//   { href: "configuracion", cta: "Enviar documentación", done: isVerified }
// and NOTHING in this file pinned it. That mattered twice:
//   - /org/[orgToken]/configuracion has no upload; its own copy says the
//     verification state "es gestionado por el equipo de miMAR". The CTA was a
//     dead end by construction.
//   - only verifyOrgForAuthority (admin portal) can flip `done`, so
//     isSetupComplete — which required EVERY step — could never be true for an
//     unverified org. The checklist was pinned to the panel permanently and
//     OrgDailyLoopOrientation, which renders only after it clears, was dead
//     code for every unverified org.
// The old suite passed unchanged against the new behavior, which is exactly
// why these tests exist: the defect was invisible, not defended.

describe("deriveSetupSteps — waitingOn", () => {
  it("verification declares itself as waiting on miMAR, with NO route and NO CTA", () => {
    const verification = deriveSetupSteps(makeInput()).find((s) => s.key === "verification");
    expect(verification?.waitingOn).toBe("mimar");
    // Both nulls are load-bearing: OrgSetupChecklist renders the CTA <Link>
    // only when href AND cta are non-null, so either one surviving would put
    // the button back on screen.
    expect(verification?.href).toBeNull();
    expect(verification?.cta).toBeNull();
  });

  it("the hint says the org has nothing to send — it does not ask for documentation", () => {
    const verification = deriveSetupSteps(makeInput()).find((s) => s.key === "verification");
    // Positive assertion on the promise the copy now makes. A `not.toContain`
    // on the old "Enviá la documentación" string would go tautological the
    // moment anyone rewords the hint.
    expect(verification?.hint).toMatch(/no hay nada que enviar/i);
    expect(verification?.hint).toMatch(/miMAR/);
  });

  it("every other step is actionable BY THE ORG and carries both a route and a CTA", () => {
    const steps = deriveSetupSteps(
      makeInput({ orgType: "shelter", canCreateServices: true }),
    ).filter((s) => s.key !== "verification");
    // Guard the guard: an empty list would make the loop vacuous.
    expect(steps.map((s) => s.key)).toEqual([
      "firstAnimal",
      "coverage",
      "members",
      "services",
      "capacity",
    ]);
    for (const step of steps) {
      expect(step.waitingOn, `${step.key} should be actionable by the org`).toBe("org");
      expect(step.href, `${step.key} needs a route`).toBeTruthy();
      expect(step.cta, `${step.key} needs a CTA label`).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. isSetupComplete
// ---------------------------------------------------------------------------

describe("isSetupComplete", () => {
  it("returns false when any step is pending", () => {
    // All pending (baseline input).
    const steps = deriveSetupSteps(makeInput());
    expect(isSetupComplete(steps)).toBe(false);
  });

  it("returns false when only some steps are done", () => {
    const steps = deriveSetupSteps(
      makeInput({ hasCoverage: true, memberCount: 2, isVerified: false }),
    );
    expect(isSetupComplete(steps)).toBe(false);
  });

  it("returns true when all applicable steps are done (shelter fully configured)", () => {
    const steps = deriveSetupSteps(
      makeInput({
        orgType: "shelter",
        hasEverHeldAnimal: true,
        hasCoverage: true,
        memberCount: 2,
        canCreateServices: false,
        hasCapacityDeclared: true,
        isVerified: true,
      }),
    );
    expect(isSetupComplete(steps)).toBe(true);
  });

  it("returns true for verified clinic with coverage + members (no capacity/services required)", () => {
    const steps = deriveSetupSteps(
      makeInput({
        orgType: "clinic",
        hasSignedEvent: true,
        hasCoverage: true,
        memberCount: 3,
        canCreateServices: false,
        isVerified: true,
      }),
    );
    expect(isSetupComplete(steps)).toBe(true);
  });

  it("returns true for shelter with services when all steps including services are done", () => {
    const steps = deriveSetupSteps(
      makeInput({
        orgType: "shelter",
        hasEverHeldAnimal: true,
        hasCoverage: true,
        memberCount: 2,
        canCreateServices: true,
        hasServices: true,
        hasCapacityDeclared: true,
        isVerified: true,
      }),
    );
    expect(isSetupComplete(steps)).toBe(true);
  });

  // THE test for the B2 fix. An org that has done literally everything within
  // its power is complete, even though the verification row is still open —
  // otherwise onboarding has no exit and the panel never moves on.
  it("returns true for an UNVERIFIED org that finished every step it can act on", () => {
    const steps = deriveSetupSteps(
      makeInput({
        orgType: "shelter",
        hasEverHeldAnimal: true,
        hasCoverage: true,
        memberCount: 2,
        hasCapacityDeclared: true,
        isVerified: false,
      }),
    );
    // The row is still there and still pending — we did not fix this by
    // deleting the information. It just stopped gating.
    const verification = steps.find((s) => s.key === "verification");
    expect(verification?.done).toBe(false);
    expect(isSetupComplete(steps)).toBe(true);
  });

  it("still returns false when an org-actionable step is pending, verified or not", () => {
    // Pin the other side: dropping verification from the predicate must not
    // have widened it into "always true". Same input as above minus coverage.
    for (const isVerified of [false, true]) {
      const steps = deriveSetupSteps(
        makeInput({
          orgType: "shelter",
          hasEverHeldAnimal: true,
          hasCoverage: false,
          memberCount: 2,
          hasCapacityDeclared: true,
          isVerified,
        }),
      );
      expect(isSetupComplete(steps), `isVerified=${isVerified}`).toBe(false);
    }
  });

  it("returns false for an empty step list", () => {
    // The `actionable.length > 0` guard: `[].every(...)` is true, so without
    // it an org with no applicable steps would report itself complete.
    expect(isSetupComplete([])).toBe(false);
  });

  it("returns false when services step exists but hasServices=false", () => {
    const steps = deriveSetupSteps(
      makeInput({
        orgType: "shelter",
        hasEverHeldAnimal: true,
        hasCoverage: true,
        memberCount: 2,
        canCreateServices: true,
        hasServices: false, // services not loaded yet
        hasCapacityDeclared: true,
        isVerified: true,
      }),
    );
    expect(isSetupComplete(steps)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. firstPendingStep
// ---------------------------------------------------------------------------

describe("firstPendingStep", () => {
  it("returns the first pending step when some are done", () => {
    // firstAnimal + coverage done, members still pending
    const steps = deriveSetupSteps(
      makeInput({ hasEverHeldAnimal: true, hasCoverage: true, memberCount: 1 }),
    );
    const first = firstPendingStep(steps);
    expect(first?.key).toBe("members");
  });

  it("returns firstAnimal as first for an empty shelter — the CTA a new refugio lands on", () => {
    // This is the whole point of finding #5. A brand-new refugio's auto-focused
    // CTA is "register an animal", not "define coverage zones" for a roster
    // that does not exist yet.
    const steps = deriveSetupSteps(makeInput({ orgType: "shelter" }));
    expect(firstPendingStep(steps)?.key).toBe("firstAnimal");
  });

  // `sanitary_authority`, not `clinic`: a clinic now leads with its own first
  // act (firstSignedEvent — see CLINICAL_ORG_TYPES), so it is no longer an
  // example of "no leading step". An authority still is, and using it here
  // keeps the original intent AND pins that the new step did not leak past its
  // allowlist onto every non-custody type.
  it("returns coverage as first for an org type with no leading step", () => {
    const steps = deriveSetupSteps(makeInput({ orgType: "sanitary_authority" }));
    const first = firstPendingStep(steps);
    expect(first?.key).toBe("coverage");
  });

  it("a clinic leads with its first signed event, not with configuration", () => {
    const steps = deriveSetupSteps(makeInput({ orgType: "clinic" }));
    expect(firstPendingStep(steps)?.key).toBe("firstSignedEvent");
  });

  it("marks the clinic's first act done once it has signed anything", () => {
    const steps = deriveSetupSteps(makeInput({ orgType: "clinic", hasSignedEvent: true }));
    expect(steps.find((s) => s.key === "firstSignedEvent")?.done).toBe(true);
  });

  it("returns null when all steps are done", () => {
    const steps = deriveSetupSteps(
      makeInput({
        orgType: "clinic",
        hasSignedEvent: true,
        hasCoverage: true,
        memberCount: 2,
        isVerified: true,
      }),
    );
    const first = firstPendingStep(steps);
    expect(first).toBeNull();
  });

  it("never returns the verification step — it has no CTA to focus", () => {
    // The caller feeds this to autoFocus on the step's CTA <Link>. A
    // waitingOn:"mimar" step renders a plain <span>, so returning it would
    // either autoFocus nothing or (worse) trap a keyboard user on a row with
    // no action. Unverified clinic with everything else already done: the
    // verification row is the ONLY pending step here.
    const steps = deriveSetupSteps(
      makeInput({
        orgType: "clinic",
        hasSignedEvent: true,
        hasCoverage: true,
        memberCount: 2,
        isVerified: false,
      }),
    );
    expect(steps.filter((s) => !s.done).map((s) => s.key)).toEqual(["verification"]);
    expect(firstPendingStep(steps)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Auto-hide: checklist does not show for fully configured orgs
// ---------------------------------------------------------------------------

describe("auto-hide behavior", () => {
  it("a new empty shelter has no steps done", () => {
    const steps = deriveSetupSteps(makeInput({ orgType: "shelter" }));
    const doneCount = steps.filter((s) => s.done).length;
    expect(doneCount).toBe(0);
    expect(isSetupComplete(steps)).toBe(false);
  });

  it("a verified, configured shelter has all steps done → checklist hides", () => {
    const steps = deriveSetupSteps(
      makeInput({
        orgType: "shelter",
        hasEverHeldAnimal: true,
        hasCoverage: true,
        memberCount: 5,
        canCreateServices: false,
        hasCapacityDeclared: true,
        isVerified: true,
      }),
    );
    expect(isSetupComplete(steps)).toBe(true);
  });
});
