// Pure view-model helpers for /admin/libro (WS-L — Libro de eventos).
//
// Maps the DB-shaped EventLedgerRow into a render-ready LedgerRowView with es-AR
// labels (event type, actor role), pre-formatted timestamps, and the temporal-
// replay deep-link. Pure — no DB, no React — so it is unit-testable and shared
// by both the server page and the client row component.

import type { EventLedgerRow } from "@/lib/metrics/event-ledger";
import { eventTypeLabel } from "@/lib/utils/format";

/**
 * es-AR labels for author_role. Mirrors the AuthorChip map used in the event
 * detail screen (kept in sync; this surface is read-only/admin).
 */
export const AUTHOR_ROLE_LABELS: Record<string, string> = {
  owner: "Dueño/a",
  vet: "Veterinario/a",
  shelter: "Refugio",
  govt: "Autoridad pública",
  system: "Sistema",
  scanner: "Lector de chip",
  finder: "Hallador",
};

export type LedgerRowView = {
  id: string;
  petPublicToken: string;
  eventType: string;
  eventTypeLabel: string;
  authorRole: string;
  authorOrganizationId: string | null;
  authorVerified: boolean;
  province: string | null;
  locality: string | null;
  occurredAtLabel: string;
  recordedAtLabel: string;
  hasAmendment: boolean;
  /** /admin/panorama?asOf=<iso>(+province/locality) deep-link. */
  replayHref: string;
};

const DATE_FMT = new Intl.DateTimeFormat("es-AR", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "America/Argentina/Buenos_Aires",
});

function formatStamp(d: Date): string {
  return DATE_FMT.format(d);
}

/**
 * Build the temporal-replay deep-link for a ledger row.
 *
 * The asOf bound is the event's occurredAt as an ISO string (round-trips through
 * the Panorama parseAsOf/clampAsOf). province/locality are appended when present
 * so the Panorama opens already scoped to where the event happened.
 *
 * NOTE: the Panorama API reads `province` as a province ISO code and `locality`
 * as a slug; here we pass the human jurisdiction labels the event carries. The
 * asOf bound always applies; the scope params are best-effort hints and the
 * Panorama clamps/ignores anything it cannot resolve.
 */
export function buildReplayHref(row: {
  occurredAt: Date;
  province: string | null;
  locality: string | null;
}): string {
  const params = new URLSearchParams();
  params.set("asOf", row.occurredAt.toISOString());
  if (row.province) params.set("province", row.province);
  if (row.locality) params.set("locality", row.locality);
  return `/admin/panorama?${params.toString()}`;
}

/** Map a DB-shaped ledger row into a render-ready view model. */
export function toLedgerRowView(row: EventLedgerRow): LedgerRowView {
  return {
    id: row.id,
    petPublicToken: row.petPublicToken,
    eventType: row.eventType,
    eventTypeLabel: eventTypeLabel(row.eventType),
    authorRole: row.authorRole,
    authorOrganizationId: row.authorOrganizationId,
    authorVerified: row.authorVerified,
    province: row.province,
    locality: row.locality,
    occurredAtLabel: formatStamp(row.occurredAt),
    recordedAtLabel: formatStamp(row.recordedAt),
    hasAmendment: row.hasAmendment,
    replayHref: buildReplayHref(row),
  };
}
