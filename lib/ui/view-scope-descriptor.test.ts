// lib/ui/view-scope-descriptor.test.ts — the REPRODUCIBILITY proof for V2.
//
// This file is the deliverable, not the decoration. Everything else in V2 is a
// promise ("an export carries enough to regenerate what somebody signed"); this
// is where the promise is kept or broken.
//
// The three obligations, in order of how badly a failure hurts:
//
//  1. ROUND-TRIP — a serialized descriptor reconstructs the view and the SAME
//     values come out (the view state, and every es-AR description of it).
//  2. DIVERGENCE — mutating the source view CHANGES the serialization. Without
//     this, obligation 1 is satisfiable by a descriptor that stores nothing.
//     The headline case is the C3 subtlety: a whole-province mandate drilled to
//     one locality inside it has the SAME jurisdiction COUNT as the mandate and
//     a strictly FINER grain, so a descriptor built on length collapses two
//     genuinely different views into one payload.
//  3. PRIVACY — the serialized key set is closed. Scope names jurisdictions,
//     never people.

import { describe, expect, it } from "vitest";

import { describeMandate } from "@/lib/ui/scope-chrome";
import { describeNarrowedView } from "@/lib/ui/view-scope-caption";
import {
  CSV_SCOPE_PREFIX,
  VIEW_SCOPE_SERIALIZED_KEYS,
  type ViewScopeAuthority,
  describeViewScope,
  isNarrowedBelowMandate,
  makeViewScopeDescriptor,
  parseViewScope,
  parseViewScopeFromCsv,
  serializeViewScope,
  toPanoramaViewState,
  viewScopeCsvHeaderLines,
  viewScopeDigest,
} from "@/lib/ui/view-scope-descriptor";
import {
  type PanoramaViewState,
  makeViewState,
  toPeriodSearchParams,
  toScopeFilter,
} from "@/src/modules/panorama/domain/view-state";
import { explainViewState } from "@/src/modules/panorama/domain/view-state-caption";

// The CABA case, exactly as `narrowGovtScope` produces it (lib/domain/
// jurisdiction-canonical.ts): the mandate is the two-tier whole-province entry,
// and the ?locality=Palermo drill replaces it with a SPECIFIC pair. Same
// length, different set.
const CABA_MANDATE = [{ province: "Ciudad Autónoma de Buenos Aires", locality: "" }];
const CABA_DRILLED = [{ province: "Ciudad Autónoma de Buenos Aires", locality: "Palermo" }];

const GOVT_WHOLE_PROVINCE: ViewScopeAuthority = {
  role: "govt",
  mandate: CABA_MANDATE,
  effective: CABA_MANDATE,
  adminDrill: null,
};

const GOVT_DRILLED_TO_PALERMO: ViewScopeAuthority = {
  role: "govt",
  mandate: CABA_MANDATE,
  effective: CABA_DRILLED,
  adminDrill: null,
};

// NO FIELD HERE MAY EQUAL THE PARSER'S FALLBACK.
//
// This fixture used to read `basis: "valid"`, `verifiedOnly: false`,
// `encoding: null` — which are, exactly, what parseViewScope substitutes when a
// field is MISSING (`?? "valid"`, `=== true`, `?? null`). The round-trip test
// therefore could not tell a parser that preserves those three fields from one
// that discards them. Measured, not argued: replacing all three reads with
// hardcoded defaults left all 10 tests green (cowork H2, reproduced 2026-07-28).
//
// A reproducibility fixture whose values are the defaults proves reproducibility
// of nothing. Each value below is deliberately the OTHER side of its fallback.
const NON_DEFAULT_BASIS = "transaction" as const; // parser falls back to "valid"
const NON_DEFAULT_VERIFIED_ONLY = true; // parser falls back to false
const NON_DEFAULT_ENCODING = "percapita" as const; // parser falls back to null

function viewOf(over: Partial<PanoramaViewState> = {}): PanoramaViewState {
  return makeViewState({
    scope: { kind: "province", province: "Ciudad Autónoma de Buenos Aires" },
    period: { kind: "preset", preset: "90d" },
    asOf: "2026-05-01T00:00:00.000Z",
    basis: NON_DEFAULT_BASIS,
    layers: ["perdidas"],
    verifiedOnly: NON_DEFAULT_VERIFIED_ONLY,
    preset: "bienestar",
    encoding: NON_DEFAULT_ENCODING,
    ...over,
  });
}

describe("ViewScopeDescriptor · reproducibility", () => {
  it("round-trips a serialized descriptor back into the same view state", () => {
    const source = viewOf();
    const descriptor = makeViewScopeDescriptor({
      authority: GOVT_DRILLED_TO_PALERMO,
      view: source,
      grain: "locality",
      generatedAt: new Date("2026-07-26T12:00:00.000Z"),
    });

    const rebuilt = toPanoramaViewState(parseViewScope(serializeViewScope(descriptor)));

    // Every field that changes a NUMBER survives the trip.
    expect(rebuilt.scope).toEqual(source.scope);
    expect(rebuilt.period).toEqual(source.period);
    expect(rebuilt.asOf).toBe(source.asOf);
    expect(rebuilt.basis).toBe(source.basis);
    expect(rebuilt.layers).toEqual(source.layers);
    expect(rebuilt.verifiedOnly).toBe(source.verifiedOnly);
    expect(rebuilt.preset).toBe(source.preset);
    expect(rebuilt.encoding).toBe(source.encoding);

    // …and so do the two projections the LOADERS actually consume, which is the
    // only reason a round-tripped scope is worth anything.
    expect(toScopeFilter(rebuilt)).toEqual(toScopeFilter(source));
    expect(toPeriodSearchParams(rebuilt)).toEqual(toPeriodSearchParams(source));
  });

  it("regenerates the same es-AR descriptions from the artifact alone", () => {
    const source = viewOf();
    const descriptor = makeViewScopeDescriptor({
      authority: GOVT_DRILLED_TO_PALERMO,
      view: source,
      grain: "locality",
    });

    const rebuilt = parseViewScope(serializeViewScope(descriptor));

    // The one-line view sentence — the caption every artifact prints.
    expect(explainViewState(toPanoramaViewState(rebuilt))).toBe(explainViewState(source));

    // The scope vocabulary is the C3 builders', not a second one invented here.
    expect(describeViewScope(rebuilt)).toEqual({
      mandate: describeMandate(CABA_MANDATE),
      narrowed: describeNarrowedView({
        role: "govt",
        mandateJurisdictions: CABA_MANDATE,
        effectiveJurisdictions: CABA_DRILLED,
      }),
    });
  });

  it("survives a jurisdiction list handed over in a different order", () => {
    const a: ViewScopeAuthority = {
      role: "govt",
      mandate: [
        { province: "Córdoba", locality: "Villa María" },
        { province: "Córdoba", locality: "Río Cuarto" },
      ],
      effective: [
        { province: "Córdoba", locality: "Villa María" },
        { province: "Córdoba", locality: "Río Cuarto" },
      ],
      adminDrill: null,
    };
    const b: ViewScopeAuthority = {
      role: "govt",
      mandate: [...a.mandate].reverse(),
      effective: [...a.effective].reverse(),
      adminDrill: null,
    };
    const view = viewOf();
    const da = makeViewScopeDescriptor({ authority: a, view, grain: "locality" });
    const db = makeViewScopeDescriptor({ authority: b, view, grain: "locality" });

    // Same view, same bytes — artifact identity must not depend on a row order.
    expect(serializeViewScope(da)).toBe(serializeViewScope(db));
    expect(viewScopeDigest(da)).toBe(viewScopeDigest(db));
  });

  it("keeps the digest stable across two exports of one view", () => {
    const view = viewOf();
    const morning = makeViewScopeDescriptor({
      authority: GOVT_DRILLED_TO_PALERMO,
      view,
      grain: "locality",
      generatedAt: "2026-07-26T09:00:00.000Z",
    });
    const afternoon = makeViewScopeDescriptor({
      authority: GOVT_DRILLED_TO_PALERMO,
      view,
      grain: "locality",
      generatedAt: "2026-07-26T17:30:00.000Z",
    });

    // A CSV and a PNG cut hours apart from the SAME board must prove they
    // describe one question — so generatedAt sits outside the digest.
    expect(viewScopeDigest(morning)).toBe(viewScopeDigest(afternoon));
    expect(serializeViewScope(morning)).not.toBe(serializeViewScope(afternoon));
  });
});

describe("ViewScopeDescriptor · divergence (the C3 subtlety)", () => {
  it("serializes a whole-province mandate DIFFERENTLY from the same mandate drilled to one locality", () => {
    const view = viewOf();
    // GRAIN IS HELD CONSTANT on purpose. In the wild these two views also differ
    // in rendered grain, and letting that difference into the fixture would make
    // the assertion pass for the WRONG reason — a descriptor that stored only a
    // jurisdiction COUNT would still diverge on grain and look correct. Pinning
    // grain forces the assertion to rest on the jurisdictions alone. (Verified:
    // with a count-only `effective` these two DID diverge on grain, and this
    // test was green while the descriptor was broken.)
    const whole = makeViewScopeDescriptor({
      authority: GOVT_WHOLE_PROVINCE,
      view,
      grain: "locality",
    });
    const drilled = makeViewScopeDescriptor({
      authority: GOVT_DRILLED_TO_PALERMO,
      view,
      grain: "locality",
    });

    // The trap: SAME jurisdiction count on both sides. A descriptor keyed on
    // length — or one that stored only `effective`, or only `mandate` — would
    // emit identical payloads here and reproduce the wrong view.
    expect(whole.authority.effective).toHaveLength(drilled.authority.effective.length);
    expect(whole.view).toEqual(drilled.view);
    expect(serializeViewScope(whole)).not.toBe(serializeViewScope(drilled));
    expect(viewScopeDigest(whole)).not.toBe(viewScopeDigest(drilled));

    // And the descriptor knows WHICH of the two it is.
    expect(isNarrowedBelowMandate(whole)).toBe(false);
    expect(isNarrowedBelowMandate(drilled)).toBe(true);
  });

  it("diverges when the source view is mutated after serialization", () => {
    const source = viewOf();
    const before = serializeViewScope(
      makeViewScopeDescriptor({
        authority: GOVT_DRILLED_TO_PALERMO,
        view: source,
        grain: "locality",
      }),
    );

    // One mutation per coordinate that changes what an operator SEES. Each must
    // move the bytes; a coordinate that does not is a coordinate the artifact
    // cannot reproduce.
    // Each entry also carries a READ, because "the bytes moved" only guards the
    // SERIALIZE side. The parser can happily write the mutated value into the
    // payload and then drop it on the way back — which is exactly what this
    // module did for basis/verifiedOnly/encoding until 2026-07-28 (cowork H2).
    // Asserting the round-tripped value closes the other half.
    const mutations: Array<
      [string, Partial<PanoramaViewState>, (v: PanoramaViewState) => unknown]
    > = [
      ["scope", { scope: { kind: "province", province: "Córdoba" } }, (v) => v.scope],
      ["period", { period: { kind: "preset", preset: "7d" } }, (v) => v.period],
      ["asOf", { asOf: "2026-06-01T00:00:00.000Z" }, (v) => v.asOf],
      // Mutations are the OPPOSITE side of the fixture's non-default values —
      // mutating a field to the value it already holds moves no bytes.
      ["basis", { basis: "valid" }, (v) => v.basis],
      ["layers", { layers: ["perdidas", "denuncias"] }, (v) => v.layers],
      ["verifiedOnly", { verifiedOnly: false }, (v) => v.verifiedOnly],
      ["encoding", { encoding: "bivariate" }, (v) => v.encoding],
      ["preset", { preset: "sintomas" }, (v) => v.preset],
    ];
    for (const [name, over, read] of mutations) {
      const mutated = viewOf(over);
      const after = serializeViewScope(
        makeViewScopeDescriptor({
          authority: GOVT_DRILLED_TO_PALERMO,
          view: mutated,
          grain: "locality",
        }),
      );
      expect(after, `mutating ${name} must change the serialized scope`).not.toBe(before);

      // PARSE SIDE: the mutated value comes back, and comes back DIFFERENT from
      // the unmutated source. The second half matters — a parser that always
      // returns the fixture's value would satisfy the first.
      const rebuilt = toPanoramaViewState(parseViewScope(after));
      expect(read(rebuilt), `${name} must survive the round trip`).toEqual(read(mutated));
      expect(read(rebuilt), `${name} must differ from the unmutated source`).not.toEqual(
        read(source),
      );
    }

    // The rendered GRAIN is not a ViewState field — it is derived at runtime
    // from scope + zoom — so it must be carried explicitly or the same URL
    // reproduces a province choropleth where a department one was signed.
    const coarser = serializeViewScope(
      makeViewScopeDescriptor({
        authority: GOVT_DRILLED_TO_PALERMO,
        view: source,
        grain: "province",
      }),
    );
    expect(coarser, "mutating grain must change the serialized scope").not.toBe(before);

    // And the authority half: same view, different asker, different artifact.
    const asAdmin = serializeViewScope(
      makeViewScopeDescriptor({
        authority: {
          role: "admin",
          mandate: [],
          effective: [],
          adminDrill: { province: "Ciudad Autónoma de Buenos Aires", locality: "Palermo" },
        },
        view: source,
        grain: "locality",
      }),
    );
    expect(asAdmin, "a different authority must change the serialized scope").not.toBe(before);
  });

  it("refuses a descriptor from a version it cannot read", () => {
    const d = makeViewScopeDescriptor({
      authority: GOVT_WHOLE_PROVINCE,
      view: viewOf(),
      grain: "province",
    });
    const foreign = serializeViewScope(d).replace('"v":1', '"v":99');
    // Refusing beats defaulting: a half-understood scope would let a
    // reproduction claim fidelity it does not have.
    expect(() => parseViewScope(foreign)).toThrow(/unsupported version/);
  });
});

describe("ViewScopeDescriptor · CSV carriage", () => {
  it("round-trips through an exported CSV's header block", () => {
    const d = makeViewScopeDescriptor({
      authority: GOVT_DRILLED_TO_PALERMO,
      view: viewOf(),
      grain: "locality",
      generatedAt: "2026-07-26T12:00:00.000Z",
    });
    const csv = [...viewScopeCsvHeaderLines(d), "Capa,Unidad,Valor", "Pérdidas,Palermo,12"].join(
      "\r\n",
    );

    expect(parseViewScopeFromCsv(csv)).toEqual(d);
    // The block sits ABOVE the column header, so a truncated read still carries
    // its provenance.
    expect(csv.indexOf(CSV_SCOPE_PREFIX)).toBeLessThan(csv.indexOf("Capa,Unidad,Valor"));
    // Human lines use the C3 vocabulary — no second wording invented for files.
    expect(csv).toContain(`# miMAR · vista: ${describeViewScope(d).narrowed}`);
  });

  it("reads a scope-less CSV as ABSENT, not as a wrong scope", () => {
    expect(parseViewScopeFromCsv("Capa,Unidad,Valor\r\nPérdidas,Palermo,12")).toBeNull();
  });
});

describe("ViewScopeDescriptor · privacy", () => {
  it("serializes a closed key set — jurisdictions, never people", () => {
    const d = makeViewScopeDescriptor({
      authority: GOVT_DRILLED_TO_PALERMO,
      view: viewOf({ period: { kind: "custom", from: "2026-01-01", to: "2026-06-30" } }),
      grain: "locality",
      generatedAt: "2026-07-26T12:00:00.000Z",
    });

    const seen = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const v of value) walk(v);
        return;
      }
      if (typeof value === "object" && value !== null) {
        for (const [k, v] of Object.entries(value)) {
          seen.add(k);
          walk(v);
        }
      }
    };
    walk(JSON.parse(serializeViewScope(d)));

    const unexpected = [...seen].filter((k) => !VIEW_SCOPE_SERIALIZED_KEYS.includes(k));
    expect(
      unexpected,
      "a new descriptor field must be reviewed for PII before it can ride an export",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// REFUSAL PATHS — the parser's seven throws, six of which had no test.
//
// A parser is only trustworthy in both directions: it must reconstruct a good
// descriptor AND refuse a broken one. The round-trip tests above prove the
// first half; a parser that accepted anything would pass all of them. Every
// throw below is a promise this module makes in its own header ("refusing beats
// defaulting"), and an untested promise is a preference.
// ---------------------------------------------------------------------------

describe("parseViewScope — what it refuses", () => {
  /** A structurally valid payload, so each case below varies exactly one thing. */
  function goodPayload(): Record<string, unknown> {
    const d = makeViewScopeDescriptor({
      authority: GOVT_DRILLED_TO_PALERMO,
      view: viewOf(),
      grain: "locality",
    });
    return JSON.parse(serializeViewScope(d));
  }

  it("the baseline payload parses — otherwise every case below would pass for the wrong reason", () => {
    expect(() => parseViewScope(JSON.stringify(goodPayload()))).not.toThrow();
  });

  it("refuses text that is not JSON", () => {
    expect(() => parseViewScope("{not json")).toThrow(/not valid JSON/i);
  });

  it("refuses valid JSON that is not an object", () => {
    expect(() => parseViewScope("42")).toThrow(/not an object/i);
    expect(() => parseViewScope('"a string"')).toThrow(/not an object/i);
    expect(() => parseViewScope("null")).toThrow(/not an object/i);
  });

  it("refuses an ARRAY too — just not with that message", () => {
    // `typeof [] === "object"` in JS, so an array slips past the not-an-object
    // guard and is caught one line later by the version check. It IS refused,
    // which is what matters; asserted separately rather than folded into the
    // case above so the test states what actually happens instead of what the
    // guard's name suggests.
    expect(() => parseViewScope("[]")).toThrow();
  });

  it("refuses a version it does not speak", () => {
    const p = goodPayload();
    p.v = 999;
    expect(() => parseViewScope(JSON.stringify(p))).toThrow();
  });

  it("refuses a payload missing authority or view", () => {
    const noAuthority = goodPayload();
    // biome-ignore lint/performance/noDelete: exercising an absent key is the point
    delete noAuthority.authority;
    expect(() => parseViewScope(JSON.stringify(noAuthority))).toThrow(/missing authority or view/i);

    const noView = goodPayload();
    // biome-ignore lint/performance/noDelete: exercising an absent key is the point
    delete noView.view;
    expect(() => parseViewScope(JSON.stringify(noView))).toThrow(/missing authority or view/i);
  });

  it("refuses a role outside admin|govt|national — an artifact may not invent an authority", () => {
    const p = goodPayload();
    (p.authority as Record<string, unknown>).role = "owner";
    expect(() => parseViewScope(JSON.stringify(p))).toThrow(
      /role must be admin, govt or national/i,
    );
  });

  it("accepts the read-only national role as an authority (universal read scope, no mandate)", () => {
    const p = goodPayload();
    (p.authority as Record<string, unknown>).role = "national";
    (p.authority as Record<string, unknown>).mandate = [];
    (p.authority as Record<string, unknown>).effective = [];
    expect(() => parseViewScope(JSON.stringify(p))).not.toThrow();
  });

  it("refuses a mandate/effective that is not a jurisdiction list", () => {
    const p = goodPayload();
    (p.authority as Record<string, unknown>).mandate = ["Buenos Aires"];
    expect(() => parseViewScope(JSON.stringify(p))).toThrow(/province, locality/i);
  });

  it("refuses a view with no scope or no period", () => {
    const noScope = goodPayload();
    (noScope.view as Record<string, unknown>).scope = null;
    expect(() => parseViewScope(JSON.stringify(noScope))).toThrow(
      /scope and view.period|required/i,
    );

    const noPeriod = goodPayload();
    (noPeriod.view as Record<string, unknown>).period = null;
    expect(() => parseViewScope(JSON.stringify(noPeriod))).toThrow(/required/i);
  });

  // D6 (PO decision 2026-07-27) — the one that used to DEFAULT instead of refuse.
  it("refuses a missing or invalid grain instead of assuming province", () => {
    // The old behaviour was `?? "province"`: a descriptor signed over a
    // DEPARTMENT map would silently reproduce a PROVINCE one — the exact
    // divergence the C3 test claims to prevent.
    const missing = goodPayload();
    // biome-ignore lint/performance/noDelete: absence is the case under test
    delete (missing.view as Record<string, unknown>).grain;
    expect(() => parseViewScope(JSON.stringify(missing))).toThrow(/grain/i);

    const bogus = goodPayload();
    (bogus.view as Record<string, unknown>).grain = "barrio";
    expect(() => parseViewScope(JSON.stringify(bogus))).toThrow(/grain/i);
  });

  it("round-trips BOTH grains — refusing the absent one must not break the present ones", () => {
    for (const grain of ["province", "locality"] as const) {
      const d = makeViewScopeDescriptor({
        authority: GOVT_DRILLED_TO_PALERMO,
        view: viewOf(),
        grain,
      });
      expect(parseViewScope(serializeViewScope(d)).view.grain).toBe(grain);
    }
  });
});
