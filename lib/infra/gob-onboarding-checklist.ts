// Pure domain logic for the /gob first-run onboarding checklist (T4-O3).
//
// Scoping: docs/plans/gob-onboarding-scoping.md (dim-interno), items G1-G5,
// approved as written per docs/handoff/rumbo-al-piloto.md (dim-interno) row
// T4-O3. Mirrors the org-side precedent this doc cites explicitly
// (components/OrgSetupChecklist.tsx + lib/infra/org-setup-checklist.ts): every
// step derives its done/pending state from REAL data, never from a stored
// "done" flag, and auto-hides once every step is complete.
//
// Steps (doc's own order, plus one addition — see ADDED STEP below):
//   G1 scope     — conocé tu alcance   — informational, satisfied by having
//                  been on this page before (see below).
//   approvals    — aprobá veterinarios y organizaciones — first visit to
//                  /gob/cola. ADDED, not in the scoping doc — see below.
//   G2 panorama  — recorré el panorama — first visit to /gob/panorama.
//   G3 campaigns — revisá las campañas — any campaign (service offering) in
//                  the operator's jurisdiction scope.
//   G4 casos     — revisá la cola de casos — first visit to /gob/casos.
//   G5 informe   — emití tu primer informe — an export the operator
//                  generated from a govt dashboard.
//
// ---------------------------------------------------------------------------
// ADDED STEP: "approvals" (2026-09-23, post-launch review)
// ---------------------------------------------------------------------------
// G4's own label is "Revisá la cola de casos" and it already points at
// /gob/casos — that pairing is internally consistent, but the PHRASE "cola de
// casos" collides with a DIFFERENT route, /gob/cola ("Aprobaciones": pending
// matrícula/organización verification requests — see app/gob/cola/page.tsx),
// which the checklist never mentioned at all. An operator reading only "cola
// de casos" had no path from the checklist to the queue that gates every vet
// and organization in their jurisdiction from acting — their actual first
// real task, ahead of browsing regulatory cases. This step is genuinely new
// (not a rename of G4, which keeps its own copy and destination unchanged)
// and sits second, right after G1: the scoping doc's own G1→G5 ordering is
// preserved for the five documented steps, and this one is inserted where an
// operator would need it first.
// ---------------------------------------------------------------------------
// Why G1 has no CTA, and why it isn't hardcoded `done: true`
// ---------------------------------------------------------------------------
// The scoping doc marks G1 "informational; completes on visit" and gives it
// no destination of its own ("Ver mi jurisdicción → scope pill" — a caption
// already rendered in this SAME page's header, not a separate route). Two
// ways to read that: either the step is trivially done the instant the
// checklist can render at all (the operator is, by construction, already
// looking at their jurisdiction in the header above) — which is exactly the
// hardcoded-done shape the project rules forbid — or it reads the SAME
// per-user watermark G2/G4 already need (surface "gob_home"), so the first
// ever /gob visit shows it pending and every visit after that shows it done.
// We took the second reading: `hasSeenGobHomeBefore` is read from
// user_surface_visits BEFORE this request's own visit is recorded (see
// app/gob/page.tsx and lib/infra/surface-visits.ts), so the fact is real and
// state-derived like every other step, not a constant. It carries no
// href/cta — there being nowhere separate to send the operator is the
// honest shape here, not a placeholder.
//
// ---------------------------------------------------------------------------
// Why G3's CTA is "Ver campañas", not "Nueva campaña"
// ---------------------------------------------------------------------------
// The scoping doc's CTA column says "Nueva campaña", but no /gob route lets a
// govt operator create one — service offerings (what /gob/operativos'
// "Campañas" tab reports on) are created only by organizations
// (app/org/[orgToken]/servicios/nuevo), never by govt. Sending an operator to
// a form that does not exist would be the exact CTA-lies-about-the-product
// failure org-setup-checklist.ts's `verification` step header note already
// documents for the org side. The MEASURED condition (campaigns count > 0 in
// the operator's jurisdiction scope) is unchanged from the doc; only the
// label/CTA were adapted to point at what a govt operator can actually do —
// monitor the campaigns organizations run in their jurisdiction.

export type GobOnboardingStepKey =
  | "scope"
  | "approvals"
  | "panorama"
  | "campaigns"
  | "casos"
  | "informe";

export type GobOnboardingStep = {
  key: GobOnboardingStepKey;
  /** Short label shown in the checklist. */
  label: string;
  /** Longer hint shown when the step is pending. */
  hint: string;
  /** Absolute route for the CTA, or `null` when there is nowhere separate to send the operator. */
  href: string | null;
  /** CTA button label, or `null` when `href` is `null`. */
  cta: string | null;
  done: boolean;
};

/** Input state derived from real reads. No DB calls here. */
export type GobOnboardingInput = {
  /** True once the operator has visited /gob (this home) before THIS request. */
  hasSeenGobHomeBefore: boolean;
  /** True once the operator has visited /gob/cola before. */
  hasVisitedCola: boolean;
  /** True once the operator has visited /gob/panorama before. */
  hasVisitedPanorama: boolean;
  /** True when at least one campaign (service offering) exists in the operator's jurisdiction scope. */
  hasCampaignsInScope: boolean;
  /** True once the operator has visited /gob/casos before. */
  hasVisitedCasos: boolean;
  /** True when the operator has generated at least one export from a govt dashboard. */
  hasExportActivity: boolean;
};

/**
 * Derives the five onboarding steps, each with its done/pending state
 * computed from the operator's real activity. Order matches the scoping
 * doc's own G1-G5 order.
 */
export function deriveOnboardingSteps(input: GobOnboardingInput): GobOnboardingStep[] {
  return [
    {
      key: "scope",
      label: "Conocé tu alcance",
      hint: "Arriba de esta pantalla vas a ver la jurisdicción que tenés asignada.",
      href: null,
      cta: null,
      done: input.hasSeenGobHomeBefore,
    },
    {
      key: "approvals",
      label: "Aprobá veterinarios y organizaciones",
      hint: "Las matrículas y organizaciones de tu jurisdicción esperan tu revisión antes de poder operar.",
      href: "/gob/cola",
      cta: "Ver aprobaciones",
      done: input.hasVisitedCola,
    },
    {
      key: "panorama",
      label: "Recorré el panorama",
      hint: "El panorama muestra el estado sanitario de tu jurisdicción en un mapa.",
      href: "/gob/panorama",
      cta: "Abrir panorama",
      done: input.hasVisitedPanorama,
    },
    {
      key: "campaigns",
      label: "Revisá las campañas de tu jurisdicción",
      hint: "Las organizaciones cargan sus campañas sanitarias — acá seguís su alcance y resultados.",
      href: "/gob/operativos?vista=campanas",
      cta: "Ver campañas",
      done: input.hasCampaignsInScope,
    },
    {
      key: "casos",
      label: "Revisá la cola de casos",
      hint: "Los casos regulatorios de tu jurisdicción están para revisar y actuar.",
      href: "/gob/casos",
      cta: "Ver casos",
      done: input.hasVisitedCasos,
    },
    {
      key: "informe",
      label: "Emití tu primer informe",
      // Honest about what this step can actually verify (PO review
      // 2026-09-22): the "informe de situación" panorama prints has NO
      // server-side footprint at all — it is a client-side React print view
      // (components/panorama/panorama-informe.ts), so there is nothing to
      // read here for it. Only an export write is measured
      // (hasExportActivity), so the hint promises only that. It also does
      // NOT point at /gob/panorama: panorama's own CSV/PNG export writes no
      // audit_log row either, which would make the CTA a second dead end.
      // /gob/censo is a real dashboard whose "Exportar CSV" button writes
      // gob_dashboard_export_generated (lib/analytics/govt-dashboard-
      // export.ts), one of the actions this step actually reads.
      hint: "Exportá un CSV desde un dashboard de gobierno — es lo que este paso puede verificar hoy.",
      href: "/gob/censo",
      cta: "Exportar datos",
      done: input.hasExportActivity,
    },
  ];
}

/** True once every step is done — the checklist auto-hides at that point. */
export function isOnboardingComplete(steps: GobOnboardingStep[]): boolean {
  return steps.length > 0 && steps.every((s) => s.done);
}

/**
 * The first pending step with a real CTA to focus, or null when there is
 * nothing left (or nothing focusable) to point the operator at.
 */
export function firstPendingOnboardingStep(steps: GobOnboardingStep[]): GobOnboardingStep | null {
  return steps.find((s) => !s.done && s.href !== null && s.cta !== null) ?? null;
}
