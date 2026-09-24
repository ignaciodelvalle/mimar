// The two lost-pet writers — spec R1 scenarios 16 and 18.
//
// These are the subtlest two of the eighteen:
//
//   pet_marked_lost         — its prose falls back to the INTERNAL PET UUID
//                             when a pet has no public token. R1#16 says the
//                             UUID is NEVER shown and the id is omitted
//                             entirely instead.
//   lost_search_reactivated — the only writer that already emitted es-AR. It
//                             rendered correctly BY ACCIDENT (free-text
//                             passthrough, no rule). R1#18: migrating it must
//                             not regress — no re-translation, no
//                             double-rendering.

import { describe, expect, it } from "vitest";
import { caseOpenedReasonDisplay } from "../domain/opened-reason-display";
import { resolveOpenedReasonColumns } from "../infrastructure/cases-repository";

const PET_UUID = "c1d2e3f4-5555-4666-8777-888899990000";
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("pet_marked_lost — the internal UUID is never shown (spec R1#16)", () => {
  it("shows the public token when the pet has one", () => {
    const row = resolveOpenedReasonColumns(
      { code: "pet_marked_lost", petPublicToken: "DIM-A1B2-C3D4", ownerNote: "se escapó" },
      { petId: PET_UUID },
    );
    expect(caseOpenedReasonDisplay(row)).toBe(
      "Mascota DIM-A1B2-C3D4 reportada como perdida por su dueño — se escapó",
    );
  });

  it("OMITS the id entirely when there is no token — never the UUID", () => {
    const row = resolveOpenedReasonColumns(
      { code: "pet_marked_lost", petPublicToken: null, ownerNote: null },
      { petId: PET_UUID },
    );

    expect(caseOpenedReasonDisplay(row)).toBe("Mascota reportada como perdida por su dueño");
    expect(caseOpenedReasonDisplay(row)).not.toMatch(UUID_ANYWHERE);
  });

  it("keeps the UUID in the audit prose, exactly as before the cutover", () => {
    // The privacy contract is about what is RENDERED. The audit column is
    // unchanged — that is what keeps rollback free.
    const row = resolveOpenedReasonColumns(
      { code: "pet_marked_lost", petPublicToken: null, ownerNote: null },
      { petId: PET_UUID },
    );
    expect(row.openedReason).toBe(`Pet ${PET_UUID} marked as lost by owner`);
    // ...but the UUID is not in params, so no renderer can ever reach it.
    expect(JSON.stringify(row.openedReasonParams)).not.toContain(PET_UUID);
  });

  it("degrades safely: a legacy UUID-prose row still hides the UUID", () => {
    // A pre-cutover row, written before this change, rendered through the
    // frozen regex path. R1 must hold for BOTH cohorts.
    expect(
      caseOpenedReasonDisplay({
        openedReasonCode: null,
        openedReasonParams: null,
        openedReason: `Pet ${PET_UUID} marked as lost by owner`,
      }),
    ).not.toMatch(UUID_ANYWHERE);
  });
});

describe("lost_search_reactivated — no regression, no double-rendering (spec R1#18)", () => {
  const row = resolveOpenedReasonColumns({
    code: "lost_search_reactivated",
    petPublicToken: "DIM-A1B2-C3D4",
  });

  it("reads as natural es-AR", () => {
    expect(caseOpenedReasonDisplay(row)).toBe(
      "Búsqueda reactivada por el dueño tras cierre automático por inactividad (mascota DIM-A1B2-C3D4)",
    );
  });

  it("is not double-rendered: no doubled prefix, no nested translation", () => {
    const label = caseOpenedReasonDisplay(row);
    // The failure mode R1#18 guards: running already-es-AR prose through a
    // translator. Rendering from the CODE means there is no prose to
    // re-translate — but assert the symptoms anyway.
    expect(label).not.toContain("Apertura automática");
    expect(label).not.toContain("Apertura manual");
    expect(label.match(/Búsqueda reactivada/g)).toHaveLength(1);
  });

  it("drops the English 'pet' the prose still carries", () => {
    // R1's requirement is zero leaked English tokens. Scenario 18's "unchanged"
    // guards against re-translation, not against fixing an English token —
    // a scenario cannot contradict its own requirement.
    expect(caseOpenedReasonDisplay(row)).not.toContain("(pet ");
    // The audit prose is untouched, as for every other writer.
    expect(row.openedReason).toBe(
      "Búsqueda reactivada por el dueño tras cierre automático por inactividad (pet DIM-A1B2-C3D4)",
    );
  });

  it("a pre-cutover row still renders via the free-text passthrough", () => {
    // Those rows exist and keep their original wording forever. R3.
    expect(
      caseOpenedReasonDisplay({
        openedReasonCode: null,
        openedReasonParams: null,
        openedReason:
          "Búsqueda reactivada por el dueño tras cierre automático por inactividad (pet DIM-A1B2-C3D4)",
      }),
    ).toBe(
      "Búsqueda reactivada por el dueño tras cierre automático por inactividad (pet DIM-A1B2-C3D4)",
    );
  });
});
