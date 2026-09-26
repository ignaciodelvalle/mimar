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
import { eventPlaceTarget } from "@/lib/events/event-place-target";
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
  > & {
    /** The home's catalogue row (localidades-por-id D3); absent = name path. */
    localityId?: string | null;
  };
  disease: {
    disease_code: string;
    disease_label: string;
    high_count: number;
    medium_count: number;
  };
  escalation?: boolean;
  /**
   * Who described what the signal is built on — the notice says so instead of
   * calling every signal "auto-reportado por dueño" (health audit). Absent =
   * derived: a diagnosis-derived signal is a vet's, any other an owner's.
   */
  origin?: SignalOrigin;
};

export type SignalOrigin = "owner" | "witness" | "vet";

const ORIGIN_SENTENCE: Record<SignalOrigin, string> = {
  owner: "Síntomas descritos por quien cuida al animal",
  witness: "Síntomas descritos en una denuncia de bienestar animal",
  vet: "Diagnóstico registrado por un veterinario",
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
  const payload = (signalEvent.payload ?? {}) as Record<string, unknown>;
  const origin: SignalOrigin =
    args.origin ?? (payload.triggered_by === "direct_diagnosis" ? "vet" : "owner");

  // PO S10 (2026-09-26): the authority where it OCCURRED — the signal's own
  // place — never the pet's home when the signal carries a place. A place
  // that resolved to no row is a province-level notice.
  const occurred = await eventPlaceTarget(tx, payload);
  const province = (occurred ? occurred.jurisdictionProvince : pet.jurisdictionProvince) ?? "";
  const locality = (occurred ? occurred.jurisdictionLocality : pet.jurisdictionLocality) ?? "";
  const localityId = occurred ? (occurred.place?.localityId ?? null) : pet.localityId;

  const authorityIds = await findAuthoritiesForJurisdiction({
    province,
    locality,
    ...(localityId !== undefined ? { localityId } : {}),
  });

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

  const localityPart = locality ? ` en ${locality}` : province ? ` en ${province}` : "";
  const titlePrefix = escalation ? "URGENTE — " : "Signal: ";
  const title = `${titlePrefix}posible ${disease.disease_label}${localityPart}`;

  const bodyLines = [
    origin === "vet"
      ? `**Señal automática.** ${ORIGIN_SENTENCE.vet}: enfermedad reportable **${disease.disease_label}**.`
      : `**Señal automática.** ${ORIGIN_SENTENCE[origin]} coinciden con la enfermedad reportable **${disease.disease_label}**.`,
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
    `- Jurisdicción: ${[locality, province].filter(Boolean).join(", ") || "no especificada"}`,
  );
  // A matcher signal is a suspicion from free text; a vet's diagnosis is not.
  if (origin !== "vet") {
    bodyLines.push(
      `- Match strength: ${disease.high_count} high · ${disease.medium_count} medium`,
      "",
      "_No es diagnóstico. Considerá el contexto: cuántos signals similares en la jurisdicción / período._",
    );
  }
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
