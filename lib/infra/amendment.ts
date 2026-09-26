// Amendment domain — Wave 2 Item 15 (2026-06-19).
//
// Implements AGENTS.md core principle #2: "Corrections are new events that
// reference earlier ones. No event is ever edited or deleted."
//
// This module owns:
//   - AMENDABLE_EVENT_TYPES allowlist (D4)
//   - canAmendEvent() — pure capability check (D3)
//   - applyAmendments() — projection helper (D2)
//   - getAmendmentsForEvents() — DB query helper used by the libreta view
//
// Writers (server action) live in app/actions/amendment.ts.

import type { EventType } from "@/db/schema";
import { upcastPayload } from "@/lib/events/event-upcasters";
import type { AmendmentOverlaidBrand } from "@/lib/projections/types";

// ---------------------------------------------------------------------------
// D4 — Allowlist of amendable event types
// ---------------------------------------------------------------------------
//
// Only clinical routine events can be amended via event_amended. Events with
// their own reversal flows or legal/forensic weight are NOT amendable:
//   - death_recorded       → has no reversal path; forensic.
//   - incident_reported    → legal record; welfare/rabies flow owns corrections.
//   - rabies_observation_* → legal 10-day observation; outcome immutable.
//   - disease_reported     → govt surveillance; corrected via official channels.
//   - adoption/custody     → own dedicated flows (adoption_reversed, custody_*).
export const AMENDABLE_EVENT_TYPES: ReadonlyArray<EventType> = [
  "vaccination_administered",
  "deworming_administered",
  "weight_recorded",
  "vet_visit_logged",
  "clinical_info_logged",
  "medication_started",
  "note_added",
  "sterilization_performed",
  // Movilidad jurisdiccional (R1.5): a wrong jurisdiction, CVI number, or
  // travel date is regulatory-stakes and correctable by amendment — never by
  // editing or deleting the original row.
  "movement_recorded",
] as const;

const AMENDABLE_SET: ReadonlySet<string> = new Set(AMENDABLE_EVENT_TYPES);

/** Returns true if the event type is in the amendable allowlist (D4). */
export function isAmendableEventType(eventType: string): boolean {
  return AMENDABLE_SET.has(eventType);
}

// ---------------------------------------------------------------------------
// D3 — Capability check
// ---------------------------------------------------------------------------
//
// Two gates, and both must pass:
//   - canAmendEvent (below): the record's TYPE is amendable and the viewer may
//     write events on the pet at all (requireAlivePetAccess on the server).
//   - amendAuthorshipRefusal (further below): WHO wrote the record, against who
//     is correcting it (PO decision 3B, 2026-09-22).
// Admin/govt amendment also goes through the sensitive path (D5).
//
// These are pure functions — actual DB-based ownership is checked in the server
// action (requireAlivePetAccess). canAmendEvent gates the UI affordance.

export type AmendCapabilityInput = {
  eventType: string;
  /** True when the current viewer has write access to pet events (owner path). */
  viewerCanWriteEvents: boolean;
};

/**
 * Returns true when the viewer should see the "Corregir" button for this event.
 * Pure — no DB calls.
 */
export function canAmendEvent({ eventType, viewerCanWriteEvents }: AmendCapabilityInput): boolean {
  return isAmendableEventType(eventType) && viewerCanWriteEvents;
}

// ---------------------------------------------------------------------------
// D3b — Authorship: who may correct WHOSE record (PO decision 3B, 2026-09-22)
// ---------------------------------------------------------------------------
//
// Before this rule any writer on the pet could correct any amendable record on
// it: an owner could overwrite the weight, pregnancy or vaccine a veterinarian
// signed, and the libreta would then show the owner's value under the vet's
// provenance. The rule, as the PO decided it:
//
//   · An OWNER may correct the records THEY wrote — nobody else's.
//   · A record written by a PROFESSIONAL (author_role vet / shelter / govt) may
//     only be corrected by a professional.
//   · ADMIN and GOVT (profile role) keep their override; they already go through
//     the D5 path (mandatory reason, audit_log, owner notified).
//
// NOT SYMMETRIC, ON PURPOSE. A professional MAY correct an owner's entry: an
// owner-declared weight fixed by the vet who weighed the animal is exactly the
// correction the libreta exists to carry. "Only a professional corrects a
// professional" protects professional records; it does not wall off owner ones.
//
// THE SUBJECTS ARE THE RECORD AND EVERY CORRECTION ALREADY ON IT. Amendments
// overlay their corrections, so the value on screen may have been written
// by someone other than the root's author. An owner who wrote a weight that a
// vet then corrected may not overwrite the vet's correction — that would be
// correcting a professional record by another road. The caller passes the root
// event plus its whole amendment chain.
//
// WHO COUNTS AS A PROFESSIONAL ACTOR is decided by the signature the correction
// itself will carry (`PetEventAuthorship`), and it takes a VERIFIED signature
// (fresh-context security review, 2026-09-22). The org path signs `vet` +
// verified only when the acting member holds a validated matrícula; it signs
// `shelter` + UNVERIFIED for every other member (lib/infra/pet-access.ts:
// "NOT professional-verified"). So there are four standings:
//
//   · override              — profile admin/govt. Corrects anything (D5).
//   · verified_professional — an org-path signature with author_verified=true.
//                             Corrects anything, including an owner's entry.
//   · org_member            — an org-path signature WITHOUT verification. No
//                             professional standing: corrects only what they
//                             themselves wrote, and never a verified record.
//   · person                — the person path (signs `owner`), even for a
//                             profile-role vet acting on their own animal.
//                             Corrects only what they wrote, never a record a
//                             professional role (vet/shelter/govt) signed.
//
// `organizations.verified`/status is NOT consulted, on purpose: the provenance
// keystone (#43) binds the tier to the SIGNER's matrícula, not to the
// organization, and org access itself is already gated by an active membership
// plus `event.write`. A verified organization's unverified volunteer is still
// an org_member here.
//
// A VERIFIED SUBJECT (author_verified=true), or a correction made by admin/govt,
// only a verified professional or the override may correct.
//
// LEGACY ROWS WITH NO recorded_by_user_id. Early owner-path writes did not
// record the individual author. Such a row counts as the actor's own only when
// it is `author_role = 'owner'`, the actor is on the person path, AND the actor
// held a TITULAR-SIDE ownership (owner / co_owner / foster — never caretaker)
// whose interval [started_at, ended_at) covers the row's recorded_at. Being the
// CURRENT holder is not enough: that let a later owner correct the previous
// owner's legacy records (fresh-context security review, 2026-09-22). Any other
// author role with a null author (system imports, finder notes) is nobody's to
// correct outside the override and verified professionals.

/** author_role values that mark a record as signed by a professional role. */
export const PROFESSIONAL_AUTHOR_ROLES: ReadonlySet<string> = new Set(["vet", "shelter", "govt"]);

/** Org-path signing roles (pet-access resolves exactly these two). */
const ORG_SIGNING_ROLES: ReadonlySet<string> = new Set(["vet", "shelter"]);

/**
 * `event_amended.payload.actor_role` values that mark a CORRECTION as
 * institutional, whatever its signing column says: an admin or govt correction
 * made through the person path is signed `owner` in `author_role`, but it is
 * still not the owner's to overwrite. `vet` is deliberately NOT here: that
 * actor_role is derived from the PROFILE, so a veterinarian correcting their
 * own animal through the person path writes `vet` there while signing `owner`,
 * and must still be able to correct their own correction.
 */
const INSTITUTIONAL_ACTOR_ROLES: ReadonlySet<string> = new Set(["admin", "govt"]);

/**
 * Ownership roles on the TITULAR side — everyone but a caretaker. Only the
 * legacy-row rule reads it (see the block above).
 */
export const TITULAR_SIDE_HOLDER_ROLES = ["owner", "co_owner", "foster"] as const;

/** Profile roles that keep the override (the D5 sensitive path). */
const OVERRIDE_PROFILE_ROLES: ReadonlySet<string> = new Set(["admin", "govt"]);

export type AmendAuthorshipSubject = {
  /** pet_events.author_role of the record or correction. */
  authorRole: string;
  /** pet_events.author_verified. Absent is read as false. */
  authorVerified?: boolean;
  /** pet_events.recorded_by_user_id — null on legacy rows. */
  recordedByUserId: string | null;
  /**
   * pet_events.recorded_at. Only the legacy null-author rule reads it; a
   * legacy subject without it is nobody's on the person path.
   */
  recordedAt?: Date | string | null;
  /** For an event_amended row: payload.actor_role. Absent for the root. */
  actorRole?: string | null;
};

export type AmendActorStanding = "override" | "verified_professional" | "org_member" | "person";

/** One titular-side ownership interval of the actor on this animal. */
export type TitularTenure = { startedAt: Date | string; endedAt: Date | string | null };

export type AmendActor = {
  userId: string;
  standing: AmendActorStanding;
  /**
   * The actor's titular-side ownerships of this animal, past and present. Only
   * consulted for legacy rows with no recorded author; empty means "no legacy
   * row is theirs", which is the safe answer for a caller that did not read
   * them.
   */
  titularTenures: ReadonlyArray<TitularTenure>;
};

/**
 * The actor's standing, from their profile role and the signature the
 * correction will carry.
 */
export function resolveAmendActorStanding(
  profileRole: string | null | undefined,
  signature: { authorRole: string; authorVerified: boolean },
): AmendActorStanding {
  if (profileRole && OVERRIDE_PROFILE_ROLES.has(profileRole)) return "override";
  if (ORG_SIGNING_ROLES.has(signature.authorRole)) {
    return signature.authorVerified ? "verified_professional" : "org_member";
  }
  return "person";
}

export type AmendAuthorshipRefusal = "professional_authored" | "not_author";

/** es-AR copy for each authorship refusal — shared by the server and the screens. */
export const AMEND_AUTHORSHIP_REFUSAL_COPY: Record<AmendAuthorshipRefusal, string> = {
  professional_authored:
    "Este registro lo cargó o lo corrigió un profesional. Solo un profesional puede corregirlo.",
  not_author: "Solo quien cargó este registro puede corregirlo.",
};

function isVerifiedOrInstitutional(subject: AmendAuthorshipSubject): boolean {
  if (subject.authorVerified === true) return true;
  return subject.actorRole != null && INSTITUTIONAL_ACTOR_ROLES.has(subject.actorRole);
}

function tenureCovers(tenure: TitularTenure, at: Date | string): boolean {
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return false;
  if (new Date(tenure.startedAt).getTime() > t) return false;
  return tenure.endedAt == null || t < new Date(tenure.endedAt).getTime();
}

function isOwnSubject(actor: AmendActor, subject: AmendAuthorshipSubject): boolean {
  if (subject.recordedByUserId != null) return subject.recordedByUserId === actor.userId;
  if (actor.standing !== "person" || subject.authorRole !== "owner") return false;
  const at = subject.recordedAt;
  if (at == null) return false;
  return actor.titularTenures.some((tenure) => tenureCovers(tenure, at));
}

/**
 * Why this actor may NOT correct this record, or null when they may.
 *
 * `subjects` is the root record followed by every correction already on it.
 * Professional authorship is reported first: it is the stronger reason, and the
 * one that tells the owner who CAN fix it.
 */
export function amendAuthorshipRefusal(
  actor: AmendActor,
  subjects: ReadonlyArray<AmendAuthorshipSubject>,
): AmendAuthorshipRefusal | null {
  if (actor.standing === "override" || actor.standing === "verified_professional") return null;
  if (subjects.some(isVerifiedOrInstitutional)) return "professional_authored";
  if (
    actor.standing === "person" &&
    subjects.some((s) => PROFESSIONAL_AUTHOR_ROLES.has(s.authorRole))
  ) {
    return "professional_authored";
  }
  if (!subjects.every((s) => isOwnSubject(actor, s))) return "not_author";
  return null;
}

// ---------------------------------------------------------------------------
// D2 — Projection: fold every amendment onto an event row
// ---------------------------------------------------------------------------
//
// The libreta view projects the corrections onto the original event so the
// "current value" is always displayed. The original event row is never
// touched. In /historial the original is shown in full alongside the amendment.
//
// EVERY AMENDMENT APPLIES, IN ORDER, FIELD BY FIELD (custody audit C1,
// 2026-09-26). A correction carries only the fields it changed: the web form
// (AmendEventForm buildChanges) and the API v1 amend route both diff against
// the ALREADY-corrected payload. So "only the latest amendment applies" made a
// second correction on a different field silently erase the first one
// everywhere — libreta, event detail, pet caches, rederivePetCache. The fold is
// oldest → newest by (occurred_at, recorded_at, id); a field touched twice
// keeps the latest value; a field no amendment touched keeps its raw value.
// The SQL twins (lib/infra/amendment-sql.ts, lib/metrics/rabies.ts) implement
// the same rule per field: the latest amendment THAT TOUCHES the field wins.

export type ChangeEntry = {
  field: string;
  old: unknown;
  new: unknown;
};

export type AmendmentRow = {
  id: string;
  targetEventId: string;
  occurredAt: Date | string;
  reason: string | null;
  changes: ChangeEntry[];
  actorRole: string;
};

function foldChanges(
  payload: Record<string, unknown>,
  amendments: ReadonlyArray<{ changes: ReadonlyArray<ChangeEntry> }>,
): Record<string, unknown> {
  const result = { ...payload };
  for (const amendment of amendments) {
    for (const change of amendment.changes) {
      result[change.field] = change.new;
    }
  }
  return result;
}

/**
 * Given an event payload and a list of amendment rows (sorted oldest → newest),
 * returns the projected payload with EVERY amendment applied in that order.
 *
 * Each change entry overwrites the corresponding field, so a field corrected
 * twice ends on the latest value and a field corrected once keeps that
 * correction even when a later amendment changed a different field.
 */
export function applyAmendments(
  payload: Record<string, unknown>,
  amendments: AmendmentRow[],
): Record<string, unknown> {
  if (amendments.length === 0) return payload;
  return foldChanges(payload, amendments);
}

/**
 * Returns the latest amendment for an event, or null if none.
 * Convenience wrapper for callers that only need the latest (the "Corregido"
 * badge date) — NEVER for projecting a value: use applyAmendments for that.
 */
export function latestAmendment(amendments: AmendmentRow[]): AmendmentRow | null {
  return amendments.length > 0 ? amendments[amendments.length - 1] : null;
}

// ---------------------------------------------------------------------------
// D2 at the read boundary — overlay a whole event stream in one pass
// ---------------------------------------------------------------------------

type OverlayableEvent = {
  id: string;
  eventType: string;
  occurredAt: Date | string;
  payload: unknown;
  // EL-F3: recorded_at is the tiebreaker when two amendments share occurred_at.
  // Optional so minimal callers/tests still type-check; absent → treated as
  // oldest so a row that DOES carry recordedAt wins the tie.
  recordedAt?: Date | string;
  // When BOTH the amendment and its target carry it, they must match: an
  // amendment never corrects another animal's record (the SQL twin enforces
  // the same with `am.pet_id`). Optional for streams that select no pet id.
  petId?: string;
};

/**
 * EL-F3 tiebreaker parity with the SQL twin (amendment-sql.ts:
 * `ORDER BY occurred_at DESC, recorded_at DESC NULLS LAST, id DESC`). Returns
 * true when `cand` is the later amendment: newer occurred_at wins; on a tie the
 * newer recorded_at wins; on a further tie the greater id wins (deterministic).
 */
function amendmentIsLater(
  cand: { occurredAt: Date | string; recordedAt?: Date | string; id: string },
  existing: { occurredAt: Date | string; recordedAt?: Date | string; id: string },
): boolean {
  const co = new Date(cand.occurredAt).getTime();
  const eo = new Date(existing.occurredAt).getTime();
  if (co !== eo) return co > eo;
  const cr =
    cand.recordedAt != null ? new Date(cand.recordedAt).getTime() : Number.NEGATIVE_INFINITY;
  const er =
    existing.recordedAt != null
      ? new Date(existing.recordedAt).getTime()
      : Number.NEGATIVE_INFINITY;
  if (cr !== er) return cr > er;
  return cand.id > existing.id;
}

type PendingAmendment = {
  occurredAt: Date | string;
  recordedAt?: Date | string;
  id: string;
  petId?: string;
  changes: ChangeEntry[];
};

/**
 * Project a fetched event stream so amended events carry their CORRECTED
 * payload (D2: "the current value is always displayed") plus `amendedAt`.
 *
 * This is THE single mechanism every TypeScript read boundary applies
 * (projection-cron audit 2026-07-03 A — applyAmendments existed but no
 * boundary called it, so timelines and KPIs read pre-correction values).
 * Pure and zero-query: callers include `event_amended` rows in the stream
 * they already fetch; this derives the per-target overlay from them.
 *
 *  - `event_amended` rows pass through untouched (the correction itself is a
 *    visible, append-only timeline entry) — they are never upcast.
 *  - Every non-amendment row is first UPCAST (upcastPayload — no-op unless the
 *    event type has a registered v(N+1) upcaster) so a `payload_version` bump
 *    can't silently hand a reader a stale-shaped payload; this makes
 *    overlayAmendments the single payload-access boundary that ALWAYS upcasts
 *    (WAVE D1 / finding 27-#11). The amendment correction is applied ON TOP of
 *    the upcast payload.
 *  - Targeted rows get `payload` projected by folding EVERY amendment on them,
 *    oldest → newest (chains are flattened by amend-event.ts: every amendment
 *    targets the original), and `amendedAt` set to the latest one's occurredAt.
 *  - Untargeted rows get `amendedAt: null`.
 */
export function overlayAmendments<T extends OverlayableEvent>(
  events: T[],
): Array<T & { amendedAt: Date | string | null }> & AmendmentOverlaidBrand {
  // Every amendment per target — a single pass over the stream, then sorted
  // with the (occurred_at, recorded_at, id) order that matches the SQL twin.
  const byTarget = new Map<string, PendingAmendment[]>();
  for (const e of events) {
    if (e.eventType !== "event_amended") continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const targetId = typeof p.target_event_id === "string" ? p.target_event_id : null;
    if (!targetId) continue;
    const list = byTarget.get(targetId) ?? [];
    list.push({
      occurredAt: e.occurredAt,
      recordedAt: e.recordedAt,
      id: e.id,
      petId: e.petId,
      changes: Array.isArray(p.changes) ? (p.changes as ChangeEntry[]) : [],
    });
    byTarget.set(targetId, list);
  }
  for (const list of byTarget.values()) {
    list.sort((a, b) => (amendmentIsLater(a, b) ? 1 : amendmentIsLater(b, a) ? -1 : 0));
  }

  // The brand is a compile-time marker only (A05-7): this is the one place
  // allowed to assert it.
  return events.map((e) => {
    // The correction itself is an append-only timeline entry — never upcast or
    // projected. (event_amended has no schema upcaster anyway.)
    if (e.eventType === "event_amended") return { ...e, amendedAt: null };

    // Upcast first so the reader always sees the latest payload shape, then
    // layer the corrections on top.
    const upcast = upcastPayload(e.eventType as EventType, e.payload) as Record<string, unknown>;
    const amendments = (byTarget.get(e.id) ?? []).filter(
      (a) => a.petId == null || e.petId == null || a.petId === e.petId,
    );
    if (amendments.length === 0) return { ...e, payload: upcast, amendedAt: null };

    return {
      ...e,
      payload: foldChanges(upcast, amendments),
      amendedAt: amendments[amendments.length - 1].occurredAt,
    };
  }) as Array<T & { amendedAt: Date | string | null }> & AmendmentOverlaidBrand;
}

// ---------------------------------------------------------------------------
// Notification type constant (D5)
// ---------------------------------------------------------------------------
//
// Admin/govt amendments send the owner a notification of this type.
// The notifications.notification_type column is free-text (no migration needed
// per AGENTS.md Notifications schema).
export const ADMIN_AMENDMENT_NOTIFICATION_TYPE = "admin_event_amended" as const;
