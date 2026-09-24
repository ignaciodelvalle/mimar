// Pure badge derivations for the PUBLIC credential (Tier 0 / Tier 2).
//
// WAVE D1 (Invariant #3 — "a correction supersedes everywhere"): a stranger
// scanning the QR must see the CORRECTED value of an amended clinical event,
// exactly like the authenticated libreta does. These helpers take the RAW
// fetched stream (the amendable clinical events PLUS the pet's `event_amended`
// rows) and fold corrections via overlayAmendments BEFORE deriving each badge —
// so a corrected vaccine name / date flips the public credential, not just the
// owner's timeline.
//
// overlayAmendments also upcasts each payload (single read-boundary helper), so
// a historical row's shape is normalized before the badge reads it.
//
// Kept pure + co-located (no DB, no React) so the "corrected vaccination flips
// the public badge" contract is unit-testable without rendering the page.

import { computeConfidence, isAtLeast } from "@/lib/events/event-confidence";
import { overlayAmendments } from "@/lib/infra/amendment";
import { parseDateInput } from "@/lib/utils/format";

// A date-only "YYYY-MM-DD" next_due_at (legacy rows written before the
// noon-UTC normalization) is midnight UTC = 21:00 of the PREVIOUS AR day, so
// "vencida" flipped 3 hours early. Anchor date-only values at noon UTC
// (parseDateInput); full ISO timestamps carry their own instant and pass
// through. Same guard as lib/projections/pet-compliance.ts::parseNextDue.
function parseNextDue(raw: string): Date | null {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? parseDateInput(raw) : new Date(raw);
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/** Minimal event shape overlayAmendments needs. `occurredAt` is required by the
 *  overlay's latest-wins comparison on the `event_amended` rows. */
export type CredentialEvent = {
  id: string;
  eventType: string;
  occurredAt: Date | string;
  payload: unknown;
  /**
   * Authorship, as stamped on the event at signing time. Optional because most
   * badge helpers here do not need it; `deriveRabiesSemaphore` does — see its
   * note on why a vigencia claim without its provenance is a false statement.
   * Absent fields are read as "not professionally backed", which is the
   * fail-closed reading: a caller that forgets to select these columns
   * understates the claim rather than inventing a verification.
   */
  authorRole?: string | null;
  authorVerified?: boolean | null;
  authorOrganizationId?: string | null;
};

/** Whether the record behind a badge carries a professional signature. */
export type CredentialProvenance = "profesional" | "declarada";

// countActiveVaccineNames (Tier 2 "vacunas vigentes" v1 — a 12-month distinct
// name dedupe) was REMOVED (staging validation 2026-07-04, bug 3): its counts
// contradicted the owner libreta for the same pet. The Tier 2 vaccine summary
// now derives from the SAME shared function the owner path uses —
// computeVaccinationSummary (lib/domain/libreta-health-status.ts) — with
// overlayAmendments folded by the caller (page.tsx).

/**
 * Active medications (Tier 2): `medication_started` events with no referencing
 * `medication_stopped`, surfaced by CORRECTED `drug_name`. Same shape as
 * computeMedicationsActive (lib/domain/libreta-health-status.ts) but scoped to
 * the public credential. Pass medication_started/stopped rows + `event_amended`.
 */
export function deriveActiveMedications(events: CredentialEvent[]): string[] {
  const projected = overlayAmendments(events);

  const stoppedIds = new Set<string>();
  for (const e of projected) {
    if (e.eventType !== "medication_stopped") continue;
    const sid = (e.payload as { medication_started_event_id?: unknown })
      ?.medication_started_event_id;
    if (typeof sid === "string") stoppedIds.add(sid);
  }

  const active: string[] = [];
  for (const e of projected) {
    if (e.eventType !== "medication_started") continue;
    if (stoppedIds.has(e.id)) continue;
    const drug = (e.payload as { drug_name?: unknown })?.drug_name;
    if (typeof drug === "string" && drug.trim()) active.push(drug.trim());
  }
  return active;
}

/**
 * Rabies-at-risk flag for the service-dog banner (Art. 8, Ley 26.858): the pet's
 * most recent rabies vaccination is expired. Reads the CORRECTED `vaccine_name`
 * and `next_due_at` so amending a mistyped rabies dose (name or due date) flips
 * the public warning. Conservative heuristic (false negatives OK — soft warning
 * only).
 *
 * "Expired" means `next_due_at < now`, the same due-ness test the owner-side
 * derivation applies (computeVaccinationSummary marks a dose `expired` when its
 * next_due_at is in the past). The vaccination_administered schema writes
 * `next_due_at`; there is no `valid_until` key — reading it left this banner
 * permanently dark (lint:events ghost-key finding).
 *
 * Pass the pet's `vaccination_administered` rows (any recency) + `event_amended`.
 */
/**
 * Public rabies semaphore (pet-state-header R4) — the tri-state vigencia of
 * the single legally-mandated vaccine (Ley 22.953 framework):
 *   - "vigente"          latest rabies dose next_due_at >= now
 *   - "vencida"          latest rabies dose next_due_at < now
 *   - "sin-vencimiento"  a rabies dose exists but records no next_due_at —
 *                        neutral "Con registro", no vigencia claim
 *   - "none"             no rabies dose at all — "Sin registro"
 *
 * UNLIKE isRabiesAtRisk below (which deliberately keeps its conservative
 * latest-ANY-vaccine service-dog semantics), this filters to RABIES doses
 * FIRST — accent/case-insensitive match on "rabi" — then takes the latest, so
 * a later non-rabies vaccine can never mask an expired rabies dose.
 *
 * Privacy proportionality (checklist argued in the spec): the disclosed data are
 * ONE vigencia and ONE provenance bit — no dates, no vet name, no batch, no
 * other vaccine. The provenance bit was added 2026-08-17; it says something
 * about the RECORD, never about the owner, so it does not widen the personal
 * data on this page.
 *
 * WHY PROVENANCE TRAVELS WITH THE STATE.
 * This used to return the vigencia alone, computed from `next_due_at` and
 * nothing else, and the page painted it as a green VIGENTE seal. A dose the
 * owner typed in and nobody confirmed was therefore indistinguishable from one
 * a matriculated vet signed. The mechanism meant to cover that —
 * `showVaccinationConfidence` in page.tsx — was inverted: it renders a badge
 * only when the record is ALREADY professionally verified, so it appears
 * exactly when it is not needed and is absent exactly when it is. And absence
 * of a badge is not a statement: an inspector, a finder or an adopter reads a
 * bare green stamp as a verified fact.
 *
 * Rabies is the one legally mandated vaccine (Ley 22.953), so it is also the
 * one where acting on a false reading has consequences. The owner-facing
 * projection (lib/projections/pet-compliance.ts) has always drawn this
 * distinction correctly; the public face reimplemented the logic without it.
 *
 * Pass the pet's `vaccination_administered` rows + `event_amended` (WAVE D1:
 * corrections fold before deriving, same contract as every badge here).
 */
export function deriveRabiesSemaphore(
  events: CredentialEvent[],
  now: Date,
): { estado: "vigente" | "vencida" | "sin-vencimiento" | "none"; respaldo: CredentialProvenance } {
  const isRabiesName = (name: unknown): boolean =>
    typeof name === "string" &&
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .includes("rabi");

  const rabiesDoses = overlayAmendments(events)
    .filter(
      (e) =>
        e.eventType === "vaccination_administered" &&
        isRabiesName((e.payload as { vaccine_name?: unknown })?.vaccine_name),
    )
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());

  const latest = rabiesDoses[0];
  if (!latest) return { estado: "none", respaldo: "declarada" };

  // Provenance of THE SAME dose the state describes — returned together, and
  // from one selection, on purpose. Two functions each picking "the latest
  // dose" is how a qualifier ends up describing a different record than the
  // claim it qualifies.
  const respaldo: CredentialProvenance = isAtLeast(
    computeConfidence({
      // Coerced, not asserted: a row whose authorship columns were never
      // selected reads as an unsigned owner record and lands on "declarada".
      // Understating a claim is the safe direction here; inventing one is not.
      authorRole: latest.authorRole ?? "",
      authorVerified: latest.authorVerified === true,
      authorOrganizationId: latest.authorOrganizationId ?? null,
      payload: (latest.payload ?? {}) as Record<string, unknown>,
    }),
    "professional_verified",
  )
    ? "profesional"
    : "declarada";

  // KNOWN GAP (follow-up): this reads only the dose's own next_due_at. The
  // owner's card also derives a booster date from the jurisdiction's
  // frequency_months — a suggestion (dueSource "rule") or, where the rule row
  // cites the norm fixing the cadence, a legal deadline (dueSource
  // "legal_cadence", PO decision 2026-09-18, D5). This public credential has
  // no jurisdiction context and shows the neutral "sin-vencimiento" ("Con
  // registro firmado") for both. That is less information, not a
  // contradiction — it never claims "vigente" on a date it cannot see — and
  // threading the resolved rule in here is the open follow-up.
  const nextDueRaw = (latest.payload as { next_due_at?: unknown })?.next_due_at;
  if (typeof nextDueRaw !== "string" || !nextDueRaw) return { estado: "sin-vencimiento", respaldo };
  const nextDueAt = parseNextDue(nextDueRaw);
  if (!nextDueAt) return { estado: "sin-vencimiento", respaldo };
  return { estado: nextDueAt >= now ? "vigente" : "vencida", respaldo };
}

export function isRabiesAtRisk(events: CredentialEvent[], now: Date): boolean {
  const vaccinations = overlayAmendments(events)
    .filter((e) => e.eventType === "vaccination_administered")
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());

  const latest = vaccinations[0];
  if (!latest) return false;

  const payload = latest.payload as { vaccine_name?: string; next_due_at?: string };
  if (!payload?.vaccine_name?.toLowerCase().includes("rabia") || !payload.next_due_at) {
    return false;
  }
  const nextDueAt = parseNextDue(payload.next_due_at);
  return nextDueAt !== null && nextDueAt < now;
}
