// Use-case: revokeServiceDogCredential (strangler migration 14/61).
//
// Admin/govt revocation. Mirrors the vet/org revocation pattern: motivo
// >=30 chars, requires the actor be admin or govt-in-scope of the pet's
// jurisdiction. Audit trail + notification to the owner.
//
// Auth guard lifted into the shim (app/actions/service-dog.ts); the use-case
// receives the authenticated userId + inputs and runs the rest verbatim.

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { auditLog, db, notifications, ownerships, petServiceDog, pets } from "@/db";
import { canRevoke } from "@/lib/domain/revocation-scope";

import type { RevokeServiceDogInput } from "./types";

export async function revokeServiceDogCredential(
  userId: string,
  input: RevokeServiceDogInput,
): Promise<{ ok: true } | { error: string }> {
  const motivo = input.motivo.trim();
  if (motivo.length < 30) {
    return { error: "El motivo de la revocación debe tener al menos 30 caracteres." };
  }

  const { profiles } = await import("@/db");
  const [actorProfile] = await db
    .select({
      id: profiles.id,
      role: profiles.role,
      accountType: profiles.accountType,
      deactivatedAt: profiles.deactivatedAt,
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  if (
    !actorProfile ||
    actorProfile.accountType !== "institutional" ||
    (actorProfile.role !== "admin" && actorProfile.role !== "govt") ||
    actorProfile.deactivatedAt !== null
  ) {
    return { error: "Solo admin/govt pueden revocar credenciales de asistencia." };
  }

  const [petRow] = await db
    .select({
      pet: pets,
      sd: petServiceDog,
    })
    .from(pets)
    .innerJoin(petServiceDog, eq(petServiceDog.petId, pets.id))
    .where(eq(pets.publicToken, input.petPublicToken))
    .limit(1);
  if (!petRow) return { error: "Credencial no encontrada para esa mascota." };

  // Govt scope check: must hold an assignment for the pet's jurisdiction.
  // We reuse canRevoke from lib/revocation-scope which already understands
  // the (province, locality) tuple model.
  if (actorProfile.role === "govt") {
    const { govtAssignments } = await import("@/db");
    const assignments = await db
      .select({
        province: govtAssignments.jurisdictionProvince,
        locality: govtAssignments.jurisdictionLocality,
      })
      .from(govtAssignments)
      .where(and(eq(govtAssignments.userId, userId), isNull(govtAssignments.revokedAt)));
    const inScope = canRevoke(
      { id: userId, role: "govt" },
      {
        type: "org_verification",
        province: petRow.pet.jurisdictionProvince ?? "",
        locality: petRow.pet.jurisdictionLocality ?? "",
      },
      assignments,
    );
    if (!inScope) {
      return { error: "La mascota está fuera de tu jurisdicción." };
    }
  }

  if (petRow.sd.credentialStatus === "revocada") {
    return { error: "La credencial ya está revocada." };
  }

  const now = new Date();
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(petServiceDog)
        .set({
          credentialStatus: "revocada",
          revokedAt: now,
          revokedByUserId: userId,
          revocationReason: motivo,
          updatedAt: now,
        })
        .where(eq(petServiceDog.id, petRow.sd.id));

      await tx.insert(auditLog).values({
        actorUserId: userId,
        action: "service_dog_credential_revoked",
        targetUserId: null,
        payload: {
          pet_id: petRow.pet.id,
          pet_public_token: petRow.pet.publicToken,
          reason: motivo,
        },
      });

      // Notify the owner — fetch the current owner_user_id.
      const [owner] = await tx
        .select({ id: ownerships.ownerUserId })
        .from(ownerships)
        .where(
          and(
            eq(ownerships.petId, petRow.pet.id),
            eq(ownerships.role, "owner"),
            isNull(ownerships.endedAt),
          ),
        )
        .limit(1);
      if (owner?.id) {
        await tx.insert(notifications).values({
          userId: owner.id,
          notificationType: "service_dog_credential_revoked",
          title: "Tu credencial RUPGA fue revocada",
          body: `Motivo: ${motivo}. El banner público de acceso ya no se muestra. Comunicate con ANDIS si querés apelar.`,
          severity: "warning",
          relatedPetId: petRow.pet.id,
          ctaLabel: "Ver mascota",
          ctaUrl: `/mis-mascotas/${input.petPublicToken}/asistencia`,
        });
      }
    });
  } catch (err) {
    return {
      error: `No se pudo revocar: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  revalidatePath(`/mis-mascotas/${input.petPublicToken}/asistencia`);
  revalidatePath(`/p/${input.petPublicToken}`);
  return { ok: true };
}
