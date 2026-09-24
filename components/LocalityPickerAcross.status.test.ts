// Tests for resolveLocalityFieldStatus — what the locality field says about
// itself at each moment.
//
// THE BUG (QA report 2026-08-01): typing "Palermo" or "La Plata" showed "Sin
// resultados." and the team concluded the search was broken. It was not. The
// old condition was
//
//   !pending && query.length >= MIN_QUERY_LENGTH && results.length === 0
//
// and `pending` (useTransition) only covers the in-flight request — NOT the
// 200 ms debounce before it. So the instant the second character landed,
// results were still [] and no transition had started: "Sin resultados."
// rendered before a single request had been sent, and re-rendered on every
// keystroke. It said "nothing found" when it meant "not asked yet".
//
// The restriction itself is correct and stays: territorial integrity depends on
// the value resolving to a real ar_localities row. What is fixed here is that
// the field now has something to say in every state instead of only that one.

import { describe, expect, it } from "vitest";

import { resolveLocalityFieldStatus } from "./LocalityPickerAcross";

const base = {
  query: "",
  settledQuery: null as string | null,
  resultCount: 0,
  errored: false,
  hasPick: false,
  hasUntouchedDefault: false,
};

describe("resolveLocalityFieldStatus", () => {
  it("says 'searching' during the debounce window, before any request is sent", () => {
    // This is the exact frame the old code called "Sin resultados.": two
    // characters typed, timer scheduled, no results, no transition in flight.
    expect(
      resolveLocalityFieldStatus({ ...base, query: "Pa", settledQuery: null, resultCount: 0 }),
    ).toBe("searching");
  });

  it("keeps saying 'searching' while the user extends a query that already had an answer", () => {
    // "Pal" was answered; the user is now on "Palermo". Reporting on "Pal" here
    // is how a stale answer gets read as an answer about the new text.
    expect(
      resolveLocalityFieldStatus({
        ...base,
        query: "Palermo",
        settledQuery: "Pal",
        resultCount: 5,
      }),
    ).toBe("searching");
  });

  it("says 'no-results' only once a search for THIS exact text came back empty", () => {
    expect(
      resolveLocalityFieldStatus({
        ...base,
        query: "Xyzzyville",
        settledQuery: "Xyzzyville",
        resultCount: 0,
      }),
    ).toBe("no-results");
  });

  it("says 'needs-pick' when there are options on screen and nothing has been chosen", () => {
    // The state that used to be completely silent and then failed at submit
    // with "Elegí la localidad/barrio de la lista de sugerencias."
    expect(
      resolveLocalityFieldStatus({
        ...base,
        query: "La Plata",
        settledQuery: "La Plata",
        resultCount: 3,
      }),
    ).toBe("needs-pick");
  });

  it("says 'committed' once a catalog row is picked", () => {
    expect(
      resolveLocalityFieldStatus({
        ...base,
        query: "La Plata",
        settledQuery: "La Plata",
        resultCount: 3,
        hasPick: true,
      }),
    ).toBe("committed");
  });

  it("keeps 'committed' while the re-search triggered by the pick is still in flight", () => {
    // Picking sets the input to the row's name, which re-runs the search. If
    // "searching" outranked "committed", the confirmation the user just earned
    // would flicker away and read as the pick not having registered.
    expect(
      resolveLocalityFieldStatus({
        ...base,
        query: "La Plata",
        settledQuery: "La Pl",
        resultCount: 0,
        hasPick: true,
      }),
    ).toBe("committed");
  });

  it("treats an untouched edit-mode pre-fill as committed", () => {
    expect(
      resolveLocalityFieldStatus({
        ...base,
        query: "Palermo",
        settledQuery: null,
        hasUntouchedDefault: true,
      }),
    ).toBe("committed");
  });

  it("stops treating the pre-fill as committed once the user types over it", () => {
    // hasUntouchedDefault goes false on the first keystroke: the old text is no
    // longer what is in the box, so it must be re-picked.
    expect(
      resolveLocalityFieldStatus({
        ...base,
        query: "Palerm",
        settledQuery: "Palerm",
        resultCount: 2,
        hasUntouchedDefault: false,
      }),
    ).toBe("needs-pick");
  });

  it("stays 'idle' below the minimum query length instead of claiming nothing was found", () => {
    expect(resolveLocalityFieldStatus({ ...base, query: "P" })).toBe("idle");
  });

  it("stays 'idle' on an empty field", () => {
    expect(resolveLocalityFieldStatus({ ...base, query: "" })).toBe("idle");
  });

  it("stays 'idle' when the search errored — the error message speaks for itself", () => {
    // Otherwise the field stacks "No pudimos buscar localidades ahora" on top of
    // "No encontramos X", which are two different claims about the same moment.
    expect(
      resolveLocalityFieldStatus({
        ...base,
        query: "Palermo",
        settledQuery: "Palermo",
        resultCount: 0,
        errored: true,
      }),
    ).toBe("idle");
  });
});
