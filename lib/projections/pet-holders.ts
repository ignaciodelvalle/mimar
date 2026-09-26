// Replay of the NON-caretaker holder intervals of one pet from its spine.
//
// The caretaker half of `ownerships` already has its replay
// (./pet-caretaker.ts). This one covers the four other roles — owner,
// co_owner, shelter_custody, foster — so `rederivePetHolderOwnerships`
// (lib/infra/rederive-pet-ownerships.ts) can compare every holder row against
// the append-only log instead of only checking that an owner is "named
// somewhere" (audit K3/W8).
//
// DETECT ONLY. Nothing here writes; the output is the interval set the spine
// says should exist, and the comparison lives with the DB reader.
//
// HOW EACH EVENT MOVES A HOLDER — one row per writer, swept 2026-09-26:
//
//   pet_registered            custody_kind owner → owner(recorded_by user);
//                             shelter_custody_by_citizen → shelter_custody(user);
//                             owner_by_org → owner(author org);
//                             shelter_custody_by_org → NOTHING by itself: both
//                             writers (create-intake, execute-decomiso) always
//                             append the shelter_intake_recorded that opens it.
//   shelter_intake_recorded   opens shelter_custody for the author org (else
//                             the recording user) UNLESS that subject already
//                             holds a live interval of any role. intake_reason
//                             `seizure` first closes every live interval of
//                             every OTHER subject (execute-decomiso's
//                             endAllLiveOwnerships).
//   foster_assigned           opens foster(foster_user_id).
//   foster_ended              closes foster(foster_user_id).
//   adoption_finalized        closes every live interval, opens
//                             owner(adopter_user_id).
//   adoption_reversed         closes the adopter's owner interval (adopter read
//                             from the finalize it reverts) and opens
//                             shelter_custody for the author org.
//   custody_transferred       closes from(from_role, from subject) and opens
//                             to(to_role, to subject); a to_role of owner also
//                             closes any OTHER live owner (one active owner per
//                             pet is a unique index). Two shapes differ:
//                               - from == to, owner→owner, with a
//                                 foster_ended_event_id: the foster converting
//                                 to owner — closes every live interval first.
//                               - no reason, signed govt: the dispute
//                                 resolution (resolve-dispute.ts), which
//                                 closes every live interval first.
//                               - reason return_to_original_owner: when the
//                                 owner is not live, the decomiso return
//                                 REACTIVATES the former owner's row
//                                 (return-custody-to-owner.ts), so the last
//                                 closed owner interval of that subject is
//                                 reopened instead of a new one being started.
//   ownership_claimed         opens owner(claimed_by_user_id).
//   rehome_sponsorship_started opens shelter_custody(sponsoring org), keyed by
//                             payload.ownership_id.
//   rehome_sponsorship_ended  closes the interval with that ownership_id.
//
// NOT HOLDER EVENTS, deliberately: death_recorded (the owner stays the owner of
// a deceased animal; the foster cascade writes its own foster_ended),
// custody_transfer_proposed / _cancelled (workflow, nothing moves until the
// custody_transferred), custody_dispute_resolved (appended with its OWN later
// `now`, after the custody_transferred that already moved everything),
// caretaker_* (./pet-caretaker.ts).
//
// NOT MAPPABLE, and reported as drift when it happens: co_owner has no writer
// in the app and no event (only scripts/seed-perf.ts inserts one), and
// claim-stub-profile.ts rewrites owner_user_id with no event (latent:
// STUB_CLAIM_ENABLED=false).
//
// SAME-INSTANT ORDER. One transaction appends several events with the same
// occurred_at and recorded_at, and their ids are random, so id order is
// meaningless. Within one instant the replay applies registration first, then
// plain closes, then the rest — the order the writers run their statements in.

import type { ProjectionEvent } from "./types";

export const HOLDER_ROLES = ["owner", "co_owner", "shelter_custody", "foster"] as const;
export type HolderRole = (typeof HOLDER_ROLES)[number];

/** The event types this replay reads. Everything else is ignored. */
export const HOLDER_EVENT_TYPES = [
  "pet_registered",
  "shelter_intake_recorded",
  "foster_assigned",
  "foster_ended",
  "adoption_finalized",
  "adoption_reversed",
  "custody_transferred",
  "ownership_claimed",
  "rehome_sponsorship_started",
  "rehome_sponsorship_ended",
] as const;

/**
 * A spine row as this replay needs it: the projection shape plus authorship.
 * `ProjectionEvent` omits authorship on purpose, and this is the one projector
 * that needs it: pet_registered and shelter_intake_recorded name their holder
 * only as the recording user or authoring org.
 */
export type HolderEvent = ProjectionEvent & {
  recordedByUserId: string | null;
  authorOrganizationId: string | null;
  authorRole?: string | null;
};

/** `user:<uuid>` or `org:<uuid>` — the same key an ownerships row reduces to. */
export type HolderSubject = string;

export type HolderInterval = {
  role: HolderRole;
  subject: HolderSubject;
  startedAt: Date;
  endedAt: Date | null;
  /** Event that opened the interval. */
  openedByEventId: string;
  openedByEventType: string;
  /** Only rehome sponsorships name their row on the spine. */
  ownershipId: string | null;
};

export function userSubject(id: string): HolderSubject {
  return `user:${id}`;
}

export function orgSubject(id: string): HolderSubject {
  return `org:${id}`;
}

const SAME_INSTANT_RANK: Record<string, number> = {
  pet_registered: 0,
  foster_ended: 1,
  rehome_sponsorship_ended: 1,
};

function rank(eventType: string): number {
  return SAME_INSTANT_RANK[eventType] ?? 2;
}

export function orderHolderEvents(events: HolderEvent[]): HolderEvent[] {
  return [...events].sort(
    (a, b) =>
      toDate(a.occurredAt).getTime() - toDate(b.occurredAt).getTime() ||
      rank(a.eventType) - rank(b.eventType) ||
      toDate(a.recordedAt).getTime() - toDate(b.recordedAt).getTime() ||
      a.id.localeCompare(b.id),
  );
}

/** The interval set the spine says `ownerships` should hold, in start order. */
export function replayPetHolders(events: HolderEvent[]): HolderInterval[] {
  const state = new HolderState();
  const ordered = orderHolderEvents(events);
  const byId = new Map(ordered.map((e) => [e.id, e]));
  for (const event of ordered) applyEvent(state, event, ordered, byId);
  return state.intervals.sort(
    (a, b) =>
      a.startedAt.getTime() - b.startedAt.getTime() ||
      a.role.localeCompare(b.role) ||
      a.subject.localeCompare(b.subject),
  );
}

class HolderState {
  intervals: HolderInterval[] = [];

  live(): HolderInterval[] {
    return this.intervals.filter((i) => i.endedAt === null);
  }

  liveFor(role: HolderRole, subject: HolderSubject): HolderInterval | undefined {
    return this.intervals.find(
      (i) => i.endedAt === null && i.role === role && i.subject === subject,
    );
  }

  open(role: HolderRole, subject: HolderSubject, event: HolderEvent, ownershipId?: string): void {
    // Idempotent: a second opening fact for a live holder is not a second row.
    if (this.liveFor(role, subject)) return;
    this.intervals.push({
      role,
      subject,
      startedAt: toDate(event.occurredAt),
      endedAt: null,
      openedByEventId: event.id,
      openedByEventType: event.eventType,
      ownershipId: ownershipId ?? null,
    });
  }

  close(role: HolderRole, subject: HolderSubject, at: Date): void {
    const interval = this.liveFor(role, subject);
    if (interval) interval.endedAt = at;
  }

  closeAll(at: Date, keep?: (i: HolderInterval) => boolean): void {
    for (const interval of this.live()) {
      if (keep?.(interval)) continue;
      interval.endedAt = at;
    }
  }
}

function applyEvent(
  state: HolderState,
  event: HolderEvent,
  ordered: HolderEvent[],
  byId: Map<string, HolderEvent>,
): void {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const at = toDate(event.occurredAt);

  switch (event.eventType) {
    case "pet_registered":
      applyRegistration(state, event, p);
      return;
    case "shelter_intake_recorded": {
      const subject = authorSubject(event);
      if (!subject) return;
      if (p.intake_reason === "seizure") state.closeAll(at, (i) => i.subject === subject);
      if (state.live().some((i) => i.subject === subject)) return;
      state.open("shelter_custody", subject, event);
      return;
    }
    case "foster_assigned": {
      const foster = readString(p.foster_user_id);
      if (foster) state.open("foster", userSubject(foster), event);
      return;
    }
    case "foster_ended": {
      const foster = readString(p.foster_user_id);
      if (foster) state.close("foster", userSubject(foster), at);
      return;
    }
    case "adoption_finalized": {
      state.closeAll(at);
      const adopter = readString(p.adopter_user_id);
      if (adopter) state.open("owner", userSubject(adopter), event);
      return;
    }
    case "adoption_reversed":
      applyReversal(state, event, p, ordered, byId);
      return;
    case "custody_transferred":
      applyTransfer(state, event, p);
      return;
    case "ownership_claimed": {
      const claimant = readString(p.claimed_by_user_id);
      if (claimant) state.open("owner", userSubject(claimant), event);
      return;
    }
    case "rehome_sponsorship_started": {
      const org = readString(p.sponsoring_organization_id);
      const ownershipId = readString(p.ownership_id) ?? undefined;
      if (org) state.open("shelter_custody", orgSubject(org), event, ownershipId);
      return;
    }
    case "rehome_sponsorship_ended": {
      const ownershipId = readString(p.ownership_id);
      const interval = state.live().find((i) => ownershipId && i.ownershipId === ownershipId);
      if (interval) interval.endedAt = at;
      return;
    }
    default:
      return;
  }
}

function applyRegistration(
  state: HolderState,
  event: HolderEvent,
  p: Record<string, unknown>,
): void {
  // The schema defaults a missing custody_kind to `owner`.
  const kind = readString(p.custody_kind) ?? "owner";
  const user = event.recordedByUserId ? userSubject(event.recordedByUserId) : null;
  const org = event.authorOrganizationId ? orgSubject(event.authorOrganizationId) : null;
  if (kind === "owner" && user) state.open("owner", user, event);
  else if (kind === "shelter_custody_by_citizen" && user)
    state.open("shelter_custody", user, event);
  else if (kind === "owner_by_org" && org) state.open("owner", org, event);
  // shelter_custody_by_org: opened by the shelter_intake_recorded beside it.
}

function applyReversal(
  state: HolderState,
  event: HolderEvent,
  p: Record<string, unknown>,
  ordered: HolderEvent[],
  byId: Map<string, HolderEvent>,
): void {
  const at = toDate(event.occurredAt);
  const referenced = readString(p.reverted_finalization_event_id);
  const finalize =
    (referenced ? byId.get(referenced) : undefined) ??
    // Older reversals carry no reference: the finalize they undo is the last
    // one before them.
    ordered
      .filter(
        (e) =>
          e.eventType === "adoption_finalized" &&
          toDate(e.occurredAt).getTime() <= at.getTime() &&
          e.id !== event.id,
      )
      .at(-1);
  const fp = (finalize?.payload ?? {}) as Record<string, unknown>;
  const adopter = readString(fp.adopter_user_id);
  if (adopter) state.close("owner", userSubject(adopter), at);
  const org = event.authorOrganizationId ?? readString(fp.previous_owner_organization_id);
  if (org) state.open("shelter_custody", orgSubject(org), event);
}

function applyTransfer(state: HolderState, event: HolderEvent, p: Record<string, unknown>): void {
  const at = toDate(event.occurredAt);
  const fromRole = asHolderRole(p.from_role);
  const toRole = asHolderRole(p.to_role);
  const from = partySubject(p.from_user_id, p.from_organization_id);
  const to = partySubject(p.to_user_id, p.to_organization_id);

  const fosterConversion =
    from !== null &&
    from === to &&
    fromRole === "owner" &&
    toRole === "owner" &&
    readString(p.foster_ended_event_id) !== null;
  // resolve-dispute.ts is the one writer that omits `reason`, and it signs govt.
  const disputeResolution = readString(p.reason) === null && event.authorRole === "govt";
  if (fosterConversion || disputeResolution) state.closeAll(at);

  if (fromRole && from) state.close(fromRole, from, at);
  if (!toRole || !to) return;

  if (toRole === "owner") {
    for (const other of state.live()) {
      if (other.role === "owner" && other.subject !== to) other.endedAt = at;
    }
    if (p.reason === "return_to_original_owner" && !state.liveFor("owner", to)) {
      const former = state.intervals
        .filter((i) => i.role === "owner" && i.subject === to && i.endedAt !== null)
        .at(-1);
      if (former) {
        former.endedAt = null;
        return;
      }
    }
  }
  state.open(toRole, to, event);
}

function authorSubject(event: HolderEvent): HolderSubject | null {
  if (event.authorOrganizationId) return orgSubject(event.authorOrganizationId);
  if (event.recordedByUserId) return userSubject(event.recordedByUserId);
  return null;
}

function partySubject(user: unknown, org: unknown): HolderSubject | null {
  const orgId = readString(org);
  if (orgId) return orgSubject(orgId);
  const userId = readString(user);
  return userId ? userSubject(userId) : null;
}

function asHolderRole(value: unknown): HolderRole | null {
  return typeof value === "string" && (HOLDER_ROLES as readonly string[]).includes(value)
    ? (value as HolderRole)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
