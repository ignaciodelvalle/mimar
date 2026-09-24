// Pure nav mapper for the pet profile's two-face redesign (Credencial | Libreta).
// Spec: dim-interno:docs/design/handoffs/2026-07-01-pet-profile-two-face-lean-handoff.md
//
// Resolves the incoming `?tab=` / `?lente=` URL state into { face, lens }.
//
// pet-document-redesign ADR-10 (2026-07-02): the Libreta face is now ONE
// consolidated timeline — there is no lens toggle in the UI anymore. `lens`
// is collapsed to a fixed value per role (owner: "todo", org: "oficial"),
// independent of whatever `?tab=`/`?lente=` value routed here — every legacy
// value (`vacunas`, `historial`, `libreta` with or without `lente`) still
// resolves `face: "libreta"` (REQ-6 URL compat is about landing on the right
// FACE, not selecting a filter that no longer exists). `lente` itself is
// still PARSED (kept in the input signature) purely for that legacy-compat
// bookkeeping — no branch of this function's OUTPUT depends on its value
// anymore. Callers (LibretaFace/libreta-lens.ts) derive their own owner/org
// audience straight from `isOwner`, not from this `lens` field, which exists
// today only so downstream code that still destructures `{ lens }` doesn't
// need day-one churn.

export type PetFace = "credencial" | "libreta";
export type PetLens = "todo" | "oficial";

export type ResolvePetFaceInput = {
  tab: string | undefined;
  /** Parsed for legacy REQ-6 URL compat only — no longer selects a filter (ADR-10). */
  lente: string | undefined;
  isOwner: boolean;
};

export type ResolvePetFaceResult = {
  face: PetFace;
  lens: PetLens;
};

const LIBRETA_TAB_VALUES = new Set(["vacunas", "historial", "libreta"]);

export function resolvePetFace({ tab, isOwner }: ResolvePetFaceInput): ResolvePetFaceResult {
  // Face 1 (Credencial) — default (no tab param) and the explicit legacy
  // aliases `resumen` (old default tab key) / `credencial` (new key).
  if (tab === undefined || tab === "credencial" || tab === "resumen") {
    return { face: "credencial", lens: "todo" };
  }

  // Face 2 (Libreta) — every legacy tab value that used to select a lens
  // now just routes to the single consolidated timeline.
  if (LIBRETA_TAB_VALUES.has(tab)) {
    return { face: "libreta", lens: isOwner ? "todo" : "oficial" };
  }

  // Unknown tab value — fall back to Credencial rather than guessing.
  return { face: "credencial", lens: "todo" };
}

// ---------------------------------------------------------------------------
// Legacy `?fromLost=1` bypass — REQ-6.3 no-op redirect
// ---------------------------------------------------------------------------
//
// D9's `?fromLost=1` used to bypass the LostCockpit early-return. Cockpit is
// gone (pet-document-redesign S2) — the normal profile always renders for
// lost pets now — so the param has no target. Instead of silently ignoring
// it (dead param retained forever in shared/bookmarked links), the page
// redirects to the same URL with `fromLost` stripped and every other param
// preserved (so legacy `?tab=`/`?lente=` deep links keep working per
// REQ-6.1/6.2).

/**
 * Pure helper: given the raw searchParams record from a Next.js page, builds
 * the redirect target path (with `fromLost` removed) — or `null` when
 * `fromLost` isn't present at all (no redirect needed).
 */
export function buildFromLostRedirectTarget(
  publicToken: string,
  searchParams: Record<string, string | string[] | undefined>,
): string | null {
  if (searchParams.fromLost === undefined) return null;

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "fromLost") continue;
    if (typeof value === "string") qs.set(key, value);
    else if (Array.isArray(value)) for (const v of value) qs.append(key, v);
  }
  const query = qs.toString();
  return `/mis-mascotas/${publicToken}${query ? `?${query}` : ""}`;
}
