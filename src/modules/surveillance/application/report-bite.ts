// Use-case: report-bite (owner path).
//
// Migrated from app/actions/bite.ts::reportBiteAction.
// Auth (requireAlivePetAccess) handled by caller (actions.ts).
//
// Parity quirks:
//   - Uses insertIncidentEventIdempotent (owner path only — org-bite uses plain insert).
//   - biteNoop early return: when idempotency key hits, skip observation + notifications.
//   - rabiesVaccineValid computed pre-tx via repo.findLatestRabiesVaccineEvent.
//   - Authority fan-out is post-tx best-effort — callers must handle.
//   - AUDIT_LOG: NONE (bite actions never wrote audit_log — preserve absence).

import { validateEventPayload } from "@/lib/events/event-schemas";
import { AR_TIME_ZONE, speciesLabel } from "@/lib/utils/format";

import type { OpenedReason } from "@/src/modules/cases/domain/opened-reason";
import { computeObservationUntil, isRabiesVaccineValid } from "../domain/rabies-observation";
import type { SurveillanceRepository } from "../infrastructure/surveillance-repository";
import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReportBiteInput = {
  pet: {
    id: string;
    publicToken: string;
    name: string;
    species: string;
    status: string;
    rabiesObservationStatus: string | null;
    jurisdictionProvince: string | null;
    jurisdictionLocality: string | null;
  };
  user: { id: string };
  eventAuthorship: {
    authorRole: string;
    authorOrganizationId: string | null;
    authorVerified: boolean;
  };
  occurredAt: Date;
  victimKind: "human" | "animal" | "unknown";
  severity: "minor" | "moderate" | "severe";
  locationDescription: string | null;
  context: string | null;
  victimContactName: string | null;
  victimContactPhone: string | null;
  victimAgeEstimate: string | null;
  clientIdempotencyKey: string | null;
  eventJurisdictionProvince: string | null;
  eventJurisdictionLocality: string | null;
  /**
   * ar_localities id of the incident locality when it resolved against the
   * catalog (the web writers normalise with locality "soft"). Stamped on the
   * bite case as its structural locality attribution (cases.locality_id,
   * migration 0147) — only when the case routes to the INCIDENT locality; a
   * case that falls back to the pet's home gets no id from here. Optional so
   * a caller that resolves no id (the v1 events route) is unchanged.
   */
  eventLocalityId?: string | null;
  // panorama-event-points Slice 2: the incident coordinate (optional) captured by
  // the bite form's map pin, persisted COLUMNAR on the event so the mordeduras
  // near-zoom dot loader (loadBiteEvents) can plot it. Null when the reporter
  // dropped no pin → the bite is counted into the "sin ubicación exacta" residual,
  // never a faked centroid dot.
  locationLat: number | null;
  locationLng: number | null;
  locationSource: "gps" | "pin_manual" | "geocodificada" | null;
};

type Deps = {
  repo: Pick<
    SurveillanceRepository,
    | "findLatestRabiesVaccineEvent"
    | "insertIncidentEventIdempotent"
    | "insertObservationStarted"
    | "setObservationStatus"
    | "findGovtTargetsForJurisdiction"
    | "insertNotifications"
  >;
  openCase: (
    input: {
      kind: string;
      primarySubjectKind: string;
      primaryPetId: string;
      jurisdictionProvince: string | null;
      jurisdictionLocality: string | null;
      localityId?: string | null;
      openedByUserId: string;
      openedReason: OpenedReason;
    },
    tx: unknown,
  ) => Promise<{ id: string; publicCode: string }>;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
  findAuthoritiesForJurisdiction: (jurisdiction: {
    province: string;
    locality: string;
  }) => Promise<string[]>;
  /**
   * A1 — the per-jurisdiction `rabies_observation_window` business rule,
   * resolved against the INCIDENT jurisdiction at report time. The stored
   * `observation_until` is what the close cron later reads verbatim, so the
   * window is prospective by construction: already-open observations keep
   * their computed deadline.
   */
  resolveObservationWindow: (jurisdiction: {
    province: string | null;
    locality: string | null;
  }) => Promise<{ days: number }>;
};

/**
 * `eventId` and `wasDuplicate` were ADDED, not swapped in for what was here.
 *
 * `petToken` and `casePublicCode` are what the WEB reads — its action builds a
 * success URL out of both (`surveillance/actions.ts`), and the case code on that
 * receipt is the thing a reporter quotes later. Replacing either would have
 * broken a surface that is working.
 *
 * The two new ones exist because `POST /api/v1/pets/{token}/events` answers
 * `EventRecordedV1` for every kind, and it can only do that if the writer says
 * which asiento it wrote and whether this call is the one that wrote it. Both
 * are captured INSIDE the transaction, before the `biteNoop` early return —
 * that return is what skips the observation and the fan-out on a replay, and a
 * capture after it would answer `""` on exactly the call the key exists for.
 *
 * THE CASE CODE DOES NOT REACH THE APP, and that is a parity gap rather than an
 * oversight: `EventRecordedV1` has no field for it, `OwnerPetCasesSection`
 * carries only a COUNT, and no v1 read returns case codes at all. A receipt code
 * that lives only in one HTTP response is a code the person loses the moment
 * they navigate away — so it belongs in a READ, and that is its own work.
 */
export type ReportBiteResult = UseCaseResult<{
  petToken: string;
  casePublicCode: string;
  eventId: string;
  wasDuplicate: boolean;
}>;

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function reportBite(input: ReportBiteInput, deps: Deps): Promise<ReportBiteResult> {
  const { repo, openCase, transaction, findAuthoritiesForJurisdiction, resolveObservationWindow } =
    deps;
  const { pet, user, eventAuthorship, occurredAt } = input;

  // 1. Snapshot rabies-vaccine status at the moment of the bite (pre-tx).
  const latestVaccineEvent = await repo.findLatestRabiesVaccineEvent(pet.id);
  const rabiesVaccineValid = isRabiesVaccineValid(latestVaccineEvent, occurredAt);

  const now = new Date();
  // LEGAL-ROUTING fix: a bite must route to the INCIDENT jurisdiction (where
  // it happened), not the pet's home jurisdiction — a mordedura in Córdoba by
  // a pet registered in CABA is Córdoba's sanitary authority's problem, not
  // CABA's. LocationFields (l2, in BiteForm) captures the incident location
  // via map pin + reverse-geocoding into eventJurisdictionProvince/Locality;
  // fall back to the pet's home jurisdiction only when the reporter dropped
  // no pin. Mirrors reportBiteFromOrg's caseProvince/caseLocality pattern.
  const caseProvince = input.eventJurisdictionProvince ?? pet.jurisdictionProvince;
  const caseLocality = input.eventJurisdictionLocality ?? pet.jurisdictionLocality;
  // A1 — the statutory window comes from the rules engine (same jurisdiction
  // the case routes to), not a hardcoded constant the dashboard disagrees with.
  const rabiesWindow = await resolveObservationWindow({
    province: caseProvince,
    locality: caseLocality,
  });
  const observationUntil = computeObservationUntil(occurredAt, rabiesWindow.days);
  const pendingNotifications: NewNotification[] = [];
  // Case public code (CAS-XXXX-XXXX) — surfaced on the bite receipt so the
  // reporter can quote the incident later. Captured inside the tx.
  let casePublicCode = "";
  // The case UUID escapes the tx for the SAME reason: every notification this
  // use-case emits is anchored on it, and the anchor is what makes the dedupe
  // key stable across a retry. Without it the authority fan-out below (which
  // runs POST-tx, where `caseRow` is out of scope) could only key on the pet —
  // and two distinct bites on the same animal would collapse into one alert.
  let caseId = "";
  // Captured inside the transaction and before the noop return — see the result
  // type's header for why the order matters.
  let biteEventId = "";
  let biteWasDuplicate = false;

  try {
    await transaction(async (tx) => {
      // 2. Open bite_incident case (incident jurisdiction overrides pet jurisdiction).
      const caseRow = await openCase(
        {
          kind: "bite_incident",
          primarySubjectKind: "registered_pet",
          primaryPetId: pet.id,
          jurisdictionProvince: caseProvince,
          jurisdictionLocality: caseLocality,
          // The id names the INCIDENT locality, so it travels only when the
          // case routes there (no field-by-field fallback to the pet's home).
          localityId:
            input.eventJurisdictionLocality !== null ? (input.eventLocalityId ?? null) : null,
          openedByUserId: user.id,
          openedReason: {
            code: "bite_reported_owner",
            victimKind: input.victimKind,
            severity: input.severity,
          },
        },
        tx,
      );
      casePublicCode = caseRow.publicCode;
      caseId = caseRow.id;

      // 3. Insert incident_reported with idempotency key (owner path only).
      const incidentPayload = validateEventPayload("incident_reported", {
        incident_type: "bite_inflicted",
        severity: input.severity,
        injuries_summary: null,
        vet_involved: null,
        location_description: input.locationDescription,
        victim_kind: input.victimKind,
        victim_contact_name: input.victimContactName,
        victim_contact_phone: input.victimContactPhone,
        victim_pet_id: null,
        victim_age_estimate: input.victimAgeEstimate,
        context: input.context,
        rabies_vaccine_valid_at_incident: rabiesVaccineValid,
        reporter_role: "owner",
        jurisdiction_province: input.eventJurisdictionProvince,
        jurisdiction_locality: input.eventJurisdictionLocality,
        location_source: input.locationSource,
      });

      const { event: biteEvent, wasNoop: biteNoop } = await repo.insertIncidentEventIdempotent(
        {
          petId: pet.id,
          eventType: "incident_reported",
          occurredAt,
          recordedAt: now,
          recordedByUserId: user.id,
          ...eventAuthorship,
          payload: incidentPayload,
          caseId: caseRow.id,
          clientIdempotencyKey: input.clientIdempotencyKey,
          // panorama-event-points Slice 2: persist the incident point COLUMNAR (numeric
          // string), mirroring the sighting writer. Null-coord bites fall into the residual.
          locationLat: input.locationLat != null ? String(input.locationLat) : null,
          locationLng: input.locationLng != null ? String(input.locationLng) : null,
        } as Parameters<typeof repo.insertIncidentEventIdempotent>[0],
        tx as Parameters<typeof repo.insertIncidentEventIdempotent>[1],
      );

      biteEventId = biteEvent.id;
      biteWasDuplicate = biteNoop;

      // 4. Idempotency noop — exit early, no observation, no notifications.
      if (biteNoop) return;

      // 5. Insert rabies_observation_started.
      const observationPayload = validateEventPayload("rabies_observation_started", {
        bite_event_id: biteEvent.id,
        observation_until: observationUntil.toISOString(),
        // Record the window that was actually applied, not just its end date:
        // downstream copy quotes a day count and, until 2026-08-17, quoted the
        // national 10 at owners whose jurisdiction runs 14.
        observation_days: rabiesWindow.days,
        location: "in_situ",
        official_site_organization_id: null,
      });
      await repo.insertObservationStarted(
        {
          petId: pet.id,
          eventType: "rabies_observation_started",
          occurredAt: now,
          recordedAt: now,
          // WHO recorded it stays the triggering user — that is the audit fact.
          recordedByUserId: user.id,
          ...eventAuthorship,
          // But the AUTHOR of this asiento is the system, not the person who
          // reported the bite. Nobody declares a rabies observation: the law
          // opens it, this transaction writes it, and the reporter never chose
          // it. Inheriting `eventAuthorship` stamped it "CARGADO POR VOS" in the
          // owner's own libreta, next to the events they really did load
          // (master test CIU, N2-a) — in a ledger that advertises itself as
          // immutable and signed, authorship is precisely what has to be
          // believable. The "system" role already renders as "Registrado
          // automáticamente" (asiento-fields.ts); this writer just never
          // claimed it. Ordered AFTER the spread so it wins.
          authorRole: "system",
          authorOrganizationId: null,
          authorVerified: false,
          payload: observationPayload,
          caseId: caseRow.id,
        } as Parameters<typeof repo.insertObservationStarted>[0],
        tx as Parameters<typeof repo.insertObservationStarted>[1],
      );

      // 6. Update pet status to in_progress.
      await repo.setObservationStatus(
        pet.id,
        "in_progress",
        now,
        tx as Parameters<typeof repo.setObservationStatus>[3],
      );

      // 7. Queue owner notification.
      pendingNotifications.push({
        userId: user.id,
        notificationType: "rabies_observation_started_owner",
        severity: "warning",
        title: `Observación antirrábica iniciada — ${pet.name}`,
        body: `Por la mordedura del ${occurredAt.toLocaleDateString("es-AR", { timeZone: AR_TIME_ZONE })}, ${pet.name} entra en observación antirrábica de ${rabiesWindow.days} días. Cierre estimado: ${observationUntil.toLocaleDateString("es-AR", { timeZone: AR_TIME_ZONE })}. Si notás síntomas raros (salivación excesiva, agresividad inusual, parálisis), consultá al veterinario de inmediato.`,
        relatedPetId: pet.id,
        relatedCaseId: caseRow.id,
        ctaLabel: "Ver mascota",
        ctaUrl: `/mis-mascotas/${pet.publicToken}`,
      });
    });
  } catch (err) {
    console.error("reportBite tx failed:", err);
    return {
      ok: false,
      error: `No se pudo reportar la mordedura: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  // 8. Authority fan-out (best-effort — post-tx). Add to pendingNotifications.
  // Routes to the INCIDENT jurisdiction (caseProvince/caseLocality), not the
  // pet's home — see LEGAL-ROUTING fix note above.
  //
  // A null jurisdiction does NOT skip the resolver (2026-08-17). It used to:
  // `caseProvince && caseLocality ? … : []` meant the admin fallback — the whole
  // reason the resolver exists — never ran for an incident with no geocoded
  // jurisdiction, and a rabies observation opened with no authority aware of it.
  // Coercing null to "" lets the resolver find no govt and page the admins,
  // which is the same shape route-outbreak-signal-notifications already used.
  try {
    const authorityIds = await findAuthoritiesForJurisdiction({
      province: caseProvince ?? "",
      locality: caseLocality ?? "",
    });
    for (const authorityId of authorityIds) {
      pendingNotifications.push({
        userId: authorityId,
        notificationType: "bite_reported_authority",
        severity: input.severity === "severe" ? "urgent" : "warning",
        title: `Mordedura reportada — ${pet.name} (${speciesLabel(pet.species)})`,
        body: `Reportada por el dueño. Víctima: ${input.victimKind}. Severidad: ${input.severity}. Antirrábica vigente al momento: ${rabiesVaccineValid ? "sí" : "NO"}. Observación de ${rabiesWindow.days} días iniciada.`,
        relatedPetId: pet.id,
        // Anchored on the case, not only the pet: this is what the dedupe key
        // is derived from, and two separate bites on the same animal must
        // reach the authority as two alerts.
        relatedCaseId: caseId,
        // Authority recipient: surveillance hub (cannot open /mis-mascotas).
        ctaLabel: "Ver vigilancia",
        ctaUrl: "/gob/vigilancia",
      });
    }
  } catch (err) {
    console.error("reportBite authority fan-out failed:", err);
  }

  return {
    ok: true,
    value: {
      petToken: pet.publicToken,
      casePublicCode,
      eventId: biteEventId,
      wasDuplicate: biteWasDuplicate,
    },
    notifications: pendingNotifications,
  };
}
