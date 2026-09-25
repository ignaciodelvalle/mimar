// `GET /api/v1/me/welfare-reports` and `GET /api/v1/me/welfare-reports/{referenceCode}`
// — "Mis denuncias", as the web already shows them to their author (M16).
//
// TWO READS, TWO WEB SURFACES, NO NEW FACTS
// ---------------------------------------------------------------------------
// The list mirrors `/denuncias/mias`; the detail mirrors `/denuncias/{id}`. Both
// are decided by the SAME reader the web pages call
// (`src/modules/welfare/infrastructure/reporter-reports-read.ts`), so a field
// the web withholds from the reporter is a field this cannot carry.
//
// ONLY DENUNCIAS FILED UNDER THE ACCOUNT. One filed anonymously is stored with
// no account attached — that is what "anónima" means — so it never appears
// here, from the web or from the phone. Its author follows it the way the web
// has always offered: the reference code and the access link e-mailed to the
// address they left. Nothing on this surface re-links it.
//
// WHY THE STATUS IS HERE WHEN THE RECEIPT WITHHOLDS IT. `WelfareReportFiledV1`
// omits `status` because a reference code alone grants nothing, and a receipt
// is a screenshot. This read is different in exactly the way that matters: it
// answers only to the verified author, the same person `/denuncias/mias` shows
// the status to.
//
// WHAT IS NOT CARRIED, AND WHY
// ---------------------------------------------------------------------------
//   · No internal ids. The detail is addressed by the reference code the
//     reporter already holds; the uuid stays operator-side.
//   · No authority notes, resolution notes, moderation flags, assignee or
//     derivation org. The case timeline contributes ONLY the reporter's own
//     comments.
//   · Nothing about the person denounced beyond what the reporter typed.

/**
 * Bumped when a field is REMOVED or its meaning changes; adding one does not
 * bump it. Same rule as every other payload in this package.
 */
export const MY_WELFARE_REPORTS_PAYLOAD_VERSION = 1;
export const MY_WELFARE_REPORT_DETAIL_PAYLOAD_VERSION = 1;

/**
 * ONE MINUTE — a denuncia's status moves without its author doing anything (an
 * authority triages or closes it), the same reason the casos take one minute.
 */
export const MY_WELFARE_REPORTS_STALE_AFTER_MS = 60_000;

/** The workflow states, as `welfare_report_status` stores them. */
export const MY_WELFARE_REPORT_STATUSES_V1 = [
  "open",
  "triaged",
  "in_progress",
  "closed",
  "duplicate",
  "invalid",
] as const;

export type MyWelfareReportStatusV1 = (typeof MY_WELFARE_REPORT_STATUSES_V1)[number];

export type MyWelfareReportRowV1 = {
  /** `DEN-XXXX-XXXX` — also the key the detail is fetched by. */
  referenceCode: string;
  /** es-AR kind label, the web's ("Abandono", …). */
  kindLabel: string;
  /** es-AR urgency label as the citizen chose it, the web's words. */
  severityLabel: string;
  status: MyWelfareReportStatusV1;
  /** es-AR status label ("Abierta", "En curso", …). */
  statusLabel: string;
  /** The reporter's own description, cut at 150 characters as the web cuts it. */
  excerpt: string;
  /** ISO 8601 — when it was filed. */
  filedAt: string;
  /** "Localidad, Provincia", one of them, or `null`. */
  place: string | null;
};

export type MyWelfareReportsV1 = {
  payloadVersion: typeof MY_WELFARE_REPORTS_PAYLOAD_VERSION;
  issuedAt: string;
  staleAfter: string;
  /** Newest first. */
  reports: MyWelfareReportRowV1[];
  /**
   * Opaque. Pass back as `?cursor=` for the next page; `null` when there is
   * none. A client must never construct or parse it.
   */
  nextCursor: string | null;
};

/**
 * The web's banner under the header, or `null` when it draws none (a closed,
 * duplicate or unfounded denuncia).
 */
export type MyWelfareReportNoticeV1 = {
  tone: "warn" | "info";
  /** es-AR, verbatim from the web. */
  text: string;
};

export type MyWelfareReportDetailV1 = {
  payloadVersion: typeof MY_WELFARE_REPORT_DETAIL_PAYLOAD_VERSION;
  issuedAt: string;
  staleAfter: string;
  referenceCode: string;
  kindLabel: string;
  severity: string;
  severityLabel: string;
  status: MyWelfareReportStatusV1;
  statusLabel: string;
  notice: MyWelfareReportNoticeV1 | null;
  filedAt: string;
  /** ISO 8601 — when the reporter said it happened, or `null`. */
  occurredAt: string | null;
  /** The reporter's description, whole. */
  description: string;
  subject: {
    /** es-AR subject kind ("Animal sin dueño identificado", …). */
    label: string;
    /**
     * The registered pet the reporter named, or `null` — including when that
     * pet was since ERASED (Ley 25.326 art. 16), which reads as never registered.
     */
    pet: { name: string; publicToken: string } | null;
    /** What the reporter typed about the subject, or `null`. */
    description: string | null;
  };
  /** `null` when the reporter gave no place at all. */
  place: {
    address: string | null;
    /** "Localidad, Provincia", one of them, or `null`. */
    jurisdiction: string | null;
    point: { lat: number; lng: number } | null;
  } | null;
  /** The contact the reporter left, `null` when they left none. */
  contact: { email: string | null; phone: string | null } | null;
  /** The reporter's own evidence, as short-lived signed urls. */
  evidence: Array<{ kind: "image" | "video"; url: string; filename: string | null }>;
  /** The reporter's own comments on the case, newest first. */
  comments: Array<{ text: string; at: string }>;
  /**
   * The case the denuncia opened, when it has one, with the in-app route to it
   * (`null` route when the app has no screen for it).
   */
  case: { publicCode: string; route: string | null } | null;
  /** The web's public constancia page for this code, absolute. */
  constanciaUrl: string;
};
