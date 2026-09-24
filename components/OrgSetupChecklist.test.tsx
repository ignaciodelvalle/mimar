// Render tests for <OrgSetupChecklist> — the user-visible half of the B2 fix.
//
// The domain half is pinned in __tests__/org-setup-checklist.test.ts (a
// waitingOn:"mimar" step carries href:null / cta:null and is excluded from
// isSetupComplete). This file pins what that produces ON SCREEN, because the
// defect was a rendered promise: a "Enviar documentación" button pointing at
// /org/{token}/configuracion, a page whose own closing line says the
// verification state "es gestionado por el equipo de miMAR". Nothing to send,
// nothing the org can do, and a button anyway.

import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OrgSetupChecklist } from "@/components/OrgSetupChecklist";
import { type SetupStep, deriveSetupSteps } from "@/lib/infra/org-setup-checklist";

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

/** A shelter that has done everything it can and is still unverified. */
function unverifiedShelterSteps(): SetupStep[] {
  return deriveSetupSteps({
    orgType: "shelter",
    hasEverHeldAnimal: false,
    hasSignedEvent: false,
    hasCoverage: false,
    memberCount: 1,
    canCreateServices: false,
    hasServices: false,
    hasCapacityDeclared: false,
    isVerified: false,
  });
}

describe("<OrgSetupChecklist> — the verification row is a status, not a task", () => {
  it("renders the verification row with a status tag and no link of its own", () => {
    const html = render(<OrgSetupChecklist steps={unverifiedShelterSteps()} orgToken="ORG-TEST" />);

    // The row is still present — the fix is honesty, not deletion.
    expect(html).toContain("Verificación");
    expect(html).toContain("En revisión de miMAR");
  });

  it("renders NO anchor at all when the only pending step waits on miMAR", () => {
    // Found by mutation: dropping the `step.href !== null` guard on the CTA
    // still passed every other test in this file, because the resulting
    // element is an EMPTY anchor — `<a href="/org/ORG-TEST/null"></a>`, label
    // `null`, invisible on screen and a 404 for anyone who tabs onto it. No
    // copy assertion can see that; counting anchors can.
    const steps = deriveSetupSteps({
      orgType: "clinic",
      hasEverHeldAnimal: false,
      hasSignedEvent: true,
      hasCoverage: true,
      memberCount: 2,
      canCreateServices: false,
      hasServices: false,
      hasCapacityDeclared: false,
      isVerified: false,
    });
    expect(steps.filter((s) => !s.done).map((s) => s.key)).toEqual(["verification"]);

    const html = render(<OrgSetupChecklist steps={steps} orgToken="ORG-TEST" />);
    expect(html).toContain("En revisión de miMAR");
    expect(html).not.toContain("<a ");
    // Belt and braces: the literal shape the broken guard produced.
    expect(html).not.toContain("/org/ORG-TEST/null");
  });

  it("never links the checklist to /configuracion for the verification step", () => {
    const steps = unverifiedShelterSteps();
    // Guard the guard: `capacity` also points at configuracion, so asserting
    // "no configuracion link at all" would pass for the wrong reason on a
    // shelter. Drop it and the ONLY remaining candidate is verification.
    const withoutCapacity = steps.filter((s) => s.key !== "capacity");
    expect(withoutCapacity.some((s) => s.key === "verification")).toBe(true);

    const html = render(<OrgSetupChecklist steps={withoutCapacity} orgToken="ORG-TEST" />);

    expect(html).not.toContain('href="/org/ORG-TEST/configuracion"');
    // …and specifically not the string the old CTA rendered. Paired with the
    // positive "En revisión de miMAR" assertion above so this cannot quietly
    // become a tautology: if the tag copy changes, that test fails first.
    expect(html).not.toContain("Enviar documentación");
    // Sanity: a step the org CAN act on still renders its link, so the
    // assertions above are about verification and not about a broken render.
    expect(html).toContain('href="/org/ORG-TEST/cobertura"');
  });

  it("counts progress over org-actionable steps only", () => {
    // shelter, nothing done: firstAnimal + coverage + members + capacity are
    // actionable, verification is not. The denominator counts what the org can
    // finish (4), never the rendered rows (5) — an unreachable denominator is
    // the same lie the CTA told, relocated to the counter.
    const steps = unverifiedShelterSteps();
    // Guard the guard: assert the shape the numbers below describe, so adding
    // or removing a step turns this into a clear failure instead of a silent
    // off-by-one in a string.
    expect(steps.filter((s) => s.waitingOn === "org")).toHaveLength(4);
    expect(steps).toHaveLength(5);

    const html = render(<OrgSetupChecklist steps={steps} orgToken="ORG-TEST" />);
    expect(html).toContain("0 de 4 pasos completados");
    expect(html).not.toContain("0 de 5 pasos completados");
  });

  it("keeps the miMAR row tagged once it is approved, so the counter's exclusion is visible", () => {
    // Found on staging: an approved shelter rendered SIX rows with FIVE ticks
    // beside a counter reading "4 / 5". The counter was right — it measures
    // org-actionable steps — but the approved verification row looked exactly
    // like a counted one, so nothing on screen said which row sat outside the
    // denominator. The tag is the only thing that distinguishes it.
    const steps = deriveSetupSteps({
      orgType: "shelter",
      hasEverHeldAnimal: true,
      hasSignedEvent: false,
      hasCoverage: true,
      memberCount: 2,
      canCreateServices: true,
      hasServices: true,
      hasCapacityDeclared: false,
      isVerified: true,
    });
    // Guard the guard: this is the exact shape the staging screen had — one
    // pending org step, an approved miMAR row, five actionable rows total.
    expect(steps.find((s) => s.key === "verification")?.done).toBe(true);
    expect(steps.filter((s) => s.waitingOn === "org")).toHaveLength(5);
    expect(steps.filter((s) => s.waitingOn === "org" && !s.done).map((s) => s.key)).toEqual([
      "capacity",
    ]);

    const html = render(<OrgSetupChecklist steps={steps} orgToken="ORG-TEST" />);
    expect(html).toContain("4 de 5 pasos completados");
    expect(html).toContain("Verificada por miMAR");
    // The approved row still carries no action of its own. Read the row itself
    // rather than the whole document — the pending capacity step legitimately
    // links to /configuracion, so a document-wide assertion would be checking
    // the wrong row.
    const verificationRow = html.split("<li").find((row) => row.includes("Verificada por miMAR"));
    expect(verificationRow).toBeDefined();
    expect(verificationRow).not.toContain("<a ");
    // Sanity: the one pending org step still renders its CTA, so the
    // assertions above are about the miMAR row and not a broken render.
    expect(html).toContain('href="/org/ORG-TEST/configuracion"');
  });

  it("autofocuses the FIRST org-actionable pending step — the intake row for a shelter", () => {
    // The shelter's first job is registering an animal (org-first readiness
    // #5), so that is the row autoFocus must land on and the row aria-current
    // must mark. Pinning it here keeps a future reordering from silently
    // sending a brand-new refugio to "Zonas de cobertura" first.
    const html = render(
      <OrgSetupChecklist steps={unverifiedShelterSteps()} orgToken="ORG-TEST" autoFocusFirst />,
    );
    // Read the row the component marked as the current step and check WHERE it
    // sends the operator — asserting on the raw `autofocus` attribute would
    // depend on React's attribute ordering, which is not the behaviour at issue.
    const currentRow = html.split('aria-current="step"')[1]?.split("</li>")[0];
    expect(currentRow).toBeDefined();
    expect(currentRow).toContain('href="/org/ORG-TEST/intake"');
    expect(currentRow).toContain("autofocus");
  });

  it("autofocuses the first ORG-actionable pending step, not the verification row", () => {
    // Only verification is pending here. autoFocus must land nowhere: the
    // waiting row renders a <span>, and focusing a row with no action is a
    // dead end for a keyboard user.
    const steps = deriveSetupSteps({
      orgType: "clinic",
      hasEverHeldAnimal: false,
      hasSignedEvent: true,
      hasCoverage: true,
      memberCount: 2,
      canCreateServices: false,
      hasServices: false,
      hasCapacityDeclared: false,
      isVerified: false,
    });
    expect(steps.filter((s) => !s.done).map((s) => s.key)).toEqual(["verification"]);

    const html = render(<OrgSetupChecklist steps={steps} orgToken="ORG-TEST" autoFocusFirst />);
    expect(html).toContain("En revisión de miMAR");
    expect(html).not.toContain("autofocus");
    expect(html).not.toContain('aria-current="step"');
  });
});
