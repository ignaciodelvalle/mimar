// "Declarar un embarazo" is REACHABLE from the web's anotar catalog, and it is
// gated on the same rule the destination enforces.
//
// WHAT WAS BROKEN. The route (`eventos/nuevo/embarazo`, default phase
// `started`) and the form (`PregnancyStartedForm`) both shipped, and nothing
// linked to either. The only ways in were free text the capture matcher happened
// to recognise and hand-typing the URL. The CLOSE of a pregnancy has had a real
// link the whole time (`PregnancyInProgressCard` → `?phase=ended`); the START
// had none. The phone had already solved it correctly — `conditionalKinds` in
// apps/mobile/src/pets/record-event-view-model.ts puts `pregnancy_start` in the
// picker gated on the animal's facts — so this is the web catching up to a
// design that was already argued.
//
// WHAT THESE TESTS PIN, AND WHAT THEY REFUSE TO PIN
// ---------------------------------------------------------------------------
// Copy and href are pinned as STRING LITERALS written out here, never as
// `ALL_CAPTURE_OPTIONS.find(...).label` or `PREGNANCY_START_ROUTE` — a test that
// reads the value under test to build its expectation passes no matter what the
// value becomes. `PREGNANCY_START_ROUTE` is imported in exactly one place below,
// and only to prove the constant and the literal AGREE.
//
// Every assertion is a PRESENCE assertion where it can be, and where a
// negative is the actual contract (the row must not render for a male dog) it
// is paired with the positive over the SAME rendered surface, so "nothing
// rendered at all" cannot pass as "correctly hidden". The non-vacuity guards at
// the bottom fail if the gate stops discriminating in either direction.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CaptureOptionsList } from "@/app/(app)/mis-mascotas/[publicToken]/anotar/CaptureOptionsList";
import {
  ALL_CAPTURE_OPTIONS,
  PREGNANCY_START_ROUTE,
} from "@/app/(app)/mis-mascotas/[publicToken]/anotar/handoff";
import { canStartPregnancy } from "@/src/modules/pets/application/pregnancy/pregnancy-eligibility";

const TOKEN = "DIM-PREG-4K7Q";

/** The copy, written out. Changing the label must fail here. */
const LABEL = "Registrar embarazo";

/**
 * The href, written out — including the token and the explicit `phase=started`.
 *
 * NOT BUILT FROM `PREGNANCY_START_ROUTE`, and not built from the token variable
 * either beyond interpolation: this is the URL a person's browser must receive.
 */
const HREF = `/mis-mascotas/${TOKEN}/eventos/nuevo/embarazo?phase=started`;

/** The other `clinical_info_logged` row, which must be unaffected by the gate. */
const SIBLING_LABEL = "Información clínica / estudios";

function render(opts: { showPregnancyStartOption: boolean }): string {
  return renderToStaticMarkup(
    <CaptureOptionsList
      petPublicToken={TOKEN}
      showCheckinOption={false}
      showPregnancyStartOption={opts.showPregnancyStartOption}
    />,
  );
}

describe("the catalog carries a start-a-pregnancy entry", () => {
  it("the entry exists in ALL_CAPTURE_OPTIONS with the pregnancy route", () => {
    const rows = ALL_CAPTURE_OPTIONS.filter((o) => o.label === LABEL);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.routeOverride).toBe("/eventos/nuevo/embarazo?phase=started");
  });

  it("PREGNANCY_START_ROUTE is that literal, so the gate and the link cannot part ways", () => {
    // The ONE place the constant is read. If someone edits the constant without
    // editing the catalog (or the reverse), the test above and this one disagree.
    expect(PREGNANCY_START_ROUTE).toBe("/eventos/nuevo/embarazo?phase=started");
  });

  it("it points at the START and not the close — ?phase=ended is a different entry point", () => {
    // The close already had a link (PregnancyInProgressCard). This row must not
    // be a second door to it.
    const rows = ALL_CAPTURE_OPTIONS.filter((o) => o.label === LABEL);
    expect(rows[0]?.routeOverride).not.toContain("phase=ended");
  });
});

describe("the entry is gated — both directions, over the same rendered surface", () => {
  it("renders, with its href, when the gate is open", () => {
    const html = render({ showPregnancyStartOption: true });
    expect(html).toContain(LABEL);
    expect(html).toContain(`href="${HREF}"`);
  });

  it("does not render when the gate is shut, while the rest of the catalog still does", () => {
    const html = render({ showPregnancyStartOption: false });
    expect(html).not.toContain(LABEL);
    // THE PAIRED POSITIVE. Without it, a CaptureOptionsList that threw, returned
    // null, or rendered an empty list would pass the line above.
    expect(html).toContain(SIBLING_LABEL);
    expect(html).toContain("Salud");
  });

  it("the sibling clinical row keeps its own link in both states", () => {
    // The pregnancy row rides `clinical_info_logged`, which this row also uses.
    // A gate written against the event type instead of the route would take both.
    for (const open of [true, false]) {
      const html = render({ showPregnancyStartOption: open });
      expect(html).toContain(SIBLING_LABEL);
    }
  });
});

describe("canStartPregnancy — the rule the menu and the destination share", () => {
  const female = { sex: "female", species: "dog", pregnancyStatus: null };

  it("says yes for a female dog with no pregnancy open", () => {
    expect(canStartPregnancy(female)).toBe(true);
  });

  it("says yes after a pregnancy that ENDED — a second one may be opened", () => {
    expect(canStartPregnancy({ ...female, pregnancyStatus: "completed_live_birth" })).toBe(true);
  });

  it("says no for a male", () => {
    expect(canStartPregnancy({ ...female, sex: "male" })).toBe(false);
  });

  it("says no when the sex was never recorded", () => {
    // STRICTER THAN THE PHONE ON PURPOSE. `pregnancyRows` offers the row for a
    // null sex because on the phone a null is a DEGRADED READ. Here every caller
    // holds the `pets` row: a null is a column nobody filled, and the writer
    // refuses it, so offering the form would route somebody to a refusal.
    expect(canStartPregnancy({ ...female, sex: null })).toBe(false);
  });

  it("says no while one is already in progress — that is the close, not the start", () => {
    expect(canStartPregnancy({ ...female, pregnancyStatus: "in_progress" })).toBe(false);
  });

  it("says no for a species with no gestation in the writer's table", () => {
    expect(canStartPregnancy({ ...female, species: "axolotl" })).toBe(false);
    expect(canStartPregnancy({ ...female, species: null })).toBe(false);
  });

  it("says yes for a rabbit — the species set follows the writer, not the old literal", () => {
    // The 2026-09-07 widening. The page's own `{dog, cat, other}` literal had
    // not tracked it, so the web refused a pregnant rabbit the writer accepts.
    expect(canStartPregnancy({ ...female, species: "rabbit" })).toBe(true);
  });
});

describe("non-vacuity — these fail if the gate stops discriminating", () => {
  it("the two render states are not the same document", () => {
    // A gate hard-wired to true, or to false, makes these identical. This is the
    // guard that outlives any single label or href above.
    expect(render({ showPregnancyStartOption: true })).not.toBe(
      render({ showPregnancyStartOption: false }),
    );
  });

  it("the predicate answers both yes and no over real pet shapes", () => {
    const shapes = [
      { sex: "female", species: "dog", pregnancyStatus: null },
      { sex: "female", species: "cat", pregnancyStatus: "in_progress" },
      { sex: "male", species: "dog", pregnancyStatus: null },
    ];
    const answers = shapes.map(canStartPregnancy);
    expect(answers).toContain(true);
    expect(answers).toContain(false);
  });

  it("exactly one catalog row carries the pregnancy route", () => {
    // A duplicated row would render twice for an eligible animal and the gate
    // would still look correct; a renamed row would vanish and the `not.toContain`
    // above would pass for the wrong reason.
    const withRoute = ALL_CAPTURE_OPTIONS.filter(
      (o) => o.routeOverride === "/eventos/nuevo/embarazo?phase=started",
    );
    expect(withRoute).toHaveLength(1);
    expect(withRoute[0]?.label).toBe(LABEL);
  });
});
