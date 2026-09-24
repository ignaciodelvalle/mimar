// The one place in this app that looks inside a Ley 25.326 art. 14 response.
//
// This module is now a thin re-export of `@dim/contract/reference`'s
// `subjectRightsSections` / `exportShareText` stays local (see PO decision
// 13A in `subject-data-summary.ts`'s header). The shared module's own test
// suite (`packages/contract/src/reference/__tests__/subject-rights-sections.
// test.ts`) covers the label table, the hide rules and the fallback label in
// depth; this file pins the two things that are this APP's responsibility:
// that the re-export actually wires up (a mistyped export name would compile
// fine and fail silently), and that `exportShareText` — which stayed local —
// still hands over the raw file untouched.

import { describe, expect, it } from "@jest/globals";

import { exportSections, exportShareText } from "./subject-data-summary";

describe("exportSections (re-exported from @dim/contract/reference)", () => {
  it("gives a known key its human Spanish label, not the raw snake_case name", () => {
    const sections = exportSections({ pets: [{}, {}, {}] });

    expect(sections).toEqual([{ key: "pets", label: "Tus mascotas", summary: "3 registros" }]);
  });

  it("hides pure-bookkeeping sections even when they hold rows", () => {
    const sections = exportSections({
      operator_feed_watermarks: [{ surface: "novedades" }],
      pets: [{}],
    });

    expect(sections.map((s) => s.key)).toEqual(["pets"]);
  });

  it("falls back to a generic label for a key it does not recognise, without dropping it", () => {
    const sections = exportSections({ una_tabla_que_no_existia: [{}, {}] });

    expect(sections).toEqual([
      { key: "una_tabla_que_no_existia", label: "Otros datos", summary: "2 registros" },
    ]);
  });

  it("reports a top-level scalar as present WITHOUT printing it", () => {
    // This card is a table of contents; a screen that started spilling values
    // would be re-rendering the file it just decided not to render — and the
    // values at this level are the subject's own PII.
    const sections = exportSections({ dni_last4: "4821" });

    expect(sections[0]?.summary).toBe("presente");
    expect(sections[0]?.summary).not.toContain("4821");
  });

  it("drops schema_version, which is metadata about the file and not data about the person", () => {
    const sections = exportSections({ schema_version: 5, pets: [{}] });

    expect(sections.map((s) => s.key)).toEqual(["pets"]);
  });

  it("keeps the RPC's own key order rather than sorting", () => {
    const sections = exportSections({ notifications: [{}], pets: [{}] });

    expect(sections.map((s) => s.key)).toEqual(["notifications", "pets"]);
  });
});

describe("exportShareText", () => {
  it("is the file itself, pretty-printed, with nothing prepended", () => {
    // The mutation this catches: adding a "Generado por miMAR el …" header. It
    // would stop the payload being valid JSON, turning a document another system
    // can read into a message only a human can — and portability is the point of
    // art. 14. Unaffected by PO decision 13A on purpose: the raw export must
    // stay complete regardless of what the readable summary hides or relabels.
    const text = exportShareText({ subject: { schema_version: 5, pets: [] } });

    expect(JSON.parse(text)).toEqual({ schema_version: 5, pets: [] });
    expect(text).toBe(JSON.stringify({ schema_version: 5, pets: [] }, null, 2));
  });
});
