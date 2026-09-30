// The visits module's entry points for a server surface (vet-visit-record).
//
// Wires the use-cases (ensureOpenVisit, closeVisit) to the Drizzle repository
// and the database transaction, so a caller in `app/` never holds a
// transaction itself (canon B02: writes go only through src/modules). Also
// the two reads a visit-aware page needs. No authorization here — every
// caller has already resolved the actor at the organization.

import "server-only";

import { and, asc, eq, gte, lte } from "drizzle-orm";

import { appointments, db, serviceOfferings, timeSlots } from "@/db";
import { EventsRepository } from "@/src/modules/events/infrastructure/events-repository";

import { type CloseVisitResult, closeVisit } from "../application/close-visit";
import {
  type EnsureOpenVisitInput,
  type EnsureOpenVisitResult,
  ensureOpenVisit,
} from "../application/ensure-open-visit";
import { VISIT_STALE_HOURS, type Visit, type VisitKey, type VisitModality } from "../domain/types";
import { VisitScopedEventsRepository } from "./visit-scoped-events-repository";
import { VisitsRepository } from "./visits-repository";

function transaction<T>(cb: (tx: unknown) => Promise<T>): Promise<T> {
  return db.transaction(cb as Parameters<typeof db.transaction>[0]) as Promise<T>;
}

/** Open (or reuse) the visit for the key. See ensureOpenVisit. */
export function openVisit(input: EnsureOpenVisitInput): Promise<EnsureOpenVisitResult> {
  return ensureOpenVisit({ repo: new VisitsRepository(), transaction }, input);
}

/** closeVisitOfPet's own refusal, alongside close-visit's "not_found". */
export type CloseVisitOfPetResult = CloseVisitResult | { ok: false; reason: "not_authorized" };

/**
 * Close a visit of this organization, and of this pet — a visit of another
 * pet reads as not found, the same as an unknown id.
 *
 * `visitId` is a client-changeable bound argument, so identity alone is not
 * authorization: closing is restricted to the visit's OWN vet
 * (`visit.vetUserId === actorUserId`) or an org admin (`isOrgAdmin`) — a
 * colleague who merely shares the organization is refused, the visit stays
 * open. A visit whose vet was erased (`vetUserId` null) has no "own vet" left,
 * so only an admin can close it.
 */
export async function closeVisitOfPet(input: {
  visitId: string;
  petId: string;
  organizationId: string;
  actorUserId: string;
  isOrgAdmin: boolean;
}): Promise<CloseVisitOfPetResult> {
  const repo = new VisitsRepository();
  const visit = await repo.findVisitById(input.visitId, db);
  if (!visit || visit.petId !== input.petId || visit.organizationId !== input.organizationId) {
    return { ok: false, reason: "not_found" };
  }
  if (!input.isOrgAdmin && visit.vetUserId !== input.actorUserId) {
    return { ok: false, reason: "not_authorized" };
  }
  return closeVisit(
    { repo, transaction },
    {
      visitId: input.visitId,
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
    },
  );
}

/**
 * The events repository for a write inside the key's visit: visit-scoped when
 * the visit resolves.
 *
 * A failure to resolve the visit does NOT refuse the write. The visit is
 * operational metadata (invariant 3) — a grouping — and the clinical fact
 * being recorded outranks it. The row then lands unstamped, exactly like every
 * row written before visits existed, and the failure is logged.
 */
export async function visitScopedEventsRepository(key: VisitKey): Promise<EventsRepository> {
  try {
    const resolved = await openVisit(key);
    if (resolved.ok) return new VisitScopedEventsRepository(resolved.visit);
  } catch (err) {
    console.error("[visits] visit resolution failed; writing unstamped", err);
  }
  return new EventsRepository();
}

/**
 * The key's visit that is open right now, or null. A visit past the stale
 * window does not count (the next write closes it as expired); the read
 * itself changes nothing.
 */
export async function findCurrentOpenVisit(key: VisitKey): Promise<Visit | null> {
  const open = await new VisitsRepository().findOpenVisits(key, VISIT_STALE_HOURS, db);
  const current = open.find((v) => !v.stale);
  if (!current) return null;
  const { stale: _stale, ...visit } = current;
  return visit;
}

export type AttendableAppointment = {
  id: string;
  offeringName: string;
  startsAt: Date;
  modality: VisitModality;
};

/** How far either side of now an appointment is still "the one being attended". */
const ATTENDABLE_WINDOW_HOURS = 12;

/**
 * The pet's confirmed appointments at the organization around `now` — what a
 * vet may link a visit to. The offering's name, the time and the modality:
 * no owner data.
 */
export async function listAttendableAppointments(
  key: Pick<VisitKey, "petId" | "organizationId">,
  now: Date,
): Promise<AttendableAppointment[]> {
  const windowMs = ATTENDABLE_WINDOW_HOURS * 3_600_000;
  const rows = await db
    .select({
      id: appointments.id,
      offeringName: serviceOfferings.displayName,
      startsAt: timeSlots.startsAt,
      modality: appointments.modality,
    })
    .from(appointments)
    .innerJoin(timeSlots, eq(timeSlots.id, appointments.slotId))
    .innerJoin(serviceOfferings, eq(serviceOfferings.id, appointments.serviceOfferingId))
    .where(
      and(
        eq(appointments.petId, key.petId),
        eq(appointments.organizationId, key.organizationId),
        eq(appointments.status, "confirmed"),
        gte(timeSlots.startsAt, new Date(now.getTime() - windowMs)),
        lte(timeSlots.startsAt, new Date(now.getTime() + windowMs)),
      ),
    )
    .orderBy(asc(timeSlots.startsAt))
    .limit(5);
  return rows.map((r) => ({ ...r, modality: r.modality as VisitModality }));
}
