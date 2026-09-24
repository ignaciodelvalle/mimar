// `GET /api/v1/me/cases` and `GET /api/v1/me/cases/{publicCode}` — the owner's
// CASOS, as the web already shows them.
//
// TWO READS, TWO WEB SURFACES, NO NEW FACTS
// ---------------------------------------------------------------------------
// The list mirrors the "Casos abiertos" and "Historial" blocks of the web's
// `/mis-mascotas` bandeja (`components/CasesWidget.tsx`), which are fed by
// `fetchOpenWorkflows` and `fetchPreviousWorkflows`
// (`lib/analytics/owner-dashboard.ts`). The detail mirrors
// `/casos/{publicCode}` for a SIGNED-IN viewer, and is decided by the same
// `readCaseForViewer` (`lib/infra/case-read.ts`) that page runs. Nothing here is
// computed for the app alone: a row the web does not show is a row this does not
// carry, and a field the web hides from the owner is a field this omits.
//
// A "CASE" ROW IS NOT ALWAYS A `cases` ROW. The web's list mixes real
// expedientes (`/casos/CAS-…`) with the other open cycles an owner is waiting on
// — a tránsito proposal, a denuncia they filed, a postulación, a pending
// approval. Each row carries the `route` the app can open for it, resolved
// server-side through the deep-link table (the same resolution the inbox's CTAs
// use), or `null` when the app has no screen for it. A client must render a
// `null` route as plain text, never as a dead button.
//
// WHAT IS NOT CARRIED, AND WHY
// ---------------------------------------------------------------------------
//   · No internal ids. A row is keyed by its position; the web's React key
//     embeds a database uuid and has no reason to cross this boundary.
//   · No case coordinates. The web renders the case map for govt/admin only
//     (a case location can be a denounced address).
//   · No operator actions, no org answer controls. Those are the authority's
//     and the receiving org's surfaces, not the owner's.
//   · No anonymous (redacted) view. This read requires a session; the redacted
//     public page stays on the web, where a stranger can reach it.

export const MY_CASES_PAYLOAD_VERSION = 1;
export const MY_CASE_DETAIL_PAYLOAD_VERSION = 1;

/**
 * ONE MINUTE — a case moves without the owner doing anything (an operator
 * closes it, an org answers, a cron escalates), the same reason the transfers
 * hub takes one minute.
 */
export const MY_CASES_STALE_AFTER_MS = 60_000;

/**
 * How many closed rows the history carries — the web's `fetchPreviousWorkflows`
 * default, passed from ONE literal so the two surfaces show the same history.
 * `history.hasMore` says whether older rows exist beyond it.
 */
export const MY_CASES_HISTORY_LIMIT = 10;

/** The kinds of row the list can carry — `WorkflowKind`, mirrored. */
export const MY_CASE_ROW_KINDS_V1 = [
  "foster_proposal_pending",
  "pet_lost",
  "welfare_report_open",
  "adoption_application_pending",
  "custody_transfer_pending",
  "approval_request_pending",
  "custody_dispute_open",
  "bite_observation_open",
  "dangerous_breed_pending_attestation",
  "case_generic_open",
  "foster_proposal_resolved",
  "welfare_report_closed",
  "adoption_application_resolved",
  "approval_request_decided",
] as const;

export type MyCaseRowKindV1 = (typeof MY_CASE_ROW_KINDS_V1)[number];

export type MyCaseRowV1 = {
  kind: MyCaseRowKindV1;
  /** es-AR, as the web prints it. May carry the pet's name. */
  title: string;
  /** es-AR second line; `""` when the web prints nothing. */
  subtitle: string;
  severity: "info" | "warning" | "urgent";
  /** ISO 8601 — when the cycle opened, or when it was decided for history rows. */
  since: string;
  /**
   * The in-app route to open for this row, or `null` when the app has no screen
   * for it. Never recompute it from `kind`.
   */
  route: string | null;
};

export type MyCasesV1 = {
  payloadVersion: typeof MY_CASES_PAYLOAD_VERSION;
  issuedAt: string;
  staleAfter: string;
  /** Every open cycle, most recent first — the web's "Casos abiertos". */
  open: MyCaseRowV1[];
  /** The most recent closed cycles — the web's "Historial". */
  history: {
    rows: MyCaseRowV1[];
    /** Older closed rows exist beyond `MY_CASES_HISTORY_LIMIT`. */
    hasMore: boolean;
  };
};

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export type MyCaseStatusV1 = "open" | "escalated" | "closed" | "merged";

export type MyCasePartyV1 = {
  role: "opener" | "closer" | "organization" | "applicant" | "respondent" | "reporter";
  /** es-AR role label, the web's words ("Abrió", "Organización", …). */
  roleLabel: string;
  /** Display name, exactly as the web shows it to this viewer. */
  name: string | null;
};

export type MyCaseSubjectV1 =
  | {
      kind: "pet";
      name: string;
      /** "Perro · Macho" — the web's species line. */
      speciesLine: string;
      photoUrl: string | null;
      /** In-app route to the pet, or `null` when the app has no screen for it. */
      route: string | null;
    }
  | {
      kind: "other";
      /** The web's one-line descriptor for a non-pet subject. */
      description: string;
    };

export type MyCaseTimelineEntryV1 = {
  /** es-AR label for the entry, the web's `caseEntryLabel`. */
  label: string;
  occurredAt: string;
  /** The web's one-line summary, or `null` when it prints none. */
  summary: string | null;
  /** Free-text notes, shown to a signed-in viewer exactly as the web shows them. */
  notes: string | null;
};

export type MyCaseNormativeV1 = {
  label: string;
  scope: string;
  url: string | null;
};

export type MyCaseReadableV1 = {
  payloadVersion: typeof MY_CASE_DETAIL_PAYLOAD_VERSION;
  issuedAt: string;
  staleAfter: string;
  access: "full";
  publicCode: string;
  /** es-AR kind label ("Mordedura", …). */
  kindLabel: string;
  status: MyCaseStatusV1;
  /** es-AR status label ("Abierto", "Cerrado", …). */
  statusLabel: string;
  openedAt: string;
  closedAt: string | null;
  /** The opened reason as the web prints it, or `null` when there is none. */
  openedReason: string | null;
  /** "Localidad, Provincia", the province alone, or `null` when unspecified. */
  jurisdiction: string | null;
  subject: MyCaseSubjectV1;
  parties: MyCasePartyV1[];
  normatives: MyCaseNormativeV1[];
  /** Newest first, as the web renders the timeline. */
  timeline: MyCaseTimelineEntryV1[];
};

/**
 * The ONE denial that is not a 404: the caller is the pet's live CARETAKER.
 * Cases are titular-only in v1, and a caretaker sees the case links on the pet
 * they look after, so the honest answer is "not available to you" — carrying
 * only the pet they already know.
 */
export type MyCaseCaretakerOnlyV1 = {
  payloadVersion: typeof MY_CASE_DETAIL_PAYLOAD_VERSION;
  issuedAt: string;
  staleAfter: string;
  access: "caretaker_only";
  pet: { name: string; route: string | null } | null;
};

export type MyCaseDetailV1 = MyCaseReadableV1 | MyCaseCaretakerOnlyV1;
