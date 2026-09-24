// lib/ui/view-scope-descriptor.ts — V2 (A SERIALIZABLE SCOPE ON EVERY EXPORT).
//
// WHY THIS EXISTS
// ---------------
// Today the maximum output of this product is a PDF, a CSV or a PNG that states
// its scope in PROSE ("Nacional · últimos 90 días"). Prose is readable and
// unreproducible: nobody can take that sentence and regenerate the numbers.
// The moment an artifact leaves the screen — attached to an expediente, handed
// to an intendente, signed under Ley 25.506 — "reproducible" becomes a claim
// somebody may have to defend, and a caption cannot defend it.
//
// A ViewScopeDescriptor is that same scope as an OBJECT: the complete set of
// coordinates required to reconstruct the view an artifact was cut from. It
// carries no numbers, no rows and no people — only the QUESTION that was asked.
// Re-ask the question, get the answer back.
//
// THE TWO HALVES, AND WHY BOTH ARE MANDATORY
// ------------------------------------------
// A `PanoramaViewState` alone does NOT reproduce a view. Two operators opening
// the identical URL see different numbers, because the loaders scope every
// query by WHO IS ASKING. So the descriptor is:
//
//   authority — the jurisdictional standing of the asker (role, mandate,
//               effective view, admin drill). Answers "what was this account
//               allowed and asked to see?"
//   view      — the URL-reproducible coordinates (scope, grain, period, as-of +
//               basis, layers, encoding, verified filter, preset). Answers
//               "which cut of it was on screen?"
//
// Serialize only the second half and you have a link, not a snapshot.
//
// THE SUBTLETY THAT DICTATES THE SHAPE (C3, view-scope-caption.ts)
// ----------------------------------------------------------------
// A govt whose MANDATE is a single whole-province assignment (CABA, stored as
// the two-tier canonical entry), drilled into ONE locality inside it
// (`?locality=Palermo`), produces an EFFECTIVE view of length 1 — the same
// COUNT as the mandate, at a strictly FINER grain. `narrowGovtScope` returns
// `[{province:'CABA', locality:'Palermo'}]` where the mandate was
// `[{province:'CABA', locality:''}]`.
//
// A descriptor that stored a jurisdiction COUNT, or stored only `effective`,
// would serialize those two genuinely different views IDENTICALLY — and the
// reproduction would silently pick the wrong one. That is why `mandate` and
// `effective` are BOTH first-class members, compared by SET (`jurisdictionsEqual`,
// re-used from view-scope-caption.ts — never re-implemented here), never by
// length. `view-scope-descriptor.test.ts` pins the divergence.
//
// WHAT THIS DELIBERATELY IS NOT
// -----------------------------
// Not a signature, not an expediente number, not a tamper-evidence scheme. The
// digest below is a stable IDENTITY for a view, computed with a non-cryptographic
// hash (FNV-1a) — it detects accidental divergence between two artifacts, and it
// is trivially forgeable. Any integrity claim belongs to the PO-gated
// signature work; this module is the reproducible payload that work will sign.
//
// PRIVACY: the descriptor NAMES JURISDICTIONS AND NEVER PEOPLE. The serialized
// key set is closed (`VIEW_SCOPE_SERIALIZED_KEYS`) and fenced by a test, so a
// future field carrying an owner, a DNI, a pet token or free text cannot reach
// an exported artifact by accident.
//
// es-AR user copy stays in the caption builders this module delegates to;
// identifiers and comments in English (project invariant #4).

import { type GobReadRole, hasNationalReadScope } from "@/lib/domain/jurisdiction-canonical";
import { describeMandate } from "@/lib/ui/scope-chrome";
import {
  type ViewScopeJurisdiction,
  describeNarrowedView,
  jurisdictionKey,
  jurisdictionsEqual,
} from "@/lib/ui/view-scope-caption";
import type { PresetId } from "@/src/modules/panorama/domain/presets";
import type { TimeBasis } from "@/src/modules/panorama/domain/time-scrub";
import type { AggregationLevel, LayerId } from "@/src/modules/panorama/domain/types";
import {
  type EncodingId,
  type PanoramaViewState,
  type ViewPeriod,
  type ViewScope,
  makeViewState,
} from "@/src/modules/panorama/domain/view-state";

/** Bumped whenever the serialized shape changes in a way an old parser cannot
 *  read. `parseViewScope` REFUSES a foreign version rather than guessing — a
 *  half-understood scope is worse than an absent one. */
export const VIEW_SCOPE_DESCRIPTOR_VERSION = 1;

/**
 * The asker's jurisdictional standing. `mandate` is what the ACCOUNT holds;
 * `effective` is what the LOADERS actually queried after the page's own filter
 * resolution (`narrowGovtScope`). They may share a length and still differ —
 * see the module docblock.
 */
export type ViewScopeAuthority = {
  role: GobReadRole;
  /** Raw session assignments. Admin and national hold NONE: their mandate is
   *  universal, and an empty list here means "universal", not "nothing" — role
   *  disambiguates (hasNationalReadScope). */
  mandate: ViewScopeJurisdiction[];
  /** What the queries were actually scoped to. Admin: empty unless drilled. */
  effective: ViewScopeJurisdiction[];
  /** Admin's narrowing is a DRILL, not an assignment list — kept separate so an
   *  admin province view never masquerades as a govt mandate. */
  adminDrill: { province: string; locality: string | null } | null;
};

/** The URL-reproducible coordinates. Mirrors `PanoramaViewState` minus the two
 *  fields that change nothing about the DATA (`representation`, `camera`) and
 *  PLUS `grain` — the rendered aggregation level, which is derived at runtime
 *  from scope + zoom and is therefore NOT recoverable from the ViewState alone. */
export type ViewScopeViewCoordinates = {
  scope: ViewScope;
  /** The administrative grain actually rendered (province vs locality cells). */
  grain: AggregationLevel;
  period: ViewPeriod;
  /** The temporal cut, or null at the live edge. */
  asOf: string | null;
  /** Bitemporal lens. Only meaningful while asOf != null, but always recorded —
   *  an artifact that travels alone cannot infer the default. */
  basis: TimeBasis;
  layers: LayerId[];
  encoding: EncodingId | null;
  verifiedOnly: boolean;
  preset: PresetId | null;
};

export type ViewScopeDescriptor = {
  v: number;
  authority: ViewScopeAuthority;
  view: ViewScopeViewCoordinates;
  /** When the ARTIFACT was cut. Deliberately OUTSIDE the digest: two exports of
   *  the same view minutes apart must prove they are the same view. */
  generatedAt: string | null;
};

/**
 * The closed set of top-level and nested keys the serialization may contain.
 * A privacy fence, not documentation: `view-scope-descriptor.test.ts` walks a
 * serialized descriptor and fails on any key outside this set, so a future
 * `ownerName` / `dni` / `petToken` / free-text filter cannot ride an export out
 * of the building unnoticed.
 */
export const VIEW_SCOPE_SERIALIZED_KEYS: readonly string[] = [
  "v",
  "authority",
  "role",
  "mandate",
  "effective",
  "adminDrill",
  "province",
  "locality",
  "view",
  "scope",
  "kind",
  "grain",
  "period",
  "preset",
  "from",
  "to",
  "asOf",
  "basis",
  "layers",
  "encoding",
  "verifiedOnly",
  "generatedAt",
];

// ---------------------------------------------------------------------------
// Canonicalization — one view, one serialization
// ---------------------------------------------------------------------------

/**
 * Dedupe + sort a jurisdiction list by its canonical key. Two accounts assigned
 * the same localities in a different ORDER describe the same view and must
 * serialize (and digest) identically; without this, artifact equality would
 * depend on a database row order nobody controls.
 */
function canonicalJurisdictions(list: readonly ViewScopeJurisdiction[]): ViewScopeJurisdiction[] {
  const byKey = new Map<string, ViewScopeJurisdiction>();
  for (const j of list) {
    byKey.set(jurisdictionKey(j), { province: j.province, locality: j.locality });
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, j]) => j);
}

/** Rebuild the scope union with a FIXED key order per variant. Relying on the
 *  input object's insertion order would make the serialization depend on which
 *  code path built it. */
function canonicalScope(scope: ViewScope): ViewScope {
  switch (scope.kind) {
    case "national":
      return { kind: "national" };
    case "province":
      return { kind: "province", province: scope.province };
    case "locality":
      return { kind: "locality", province: scope.province, locality: scope.locality };
  }
}

/** Same fixed-order rebuild for the period union. */
function canonicalPeriod(period: ViewPeriod): ViewPeriod {
  return period.kind === "custom"
    ? { kind: "custom", from: period.from, to: period.to }
    : { kind: "preset", preset: period.preset };
}

export type MakeViewScopeDescriptorInput = {
  authority: ViewScopeAuthority;
  /** The canonical view value the console already holds. */
  view: PanoramaViewState;
  /** The grain the map is CURRENTLY rendering (not derivable from `view`). */
  grain: AggregationLevel;
  /** When this artifact was cut. Null while nothing has been exported yet. */
  generatedAt?: Date | string | null;
};

/**
 * Build the descriptor from what a surface already has: the ViewState, the
 * rendered grain, and the server-resolved authority. Nothing is re-derived and
 * nothing is fetched — this is a projection, in the same discipline as every
 * other panorama surface.
 */
export function makeViewScopeDescriptor(input: MakeViewScopeDescriptorInput): ViewScopeDescriptor {
  const { authority, view, grain } = input;
  const generatedAt =
    input.generatedAt == null
      ? null
      : input.generatedAt instanceof Date
        ? input.generatedAt.toISOString()
        : input.generatedAt;

  return {
    v: VIEW_SCOPE_DESCRIPTOR_VERSION,
    authority: {
      role: authority.role,
      mandate: canonicalJurisdictions(authority.mandate),
      effective: canonicalJurisdictions(authority.effective),
      adminDrill: authority.adminDrill
        ? {
            province: authority.adminDrill.province,
            locality: authority.adminDrill.locality ?? null,
          }
        : null,
    },
    view: {
      scope: canonicalScope(view.scope),
      grain,
      period: canonicalPeriod(view.period),
      asOf: view.asOf,
      basis: view.basis,
      layers: [...view.layers],
      encoding: view.encoding,
      verifiedOnly: view.verifiedOnly,
      preset: view.preset,
    },
    generatedAt,
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON. The object literal below fixes the key order explicitly
 * rather than trusting the descriptor's construction path, so the SAME view
 * always yields the SAME bytes — the property the digest and every artifact
 * comparison rest on.
 */
export function serializeViewScope(d: ViewScopeDescriptor): string {
  return JSON.stringify({
    v: d.v,
    authority: {
      role: d.authority.role,
      mandate: canonicalJurisdictions(d.authority.mandate).map((j) => ({
        province: j.province,
        locality: j.locality,
      })),
      effective: canonicalJurisdictions(d.authority.effective).map((j) => ({
        province: j.province,
        locality: j.locality,
      })),
      adminDrill: d.authority.adminDrill
        ? {
            province: d.authority.adminDrill.province,
            locality: d.authority.adminDrill.locality,
          }
        : null,
    },
    view: {
      scope: canonicalScope(d.view.scope),
      grain: d.view.grain,
      period: canonicalPeriod(d.view.period),
      asOf: d.view.asOf,
      basis: d.view.basis,
      layers: d.view.layers,
      encoding: d.view.encoding,
      verifiedOnly: d.view.verifiedOnly,
      preset: d.view.preset,
    },
    generatedAt: d.generatedAt,
  });
}

function isJurisdictionArray(value: unknown): value is ViewScopeJurisdiction[] {
  return (
    Array.isArray(value) &&
    value.every(
      (j) =>
        typeof j === "object" &&
        j !== null &&
        typeof (j as ViewScopeJurisdiction).province === "string" &&
        typeof (j as ViewScopeJurisdiction).locality === "string",
    )
  );
}

/**
 * Parse a serialized descriptor back into a value. Throws — loudly — on a
 * foreign version or a malformed shape. A silently-defaulted scope would let a
 * reproduction claim to have regenerated a view it never saw; refusing is the
 * only honest failure mode for an artifact whose whole purpose is fidelity.
 */
export function parseViewScope(text: string): ViewScopeDescriptor {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("ViewScope: not valid JSON");
  }
  if (typeof raw !== "object" || raw === null) throw new Error("ViewScope: not an object");
  const o = raw as Record<string, unknown>;
  if (o.v !== VIEW_SCOPE_DESCRIPTOR_VERSION) {
    throw new Error(
      `ViewScope: unsupported version ${String(o.v)} (this build reads v${VIEW_SCOPE_DESCRIPTOR_VERSION})`,
    );
  }
  const authority = o.authority as Record<string, unknown> | undefined;
  const view = o.view as Record<string, unknown> | undefined;
  if (!authority || !view) throw new Error("ViewScope: missing authority or view");
  if (authority.role !== "admin" && authority.role !== "govt" && authority.role !== "national") {
    throw new Error("ViewScope: role must be admin, govt or national");
  }
  if (!isJurisdictionArray(authority.mandate) || !isJurisdictionArray(authority.effective)) {
    throw new Error("ViewScope: mandate/effective must be (province, locality) lists");
  }
  // GRAIN IS REQUIRED — refusing beats defaulting (PO decision D6, 2026-07-27).
  //
  // This used to fall back to "province" further down (`?? "province"`), which
  // contradicted the doctrine this module states about itself: a descriptor
  // with no grain would silently reproduce a PROVINCE choropleth where a
  // DEPARTMENT one had been signed. That is precisely the divergence the C3
  // test claims to prevent — an artifact must reproduce what somebody signed,
  // or say it cannot.
  if (view.grain !== "province" && view.grain !== "locality") {
    throw new Error(
      'ViewScope: view.grain is required and must be "province" or "locality" — ' +
        "a descriptor without it cannot reproduce the map it was signed from",
    );
  }
  if (view.scope == null || view.period == null) {
    throw new Error("ViewScope: view.scope and view.period are required");
  }

  return {
    v: VIEW_SCOPE_DESCRIPTOR_VERSION,
    authority: {
      role: authority.role,
      mandate: canonicalJurisdictions(authority.mandate),
      effective: canonicalJurisdictions(authority.effective),
      adminDrill:
        (authority.adminDrill as ViewScopeAuthority["adminDrill"] | null | undefined) ?? null,
    },
    view: {
      scope: canonicalScope(view.scope as ViewScope),
      // Validated above — no fallback: see the grain guard in this function.
      grain: view.grain as AggregationLevel,
      period: canonicalPeriod(view.period as ViewPeriod),
      asOf: (view.asOf as string | null) ?? null,
      basis: (view.basis as TimeBasis) ?? "valid",
      layers: (view.layers as LayerId[]) ?? [],
      encoding: (view.encoding as EncodingId | null) ?? null,
      verifiedOnly: view.verifiedOnly === true,
      preset: (view.preset as PresetId | null) ?? null,
    },
    generatedAt: (o.generatedAt as string | null) ?? null,
  };
}

/**
 * A short, stable identity for the VIEW (not for the artifact): `generatedAt` is
 * excluded, so a CSV and a PNG cut from the same board at different seconds
 * carry the SAME `vista` handle and can be proven to describe one question.
 *
 * FNV-1a, 32-bit, hex — deliberately NOT a cryptographic hash and never to be
 * read as tamper evidence. It is a collision-resistant-enough label for humans
 * comparing two footers. Integrity is the signature work's job.
 */
export function viewScopeDigest(d: ViewScopeDescriptor): string {
  const text = serializeViewScope({ ...d, generatedAt: null });
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Reconstruction
// ---------------------------------------------------------------------------

/**
 * Rebuild the canonical view value. `representation` and `camera` come back as
 * their defaults BY DESIGN — neither changes a single number, so an artifact
 * that omitted them lost nothing reproducible. Everything that DOES change the
 * data round-trips exactly.
 */
export function toPanoramaViewState(d: ViewScopeDescriptor): PanoramaViewState {
  return makeViewState({
    scope: canonicalScope(d.view.scope),
    period: canonicalPeriod(d.view.period),
    asOf: d.view.asOf,
    basis: d.view.basis,
    layers: [...d.view.layers],
    verifiedOnly: d.view.verifiedOnly,
    preset: d.view.preset,
    encoding: d.view.encoding,
  });
}

/**
 * The es-AR wording of a descriptor — delegated ENTIRELY to the C3 caption
 * builders so an artifact and the screen it came from never describe one scope
 * with two vocabularies. This module adds no phrasing of its own.
 *
 *  - `mandate`  — `describeMandate` for govt; "Nacional" for admin's universal
 *                 standing (the one phrase describeMandate refuses to emit,
 *                 since an admin has no assignment list to describe).
 *  - `narrowed` — `describeNarrowedView`, non-null ONLY when the effective view
 *                 sits strictly below the mandate. Null in the common case.
 */
export function describeViewScope(d: ViewScopeDescriptor): {
  mandate: string;
  narrowed: string | null;
} {
  const mandate = hasNationalReadScope(d.authority.role)
    ? "Nacional"
    : describeMandate(d.authority.mandate);
  const narrowed = describeNarrowedView({
    role: d.authority.role,
    mandateJurisdictions: d.authority.mandate,
    effectiveJurisdictions: d.authority.effective,
    adminProvince: d.authority.adminDrill?.province,
    adminLocality: d.authority.adminDrill?.locality ?? undefined,
  });
  return { mandate, narrowed };
}

/**
 * True when the artifact was cut from strictly LESS than the account's mandate.
 * Set equality, borrowed from view-scope-caption.ts — a length check would call
 * the CABA→Palermo drill "not narrowed" and let two different views share a
 * description (see the module docblock).
 */
export function isNarrowedBelowMandate(d: ViewScopeDescriptor): boolean {
  if (hasNationalReadScope(d.authority.role)) return d.authority.adminDrill !== null;
  if (d.authority.effective.length === 0) return false;
  return !jurisdictionsEqual(d.authority.mandate, d.authority.effective);
}

// ---------------------------------------------------------------------------
// How the descriptor TRAVELS in a CSV
// ---------------------------------------------------------------------------
//
// DECISION: an inline `#` header block, NOT a sidecar file.
//
// A sidecar (`export.csv` + `export.scope.json`) is cleaner to parse and loses
// the argument on the first email: two downloads become two attachments, one of
// them gets forwarded alone, and the surviving CSV is back to prose-or-nothing.
// The whole premise of V2 is that scope TRAVELS with the artifact, and a scope
// that can be separated from its data has not travelled.
//
// `#` was already this file's comment convention (the per-layer truncation
// notes use it), spreadsheets import the lines harmlessly as text in column A,
// and `rg mimar-view-scope` finds them in a directory of exports. The block goes
// ABOVE the column header so a truncated read still carries its provenance.

/** The machine-readable line's prefix — the grep handle AND the version gate. */
export const CSV_SCOPE_PREFIX = `# mimar-view-scope-v${VIEW_SCOPE_DESCRIPTOR_VERSION}: `;

/**
 * The `#` block prepended to an exported CSV: human lines in the SAME es-AR
 * vocabulary the screen used, then one canonical line carrying the whole
 * descriptor. The human lines are for the funcionario reading the file; the
 * canonical line is what `parseViewScopeFromCsv` regenerates the view from.
 */
export function viewScopeCsvHeaderLines(d: ViewScopeDescriptor): string[] {
  const { mandate, narrowed } = describeViewScope(d);
  const lines = [
    `# miMAR · alcance del mandato: ${mandate}`,
    // Only when the filter narrowed BELOW the mandate — same disclosure rule the
    // page follows, so the file never states a second scope line the screen did not.
    ...(narrowed ? [`# miMAR · vista: ${narrowed}`] : []),
    `# miMAR · grano: ${d.view.grain === "locality" ? "localidad" : "provincia"}`,
    `# miMAR · corte: ${
      d.view.asOf
        ? `${d.view.asOf} (tiempo de ${d.view.basis === "transaction" ? "transacción" : "validez"})`
        : "datos en vivo (sin corte temporal)"
    }`,
    `# miMAR · vista id: ${viewScopeDigest(d)}`,
    `${CSV_SCOPE_PREFIX}${serializeViewScope(d)}`,
  ];
  return lines;
}

/**
 * Recover the descriptor from an exported CSV. Returns null when the file
 * carries no scope block (every export predating V2) — an ABSENT scope is a
 * legitimate, readable state; a WRONG one is not, so a malformed block still
 * throws out of `parseViewScope`.
 */
export function parseViewScopeFromCsv(csv: string): ViewScopeDescriptor | null {
  for (const line of csv.split(/\r?\n/)) {
    if (line.startsWith(CSV_SCOPE_PREFIX)) {
      return parseViewScope(line.slice(CSV_SCOPE_PREFIX.length));
    }
  }
  return null;
}
