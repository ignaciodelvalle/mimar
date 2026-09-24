// Use-cases: org-side offering lifecycle — pause, unpause, archive.
//
// Each operation:
//   1. Validates ownership (org token check happens at the action level).
//   2. Loads the offering, validates current state.
//   3. Issues a single UPDATE (no transaction needed — single-row, no notifications).
//
// Auth guard + org-ownership check live in the action.
// These use-cases receive a pre-authorized (orgId, offeringPublicToken) pair.

import { appointments, db, serviceOfferings, timeSlots } from "@/db";
import { and, eq, gt } from "drizzle-orm";

import type { ServiceOfferingResult } from "../domain/types";

export async function pauseServiceOfferingUseCase(
  orgId: string,
  publicToken: string,
): Promise<ServiceOfferingResult> {
  const [offering] = await db
    .select({ id: serviceOfferings.id, status: serviceOfferings.status })
    .from(serviceOfferings)
    .where(
      and(
        eq(serviceOfferings.publicToken, publicToken),
        eq(serviceOfferings.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!offering) return { error: "Servicio no encontrado." };
  if (offering.status === "archived") return { error: "No podés pausar un servicio archivado." };
  if (offering.status === "paused") return { error: "El servicio ya está pausado." };

  await db
    .update(serviceOfferings)
    .set({ status: "paused", updatedAt: new Date() })
    .where(eq(serviceOfferings.id, offering.id));

  return { ok: true };
}

export async function unpauseServiceOfferingUseCase(
  orgId: string,
  publicToken: string,
): Promise<ServiceOfferingResult> {
  const [offering] = await db
    .select({ id: serviceOfferings.id, status: serviceOfferings.status })
    .from(serviceOfferings)
    .where(
      and(
        eq(serviceOfferings.publicToken, publicToken),
        eq(serviceOfferings.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!offering) return { error: "Servicio no encontrado." };
  if (offering.status !== "paused") return { error: "El servicio no está pausado." };

  await db
    .update(serviceOfferings)
    .set({ status: "approved", updatedAt: new Date() })
    .where(eq(serviceOfferings.id, offering.id));

  return { ok: true };
}

export async function archiveServiceOfferingUseCase(
  orgId: string,
  publicToken: string,
): Promise<ServiceOfferingResult> {
  const [offering] = await db
    .select({ id: serviceOfferings.id, status: serviceOfferings.status })
    .from(serviceOfferings)
    .where(
      and(
        eq(serviceOfferings.publicToken, publicToken),
        eq(serviceOfferings.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!offering) return { error: "Servicio no encontrado." };
  if (offering.status === "archived") return { error: "El servicio ya está archivado." };

  // Archiving with future confirmed appointments would strand the owners who
  // booked them — they must be attended or cancelled first.
  const [pending] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .innerJoin(timeSlots, eq(timeSlots.id, appointments.slotId))
    .where(
      and(
        eq(appointments.serviceOfferingId, offering.id),
        eq(appointments.status, "confirmed"),
        gt(timeSlots.startsAt, new Date()),
      ),
    )
    .limit(1);
  if (pending) {
    return {
      error: "Hay turnos confirmados a futuro para este servicio. Cancelalos antes de eliminarlo.",
    };
  }

  await db
    .update(serviceOfferings)
    .set({ status: "archived", updatedAt: new Date() })
    .where(eq(serviceOfferings.id, offering.id));

  return { ok: true };
}
