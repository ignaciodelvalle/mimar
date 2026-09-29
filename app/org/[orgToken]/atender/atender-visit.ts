// The Atender surface's side of the visits module (vet-visit-record).
//
// Every walk-in write belongs to a VISIT — one signer, one pet, one
// organization, one sitting (migration 0273). This module maps a resolved
// Atender access onto the visits module's key (pet, organization, signer):
//
//   · atenderEventsRepository — what every Atender writer hands its use-case in
//     place of a plain EventsRepository. It opens (or reuses) the signer's
//     visit implicitly, so care is NEVER refused for want of an explicit
//     "Iniciar atención", and stamps the visit's id on the rows the signer
//     writes. A visit that fails to resolve never refuses the write.
//   · openAtenderVisit — the explicit open from the VisitCard (modality, and
//     optionally the appointment being attended), and the intake's open.
//   · findCurrentAtenderVisit / listAtenderAppointments — the page's reads.
//
// Authorization is the caller's: every function takes the SUCCESS of
// resolveAtenderPet (event.write on this organization + the DIM code). Nothing
// here widens it.
//
// Kept apart from actions.ts on purpose: the action tests mock "@/db" with a
// bare transaction, and the visits module evaluates table columns at import
// time. Those tests mock THIS module instead.

import "server-only";

import type { EventsRepository } from "@/src/modules/events/infrastructure/events-repository";
import type { EnsureOpenVisitResult } from "@/src/modules/visits/application/ensure-open-visit";
import type { Visit, VisitModality } from "@/src/modules/visits/domain/types";
import {
  type AttendableAppointment,
  findCurrentOpenVisit,
  listAttendableAppointments,
  openVisit,
  visitScopedEventsRepository,
} from "@/src/modules/visits/infrastructure/visit-service";

import type { AtenderAccessSuccess } from "./atender-access";

export type AtenderVisitAccess = Pick<AtenderAccessSuccess, "user" | "organizationId"> & {
  pet: Pick<AtenderAccessSuccess["pet"], "id">;
};

function keyOf(access: AtenderVisitAccess) {
  return {
    petId: access.pet.id,
    organizationId: access.organizationId,
    vetUserId: access.user.id,
  };
}

export function openAtenderVisit(
  access: AtenderVisitAccess,
  opts: { modality?: VisitModality; appointmentId?: string | null } = {},
): Promise<EnsureOpenVisitResult> {
  return openVisit({
    ...keyOf(access),
    ...(opts.modality ? { modality: opts.modality } : {}),
    appointmentId: opts.appointmentId ?? null,
  });
}

export function atenderEventsRepository(access: AtenderVisitAccess): Promise<EventsRepository> {
  return visitScopedEventsRepository(keyOf(access));
}

export function findCurrentAtenderVisit(access: AtenderVisitAccess): Promise<Visit | null> {
  return findCurrentOpenVisit(keyOf(access));
}

export function listAtenderAppointments(
  access: AtenderVisitAccess,
  now: Date,
): Promise<AttendableAppointment[]> {
  return listAttendableAppointments(keyOf(access), now);
}
