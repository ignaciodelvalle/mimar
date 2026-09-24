// Owner-facing "first stranger scan" lesson.
//
// WHY (owner-onboarding train): the landing's Pampa demo deliberately teaches
// curiosity, not privacy ("Escanealo para ver más sobre Pampa") — the privacy
// lesson lives at alta instead (PetCreatedAha's self-scan block). This
// notification is the THIRD beat of that same lesson: the moment it stops
// being hypothetical. The first time an actual stranger scans the pet's
// public credential, the owner gets told — "así funciona el QR" — so the
// abstract "anyone who scans sees X" becomes a concrete, lived fact tied to
// their own pet.
//
// ONE-TIME GUARANTEE: dedupeKey is `first_stranger_scan:${petId}:${userId}`
// — STABLE per (pet, owner), not per scan/event. createNotification's
// ON_CONFLICT (dedupe_key) DO NOTHING makes every call after the first a
// no-op at the DB level, so this can be called on EVERY non-self scan
// without a separate "has this already fired?" pre-check/query — the second,
// third, Nth stranger scan simply never inserts a second row. Self-scans
// never reach this at all (see log-scan.ts's `!isSelfScan` gate).
//
// Best-effort: this runs POST-event-insert; a failure here never affects the
// scan that already recorded.

import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { db, ownerships } from "@/db";
import { createNotification } from "@/lib/infra/notification-service";

export type FirstStrangerScanNotifyInput = {
  petId: string;
  petName: string;
  petPublicToken: string;
  /** credential_scanned event id, for traceability (relatedEventId). Optional. */
  eventId?: string | null;
};

export type FirstStrangerScanNotifyDeps = {
  /** Resolve current human owner/co-owner user ids for a pet. */
  findOwnerUserIds: (petId: string) => Promise<string[]>;
  createNotification: typeof createNotification;
};

const defaultDeps: FirstStrangerScanNotifyDeps = {
  findOwnerUserIds: async (petId: string) => {
    const rows = await db
      .select({ userId: ownerships.ownerUserId })
      .from(ownerships)
      .where(
        and(
          eq(ownerships.petId, petId),
          inArray(ownerships.role, ["owner", "co_owner"]),
          isNull(ownerships.endedAt),
        ),
      );
    return rows
      .map((r) => r.userId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  },
  createNotification,
};

export type FirstStrangerScanNotifyResult = { delivered: number };

/**
 * Notify the pet's current owner(s) the first time a non-owner scans its
 * public credential. Idempotent per (pet, owner) via dedupeKey — see the
 * module docblock. Best-effort: swallows its own errors.
 */
export async function notifyOwnerOfFirstStrangerScan(
  input: FirstStrangerScanNotifyInput,
  deps: FirstStrangerScanNotifyDeps = defaultDeps,
): Promise<FirstStrangerScanNotifyResult> {
  try {
    const ownerIds = [...new Set(await deps.findOwnerUserIds(input.petId))];
    if (ownerIds.length === 0) return { delivered: 0 };

    let delivered = 0;
    for (const userId of ownerIds) {
      const res = await deps.createNotification({
        userId,
        notificationType: "first_stranger_scan",
        severity: "info",
        title: `Alguien escaneó la credencial de ${input.petName} por primera vez`,
        body: `Así funciona el QR: un desconocido vio la credencial pública de ${input.petName} — solo lo que vos decidiste mostrar, nunca más que eso.`,
        ctaLabel: "Ver qué se comparte",
        ctaUrl: `/mis-mascotas/${input.petPublicToken}`,
        relatedPetId: input.petId,
        relatedEventId: input.eventId ?? null,
        dedupeKey: `first_stranger_scan:${input.petId}:${userId}`,
      });
      if (res.status === "inserted") delivered += 1;
    }
    return { delivered };
  } catch (err) {
    console.error("[notifyOwnerOfFirstStrangerScan] failed (scan did persist):", err);
    return { delivered: 0 };
  }
}
