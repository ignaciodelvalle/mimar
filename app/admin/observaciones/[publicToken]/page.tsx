import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { notFound } from "next/navigation";

import {
  OpBreach,
  OpCallout,
  OpCard,
  OpCardBody,
  OpCardHead,
  OpCrumbs,
} from "@/components/ui/dashboard";
import { db, ownerships, petEvents, pets, profiles } from "@/db";
import { jurisdictionScopeContains } from "@/lib/domain/jurisdiction-canonical";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { PET_OBSERVATION_SELECT } from "@/lib/infra/pet-projections";
import { formatDateShort, formatDateTimeNumericAr, speciesLabel } from "@/lib/utils/format";
import { logPiiReadSafely } from "@/src/modules/organizations/application/admin-proposals/log-pii-query";
import { professionalCloseRabiesObservationAction } from "@/src/modules/surveillance/actions";
import { diseaseCodeToEnoCode, getEnoDisease } from "@/src/modules/surveillance/domain/eno-catalog";
import { isObservationOpen } from "@/src/modules/surveillance/domain/rabies-observation";

import { CloseObservationForm } from "./CloseObservationForm";

export default async function ObservationDetailPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  const { profile, jurisdictions } = await requireAdminOrGovtOrRedirect();

  const [pet] = await db
    .select(PET_OBSERVATION_SELECT)
    .from(pets)
    .where(eq(pets.publicToken, publicToken))
    .limit(1);
  if (!pet) notFound();
  // OPEN, not just running: the close form must reach an observation whose
  // window expired without a professional closure — that is the only reason
  // this screen exists after 2026-08-17.
  if (!isObservationOpen(pet.rabiesObservationStatus)) {
    notFound();
  }

  // Govt scope check — admin sees universally. Subsumption-aware so a
  // whole-province operator (e.g. whole-CABA) opens an observation on a pet
  // geocoded to a barrio in that province. See jurisdictionScopeContains.
  if (profile.role === "govt") {
    const inScope = jurisdictionScopeContains(
      jurisdictions,
      pet.jurisdictionProvince,
      pet.jurisdictionLocality,
    );
    if (!inScope) notFound();
  }

  // Lote B3 — the observation detail exposes the pet + owner context; the
  // read leaves a pii_queried trail like every other authority PII surface.
  // Covers /gob/observaciones/[publicToken] too (that route re-exports this
  // page). Fail-soft.
  await logPiiReadSafely(profile.id, publicToken, 1, "observacion_detail");

  const [startedEvent] = await db
    .select({ id: petEvents.id, occurredAt: petEvents.occurredAt, payload: petEvents.payload })
    .from(petEvents)
    .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "rabies_observation_started")))
    .orderBy(desc(petEvents.occurredAt))
    .limit(1);

  const startedPayload = (startedEvent?.payload ?? {}) as Record<string, unknown>;
  const observationUntilRaw = startedPayload.observation_until as string | undefined;
  const observationUntil = observationUntilRaw ? new Date(observationUntilRaw) : null;

  // Symptom events emitted during the observation period that flagged rabies.
  // Same window (>= observation start) + disease filter (rabies_suspected) as
  // SurveillanceRepository.findEscalatingSymptom — the alarm must reflect the
  // canonical predicate that actually blocks/escalates the case, not any
  // symptom_observed event ever logged for the pet (H6: an unbounded,
  // disease-blind check painted years-old colds as escalating rabies cases).
  const escalatingSymptoms = startedEvent
    ? await db
        .select({ id: petEvents.id, occurredAt: petEvents.occurredAt, payload: petEvents.payload })
        .from(petEvents)
        .where(
          and(
            eq(petEvents.petId, pet.id),
            eq(petEvents.eventType, "symptom_observed"),
            gte(petEvents.occurredAt, startedEvent.occurredAt),
            sql`(${petEvents.payload}->'alerted_disease_codes') @> '"rabies_suspected"'::jsonb`,
          ),
        )
        .orderBy(desc(petEvents.occurredAt))
    : [];

  const [ownerRow] = await db
    .select({ displayName: profiles.displayName })
    .from(ownerships)
    .innerJoin(profiles, eq(profiles.id, ownerships.ownerUserId))
    .where(
      and(eq(ownerships.petId, pet.id), eq(ownerships.role, "owner"), isNull(ownerships.endedAt)),
    )
    .limit(1);

  const boundAction = professionalCloseRabiesObservationAction.bind(null, pet.publicToken);

  return (
    <div className="space-y-6">
      <OpCrumbs
        items={[{ label: "Observaciones", href: "/admin/observaciones" }, { label: pet.name }]}
      />

      <header className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
          {"Admin · Vigilancia · Cierre profesional"}
        </p>
        <h1 className="text-title font-semibold text-ln-op-ink">
          {"Cierre profesional — "}
          {pet.name}
        </h1>
        <p className="text-md text-ln-op-ink-2">
          {"Como "}
          {profile.role === "admin" ? "administrador" : "autoridad sanitaria"}
          {", podés cerrar con cualquier resultado."}
        </p>
      </header>

      {/* Pet data card */}
      <OpCard>
        <OpCardHead title="Datos de la mascota" />
        <OpCardBody>
          <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-ln-op-mute">Especie</dt>
              <dd className="text-md text-ln-op-ink">{speciesLabel(pet.species)}</dd>
            </div>
            <div>
              <dt className="text-sm text-ln-op-mute">{"Jurisdicción"}</dt>
              <dd className="text-md text-ln-op-ink">
                {pet.jurisdictionLocality ?? "—"}, {pet.jurisdictionProvince ?? "—"}
              </dd>
            </div>
            {ownerRow && (
              <div>
                <dt className="text-sm text-ln-op-mute">{"Dueño/a"}</dt>
                <dd className="text-md text-ln-op-ink">{ownerRow.displayName}</dd>
              </div>
            )}
            <div>
              <dt className="text-sm text-ln-op-mute">{"Token público"}</dt>
              <dd className="font-ln-mono text-sm text-ln-op-mute">{pet.publicToken}</dd>
            </div>
          </dl>
        </OpCardBody>
      </OpCard>

      {/* Active observation callout */}
      <OpCallout
        title="Observación activa"
        body={
          observationUntil
            ? `Cierre estimado: ${formatDateShort(observationUntil)}`
            : "Sin fecha de cierre."
        }
      />

      {/* Escalating symptoms */}
      {escalatingSymptoms.length > 0 && (
        <OpBreach
          title={`Síntomas registrados durante la observación (${escalatingSymptoms.length})`}
          detail={
            <ul className="mt-1 space-y-0.5">
              {escalatingSymptoms.map((s) => {
                const payload = s.payload as Record<string, unknown>;
                const alerted = ((payload.alerted_disease_codes as string[]) ?? []).map(
                  (code) => getEnoDisease(diseaseCodeToEnoCode(code))?.label ?? code,
                );
                const text = (payload.free_text as string) ?? "—";
                return (
                  <li key={s.id}>
                    {formatDateTimeNumericAr(s.occurredAt)}
                    {alerted.length > 0 && (
                      <span className="ml-2 text-xs uppercase tracking-wider">
                        {alerted.join(", ")}
                      </span>
                    )}
                    {" — "}
                    {text}
                  </li>
                );
              })}
            </ul>
          }
        />
      )}

      {/* Closure form */}
      <OpCard>
        <OpCardHead title="Cerrar observación" />
        <OpCardBody>
          <CloseObservationForm action={boundAction} />
        </OpCardBody>
      </OpCard>
    </div>
  );
}
