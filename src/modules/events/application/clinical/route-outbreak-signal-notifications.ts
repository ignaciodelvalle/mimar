// route-outbreak-signal-notifications
//
// Shared helper — routes an outbreak_signal event to authority targets.
// Extracted from app/actions/events.ts::routeOutbreakSignalNotifications.
//
// Design:
//   - Reads authority IDs via findAuthoritiesForJurisdiction (uses db, not tx — acceptable
//     for read-only scope resolution inside a write transaction).
//   - Loads profiles in one batch to build per-recipient CTA URLs.
//   - Pushes notifications onto the caller's pendingNotifications array.
//   - NEVER inserts notifications inside the transaction (failure must not roll back).
//   - Used by: recordDiseaseDiagnosisWriter, createSymptomObservedWriter (WU-5).

import { inArray } from "drizzle-orm";

import { type db, type petEvents, type pets, profiles } from "@/db";
import { findAuthoritiesForJurisdiction } from "@/lib/infra/approval-routing";
import { speciesLabel } from "@/lib/utils/format";

import type { NewNotification } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RouteSignalArgs = {
  signalEvent: typeof petEvents.$inferSelect;
  pet: Pick<
    typeof pets.$inferSelect,
    | "id"
    | "jurisdictionProvince"
    | "jurisdictionLocality"
    | "jurisdictionCountry"
    | "species"
    | "publicToken"
  >;
  disease: {
    disease_code: string;
    disease_label: string;
    high_count: number;
    medium_count: number;
  };
  escalation?: boolean;
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Route a notification for each outbreak_signal event to authority targets.
 *
 * Uses findAuthoritiesForJurisdiction — routes to govts in scope first,
 * falls back to active institutional admins when no govt covers the locality.
 * CTA is per-recipient: govt → /gob/cola, admin → /admin/cola.
 *
 * Notifications are pushed onto the caller's pendingNotifications array instead
 * of being inserted inside the transaction. This prevents notification-insert
 * failures from rolling back the business write.
 */
export async function routeOutbreakSignalNotifications(
  tx: Tx,
  args: RouteSignalArgs,
  pendingNotifications: NewNotification[],
): Promise<void> {
  const { signalEvent, pet, disease, escalation } = args;

  const province = pet.jurisdictionProvince ?? "";
  const locality = pet.jurisdictionLocality ?? "";

  const authorityIds = await findAuthoritiesForJurisdiction({ province, locality });

  if (authorityIds.length === 0) {
    console.warn(
      `No authorities to route outbreak_signal ${signalEvent.id} (disease=${disease.disease_code}, jurisdiction=${locality}/${province}). Signal recorded but no notification sent.`,
    );
    return;
  }

  const authorityProfiles = await tx
    .select({ id: profiles.id, role: profiles.role })
    .from(profiles)
    .where(inArray(profiles.id, authorityIds));

  const localityPart = pet.jurisdictionLocality ? ` en ${pet.jurisdictionLocality}` : "";
  const titlePrefix = escalation ? "URGENTE — " : "Signal: ";
  const title = `${titlePrefix}posible ${disease.disease_label}${localityPart}`;

  const bodyLines = [
    `**Signal automático.** Síntomas auto-reportados por dueño matchearon con la enfermedad reportable **${disease.disease_label}**.`,
    "",
  ];
  if (escalation) {
    bodyLines.push(
      "**Observación antirrábica activa.** Esta señal ocurre dentro del período de 10 días de observación post-mordedura. Coordinar inspección inmediata.",
      "",
    );
  }
  bodyLines.push(
    `- Especie: ${speciesLabel(pet.species)}`,
    `- Jurisdicción: ${[pet.jurisdictionLocality, pet.jurisdictionProvince].filter(Boolean).join(", ") || "no especificada"}`,
    `- Match strength: ${disease.high_count} high · ${disease.medium_count} medium`,
    "",
    "_No es diagnóstico. Considerá el contexto: cuántos signals similares en la jurisdicción / período._",
  );
  const body = bodyLines.join("\n");
  const severity = escalation ? ("urgent" as const) : ("warning" as const);

  for (const authority of authorityProfiles) {
    const ctaUrl = authority.role === "govt" ? "/gob/cola" : "/admin/cola";
    pendingNotifications.push({
      userId: authority.id,
      notificationType: "outbreak_signal_detected",
      title,
      body,
      severity,
      relatedPetId: pet.id,
      relatedEventId: signalEvent.id,
      ctaLabel: "Ver señales",
      ctaUrl,
    });
  }
}
