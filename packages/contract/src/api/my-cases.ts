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
//     embeds a database uuid and has no reason to cross this boundary. The
//     pet a row is about travels as its PUBLIC TOKEN (`petId`), the identity
//     every other owner read already hands a client — never `pets.id`.
//
// GROUPED BY WHOSE TURN IT IS (PO decision 2026-10-06)
// ---------------------------------------------------------------------------
// Each row says whether the owner has to act (`needsAction`), decided on the
// server from ONE table below (`MY_CASE_ROW_NEEDS_ACTION`), and which pet it is
// about. Both surfaces draw the same three groups from that — "Te toca a vos",
// "En curso", "Historial" — through the two pure helpers at the end of this
// file, so the web and the phone cannot order or cluster the same rows two
// ways. The new fields are ADDITIVE: an installed build that knows nothing of
// them keeps reading the payload it was built for, so `payloadVersion` stays 1
// (the app refuses any other version outright — bumping it would lock every
// installed build out of its own casos).
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

/**
 * Whether a row of this kind waits on the OWNER — the ONE place that decides
 * it. `true` only where the next step is theirs: answer a tránsito proposal,
 * confirm a devolución, attest a PPP breed, or tell us the lost pet is back
 * ("Avisanos cuando aparezca"). Everything else waits on somebody else (a
 * refugio, the authority) or is already closed.
 *
 * A `Record` over the kind union, so a new kind does not compile until it is
 * classified here; `my-cases-needs-action.test.ts` pins the whole table.
 *
 * THE DEFAULT, WITH ONE DOCUMENTED OVERRIDE. The server sends this value for
 * every row except where the row's own data decides whose turn it is, and
 * today that is one kind: `custody_transfer_pending`. A devolución ADDRESSED
 * to the owner waits on them (`true`, the table's value); one the owner SENT
 * to a refugio waits on the refugio, so that row says `false` and reads
 * "Esperando que <refugio> responda". A client never recomputes the turn when
 * the server sent it; it falls back to this table only for a payload that
 * predates the field.
 */
export const MY_CASE_ROW_NEEDS_ACTION: { readonly [K in MyCaseRowKindV1]: boolean } = {
  foster_proposal_pending: true,
  pet_lost: true,
  welfare_report_open: false,
  adoption_application_pending: false,
  custody_transfer_pending: true,
  approval_request_pending: false,
  custody_dispute_open: false,
  bite_observation_open: false,
  dangerous_breed_pending_attestation: true,
  case_generic_open: false,
  foster_proposal_resolved: false,
  welfare_report_closed: false,
  adoption_application_resolved: false,
  approval_request_decided: false,
};

/**
 * `MY_CASE_ROW_NEEDS_ACTION`, for a kind that arrived as a string. A kind this
 * build does not know (a newer server) waits on nobody in particular: `false`.
 */
export function caseKindNeedsAction(kind: string): boolean {
  return (MY_CASE_ROW_NEEDS_ACTION as Record<string, boolean | undefined>)[kind] ?? false;
}

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
  /**
   * The pet this row is about, by its PUBLIC TOKEN (`DIM-XXXX-XXXX`), or `null`
   * for an account-level row (a denuncia filed, a pending approval). Rows that
   * share it are the same animal.
   */
  petId: string | null;
  /** The pet's name, `null` exactly when `petId` is. */
  petName: string | null;
  /** The pet's public photo url, or `null` when it has none (or there is no pet). */
  petPhotoUrl: string | null;
  /**
   * The owner's turn, decided server-side: `MY_CASE_ROW_NEEDS_ACTION[kind]`,
   * except a devolución the owner sent, which waits on the other side (see the
   * table's note).
   */
  needsAction: boolean;
  /** ISO 8601 — the deadline for the owner's answer, or `null` when there is none. */
  dueAt: string | null;
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
// Grouping — the same three groups on every surface
// ---------------------------------------------------------------------------

/** What `splitOpenCaseRows` reads off a row; the web's `Date`s and the wire's ISO strings both fit. */
export type CaseTurnFields = {
  needsAction: boolean;
  dueAt: string | Date | null;
  since: string | Date;
};

/** What `clusterCaseRowsByPet` reads off a row. */
export type CasePetFields = {
  petId: string | null;
  petName: string | null;
  petPhotoUrl: string | null;
};

function timeOf(value: string | Date | null): number | null {
  if (value === null) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function newestFirst(a: CaseTurnFields, b: CaseTurnFields): number {
  return (timeOf(b.since) ?? 0) - (timeOf(a.since) ?? 0);
}

/**
 * Open rows split by whose turn it is.
 *
 *   · `yourTurn` — `needsAction` rows. Those with a deadline first, the
 *     earliest deadline on top; then the rest, newest first.
 *   · `inProgress` — everything else, newest first.
 *
 * Pure and stable: rows that compare equal keep the server's order.
 */
export function splitOpenCaseRows<T extends CaseTurnFields>(
  rows: readonly T[],
): { yourTurn: T[]; inProgress: T[] } {
  const yourTurn = rows
    .filter((row) => row.needsAction)
    .sort((a, b) => {
      const dueA = timeOf(a.dueAt);
      const dueB = timeOf(b.dueAt);
      if (dueA !== null && dueB !== null && dueA !== dueB) return dueA - dueB;
      if (dueA !== null && dueB === null) return -1;
      if (dueA === null && dueB !== null) return 1;
      return newestFirst(a, b);
    });
  const inProgress = rows.filter((row) => !row.needsAction).sort(newestFirst);
  return { yourTurn, inProgress };
}

/** One pet's rows inside a group — or one account-level row on its own (`petId: null`). */
export type CasePetCluster<T> = {
  petId: string | null;
  petName: string | null;
  petPhotoUrl: string | null;
  rows: T[];
};

/**
 * A group's rows, with every pet's rows gathered where that pet first appears.
 * A cluster of ONE row is drawn as a plain row; two or more are drawn under the
 * pet with a count. A row with no pet is always a cluster of its own.
 */
export function clusterCaseRowsByPet<T extends CasePetFields>(
  rows: readonly T[],
): CasePetCluster<T>[] {
  const clusters: CasePetCluster<T>[] = [];
  const byPet = new Map<string, CasePetCluster<T>>();
  for (const row of rows) {
    if (row.petId === null) {
      clusters.push({ petId: null, petName: null, petPhotoUrl: null, rows: [row] });
      continue;
    }
    const existing = byPet.get(row.petId);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    const cluster: CasePetCluster<T> = {
      petId: row.petId,
      petName: row.petName,
      petPhotoUrl: row.petPhotoUrl,
      rows: [row],
    };
    byPet.set(row.petId, cluster);
    clusters.push(cluster);
  }
  return clusters;
}

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
