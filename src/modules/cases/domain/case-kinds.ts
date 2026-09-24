// Case kinds catalog — single source of truth for which kinds the system
// supports. All 13 V1 kinds have full lifecycle declarations in
// `src/modules/cases/domain/lifecycles/<kind>.ts`. The schema accepts
// `case_kind` as text (not enum) so no migration is required when adding
// new kinds.
//
// Adding a new kind:
//   1. Add the string to `CASE_KINDS`.
//   2. Create `src/modules/cases/domain/lifecycles/<kind>.ts` (coverage test enforces).
//   3. Update `lib/case-attachment.ts` rules + `lib/case-normatives.ts`.
//   4. Update relevant server actions to open/close it.

export const CASE_KINDS = [
  // V1 subset — full lifecycles in src/modules/cases/domain/lifecycles/
  "bite_incident",
  "lost_pet_episode",
  "welfare_denuncia",
  "adoption_listing",
  "adoption_application",
  "custody_dispute",
  "foster_placement",
  // Previously deferred — now activated in feat/deferred-case-kind-lifecycles.
  // Full lifecycles in src/modules/cases/domain/lifecycles/. See attachment spec §6 +
  // lifecycles spec §16.
  "custody_episode",
  "custody_transfer_handshake",
  "foster_proposal",
  "outbreak_investigation",
  "microchip_remediation",
  // rehome-by-titular: the titular asks a verified org to sponsor their pet's
  // adoption listing while the animal keeps living with them. The request is
  // the consent record and the org's inbox item; the sponsorship itself is the
  // `adoption_listing` case the accept transaction opens. See
  // lifecycles/rehome-request.ts for why the two never coexist while open.
  "rehome_request",
] as const;

export type CaseKind = (typeof CASE_KINDS)[number];

/**
 * Case kinds that have their OWN screen and must not appear in the generic
 * /gob/casos queue.
 *
 * `custody_dispute` rows exist in BOTH `cases` (CAS- codes, read-only) and
 * `custody_disputes` (DIS- tokens, with the resolve form). Live review
 * 2026-07-28 found the same dispute listed under two codes with two different
 * state chips (ABIERTO vs ABIERTA): 11 dead rows in Casos against 1 workable
 * row in Disputas. PO decision the same day: `custody_disputes` is CANONICAL —
 * it is where the work actually happens — so the Casos queue stops showing the
 * shadow copy and links out instead.
 *
 * This is a ROUTING statement, not a data change: the `cases` rows still exist
 * and nothing about them is deleted.
 *
 * DO NOT MERGE with GENERIC_CASE_LIST_EXCLUDED_KINDS (lib/infra/case-queries.ts).
 * They share a mechanism and mean different things: that list hides kinds from
 * OWNER-facing surfaces for privacy and de-duplication (a denuncia's subject
 * must never see it); this one routes an OPERATOR to the screen where the work
 * happens. Folding them together would make a navigation change silently alter
 * a privacy rule.
 */
export const CASE_KINDS_ROUTED_ELSEWHERE: readonly CaseKind[] = ["custody_dispute"];

/**
 * Where an operator should go for a kind the Casos queue does not show.
 *
 * The href is the hub TAB, not /gob/disputas. That route has only redirected
 * into /gob/casos?expediente=disputas since the F6 fusion, and this registry
 * sits in src/ — outside the app/+components/ scan of the bounce guard in
 * __tests__/link-integrity.test.ts — so nothing would have caught it once a
 * caller appeared. It has none today; fixed while the cost is one line rather
 * than one line plus a rendered bounce.
 */
export const ROUTED_ELSEWHERE_DESTINATION: Record<string, { href: string; label: string }> = {
  custody_dispute: { href: "/gob/casos?expediente=disputas", label: "Disputas de custodia" },
};

/**
 * The ORG queue's own routing registry (/org/{token}/casos) — kinds that have
 * their own org screen and must not be listed twice.
 *
 * Separate from CASE_KINDS_ROUTED_ELSEWHERE on purpose (rehome-by-titular,
 * PO inbox-scoping decision, refinement 2). That registry belongs to /gob: its
 * destinations are static hrefs, and routing `custody_transfer_handshake` out
 * of /gob/casos would leave a govt operator with no screen for it at all. The
 * org queue is a different reader with a different map: a handshake the org
 * proposed lives at /org/{token}/transferencias, one addressed to it at
 * /org/{token}/transferencias/recibidas (beside decomiso hand-offs, which never
 * reached the generic queue — the inbox's receiver arm is scoped to
 * `rehome_request` so they never will).
 *
 * Same rule as above: a ROUTING statement, not a data change.
 */
export const ORG_CASE_KINDS_ROUTED_ELSEWHERE: readonly CaseKind[] = ["custody_transfer_handshake"];

/** Where an org member goes for a kind the org queue does not show; null when it does. */
export function orgRoutedElsewhereDestination(
  orgToken: string,
  kind: CaseKind | (string & {}),
): { href: string; label: string } | null {
  if (kind === "custody_transfer_handshake") {
    return {
      href: `/org/${orgToken}/transferencias/recibidas`,
      label: "Transferencias de custodia",
    };
  }
  return null;
}

export const V1_CASE_KINDS: readonly CaseKind[] = [
  "bite_incident",
  "lost_pet_episode",
  "welfare_denuncia",
  "adoption_listing",
  "adoption_application",
  "custody_dispute",
  "foster_placement",
  // Activated in spec 2026-05-19-cross-org-transfer-ux-design.
  // Previously deferred (per attachment spec §6).
  "custody_transfer_handshake",
  // Activated in plan 2026-05-20-microchip-replaced-ui.md §3.1.
  // Previously deferred (per attachment spec §6).
  "microchip_remediation",
  // Activated in feat/deferred-case-kind-lifecycles.
  // Previously deferred (per attachment spec §6 + lifecycles spec §16).
  "foster_proposal",
  "custody_episode",
  "outbreak_investigation",
  // Activated in rehome-by-titular (2026-08).
  "rehome_request",
];

export function isCaseKind(value: string): value is CaseKind {
  return (CASE_KINDS as readonly string[]).includes(value);
}

/**
 * The kinds whose geography is EPIDEMIOLOGICAL — i.e. the only ones whose
 * per-jurisdiction counts may be rendered as a disease/public-health surface
 * (the /gob/vigilancia choropleth and its department/barrio drill).
 *
 * Two members, and the catalog picks them, not this list:
 *   - `bite_incident`   — "Mordedura / observación rábica". The rabies
 *     expediente: `reportBite` opens it and emits `rabies_observation_started`
 *     in the SAME transaction, and its lifecycle's terminal event is
 *     `rabies_observation_ended`. Zoonotic exposure of a human population.
 *   - `outbreak_investigation` — "Investigación de brote". Public-health,
 *     potentially multi-subject, by definition.
 *
 * Everything else in CASE_KINDS is welfare, custody, adoption, reunification
 * or paperwork. `welfare_denuncia` is deliberately OUT despite sharing the
 * severity-3 weight: severity ranks how urgently a case needs an operator,
 * which is a different question from whether its location is a disease
 * signal. Maltrato geography is real and it is NOT epidemiology; painting it
 * on a surveillance map invents an outbreak out of an enforcement pattern.
 * The finding that forced this list (audit 2026-07-26, red #4) was exactly
 * that: open `custody_episode` rows rendering as epidemiological geography.
 *
 * The RETIRED `rabies_observation` string is NOT here. It is outside the
 * CaseKind union, nothing opens it and nothing can close it (see
 * caseKindLabel's note), so the ~12 immortal staging rows carrying it would
 * pin a permanent false signal onto the map. Excluding it also keeps the map
 * consistent with the /gob/vigilancia rabies KPI, which stopped counting that
 * string on 2026-08-01 for the same reason.
 *
 * DO NOT reuse this for operator queues or for "casos abiertos" totals —
 * those legitimately mean every kind (see `fetchCasesPerCapita`). This list
 * answers one question only: may this kind be drawn as epidemiology?
 */
export const EPIDEMIOLOGICAL_CASE_KINDS: readonly CaseKind[] = [
  "bite_incident",
  "outbreak_investigation",
];

// ---------------------------------------------------------------------------
// Severity weight — urgency-sort input (PO interview 2026-07-23, item 6:
// "Casos: orden por urgencia edad×tipo").
//
// A simple, defensible 3-tier scale — NOT a clinical/legal risk model, just
// enough differentiation to break the "oldest first" tie that flattens every
// kind into one queue. Documented here so the weight for any kind is a
// one-line lookup, not a buried magic number:
//
//   3 — imminent welfare/public-health risk: the subject (animal or
//       population) may be actively suffering or contagious right now.
//   2 — active legal/time-sensitive conflict: custody or search cases whose
//       resolution window matters, but nothing suggests active suffering.
//   1 — administrative/process case: paperwork or a handoff step, not a
//       welfare emergency.
//
// The queue's urgency score (CaseQueue) multiplies this weight by the case's
// age in days — an old low-severity case can still outrank a fresh
// high-severity one once it has sat unresolved for a while, which is the
// point (a stale "Casos" queue that never actions its long tail).
export const CASE_KIND_SEVERITY_WEIGHT: Record<CaseKind, 1 | 2 | 3> = {
  welfare_denuncia: 3, // animal welfare/maltrato — safety of a living subject
  bite_incident: 3, // rabies/public-health exposure
  outbreak_investigation: 3, // public-health, potentially multi-subject
  custody_dispute: 2, // active legal conflict over an animal
  custody_transfer_handshake: 2, // custody in transition, time-sensitive
  custody_episode: 2, // temporary custody, needs a resolution
  lost_pet_episode: 2, // reunification window matters
  microchip_remediation: 1, // compliance/administrative
  adoption_listing: 1, // process case
  adoption_application: 1, // process case
  foster_placement: 1, // process case
  foster_proposal: 1, // process case
  rehome_request: 1, // process case — a consent handoff, the animal stays home
};

/**
 * Severity weight for a case kind (1–3, see CASE_KIND_SEVERITY_WEIGHT).
 * Unknown/out-of-union kinds (case_kind is unconstrained text in the DB —
 * see caseKindLabel) default to 2, a neutral middle weight, rather than
 * silently sorting to either extreme.
 */
export function caseKindSeverityWeight(kind: CaseKind | (string & {})): 1 | 2 | 3 {
  return (CASE_KIND_SEVERITY_WEIGHT as Record<string, 1 | 2 | 3>)[kind] ?? 2;
}

// Display labels (es-AR). Used in dashboards + notification copy.
//
// Accepts plain strings besides the union: `case_kind` is unconstrained text
// in the DB, so rows can carry kinds outside CaseKind (e.g. the panorama
// seed's 'rabies_observation' rows, read literally by fetchVigilanciaMetrics).
// Unknown kinds fall back to the raw key so the UI never renders blank.
export function caseKindLabel(kind: CaseKind | (string & {})): string {
  switch (kind) {
    case "bite_incident":
      return "Mordedura / observación rábica";
    case "lost_pet_episode":
      return "Mascota perdida";
    case "welfare_denuncia":
      return "Denuncia de bienestar";
    case "adoption_listing":
      return "Publicación en adopción";
    case "adoption_application":
      return "Postulación de adopción";
    case "custody_dispute":
      return "Disputa de custodia";
    case "foster_placement":
      return "Tránsito asignado";
    case "custody_episode":
      return "Custodia temporal";
    case "custody_transfer_handshake":
      return "Transferencia de custodia";
    case "foster_proposal":
      return "Propuesta de tránsito";
    case "outbreak_investigation":
      return "Investigación de brote";
    case "microchip_remediation":
      return "Remediación de microchip";
    case "rehome_request":
      return "Solicitud de nuevo hogar";
    // RETIRED kind, outside the CaseKind union. scripts/seed-panorama.ts used
    // to write it and fetchVigilanciaMetrics used to count it; both now use
    // 'bite_incident', the kind that actually has a lifecycle and a closer.
    // Rows written before that fix survive in staging/prod and are unclosable
    // by any code path, so they keep a label here rather than rendering as a
    // raw key. Do not reintroduce it as a write target — the fence for that is
    // __tests__/seed-case-kinds.test.ts.
    case "rabies_observation":
      return "Observación antirrábica";
    default:
      return kind || "Caso";
  }
}
