// /mis-mascotas/[publicToken]/viaje — the owner's trips abroad
// (viajes-fase-2, design D5 / task 5.3).
//
// Replaces the "Próximamente" placeholder of the 2026-07-19 honesty pass: the
// writers now exist (Phase 4), so the page is live.
//
// ONE LOADER. Everything shown comes from loadTravelView, the read
// `GET /api/v1/pets/{publicToken}/travel` serves to the native screen too, so
// web and phone show the same semáforo for the same trip.
//
// WHO: requireTitularAccess turns a caretaker away with the titular notice;
// the loader then applies the narrower travel rule (canAccessTravel — owner,
// co-owner, foster on the person path) and anyone else gets a 404, the same
// answer a pet they cannot see gives (design D8: a trip says when a household
// is away).
//
// What the page says never promises: the semáforo's labels live in
// lib/domain/travel-copy.ts, and every airline block reads "Verificá con tu
// aerolínea".

import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Icon } from "@/components/Icon";
import { NotTitularNotice } from "@/components/pet-profile/NotTitularNotice";
import { LnCallout } from "@/components/ui/DocElements";
import { LnEmptyState } from "@/components/ui/EmptyState";
import { LnSheetCard, LnSheetHeader, LnSheetWrap } from "@/components/ui/Sheet";
import { UrlTabs, UrlTabsContent } from "@/components/ui/UrlTabs";
import { TRAVEL_AIRLINE_NOTICE, TRAVEL_GROUP_LABELS } from "@/lib/domain/travel-copy";
import { requireTitularAccess } from "@/lib/infra/pet-access";
import type { TravelObligationGroup, TravelTrip } from "@/lib/projections/travel-compliance";
import { AIRLINES } from "@/lib/reference/airlines";
import { CORRIDORS } from "@/lib/reference/cross-border-corridors";
import { isoToArDateDisplay } from "@/lib/utils/date-input-ar";
import {
  type TravelView,
  loadTravelView,
  travelTripLabel as tripLabel,
  travelTripSummary as tripSummary,
} from "@/src/modules/pets/application/travel/load-travel-view";
import {
  cancelTripAction,
  confirmTripDocumentAction,
  recordCviAction,
  recordTripAction,
} from "@/src/modules/pets/travel-actions";

import { CancelTripButton } from "./CancelTripButton";
import { CviForm } from "./CviForm";
import { TravelExportButton } from "./TravelExportButton";
import { TravelObligationsPanel } from "./TravelObligationsPanel";
import { TravelSemaforo } from "./TravelSemaforo";
import { TripDocumentsChecklist } from "./TripDocumentsChecklist";
import { TripForm } from "./TripForm";

const GROUP_ORDER: TravelObligationGroup[] = ["destino", "aerolinea", "libreta"];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="text-md font-semibold text-[var(--color-ln-ink)]">{title}</h2>
      {children}
    </section>
  );
}

function TripReading({
  view,
  trip,
  publicToken,
  canRecord,
}: {
  view: TravelView;
  trip: TravelTrip;
  publicToken: string;
  canRecord: boolean;
}) {
  const compliance = view.compliance;
  return (
    <div className="flex flex-col gap-5">
      {compliance && (
        <TravelSemaforo
          semaforo={compliance.semaforo}
          corridors={compliance.corridorsShown}
          tripSummary={tripSummary(trip)}
        />
      )}
      {canRecord && (
        <CancelTripButton
          action={cancelTripAction.bind(null, publicToken)}
          tripEventId={trip.eventId}
          tripLabel={tripLabel(trip)}
          idempotencyKey={crypto.randomUUID()}
        />
      )}
      {compliance &&
        GROUP_ORDER.map((group) => {
          const obligations = compliance.obligations.filter((o) => o.group === group);
          if (group === "aerolinea" && !view.airline) return null;
          if (obligations.length === 0 && group !== "destino") return null;
          return (
            <Section key={group} title={TRAVEL_GROUP_LABELS[group]}>
              {group === "aerolinea" && view.airline && (
                <LnCallout tone="warn" title={`${TRAVEL_AIRLINE_NOTICE}: ${view.airline.name}`}>
                  Lo que sigue es la política que {view.airline.name} publica. Puede cambiar sin
                  aviso: confirmala antes de reservar.
                </LnCallout>
              )}
              <TravelObligationsPanel
                obligations={obligations}
                renderDocuments={
                  canRecord
                    ? (obligation) => (
                        <TripDocumentsChecklist
                          action={confirmTripDocumentAction.bind(null, publicToken)}
                          tripEventId={trip.eventId}
                          documents={obligation.documents ?? []}
                          idempotencyKeys={(obligation.documents ?? []).map(() =>
                            crypto.randomUUID(),
                          )}
                        />
                      )
                    : undefined
                }
              />
            </Section>
          );
        })}
    </div>
  );
}

export default async function ViajePage({
  params,
  searchParams,
}: {
  params: Promise<{ publicToken: string }>;
  searchParams: Promise<{ viaje?: string | string[] }>;
}) {
  const { publicToken } = await params;
  const { viaje } = await searchParams;

  const access = await requireTitularAccess(publicToken);
  if (!access.ok) {
    if (access.reason === "not-titular") {
      return (
        <NotTitularNotice
          petPublicToken={publicToken}
          what="Registrar un viaje"
          reason={access.error}
        />
      );
    }
    notFound();
  }
  const { pet } = access;

  const result = await loadTravelView({
    pet,
    viewer: { accessPath: access.accessPath, holderRole: access.holderRole },
    tripId: typeof viaje === "string" ? viaje : null,
  });
  if (!result.ok) notFound();
  const { view } = result;
  const trip = view.selectedTrip;

  // A deceased animal travels nowhere; the writers refuse it too.
  const canRecord = pet.status !== "deceased";

  const reading = trip ? (
    <TripReading view={view} trip={trip} publicToken={pet.publicToken} canRecord={canRecord} />
  ) : null;

  return (
    <LnSheetWrap>
      <LnSheetCard wide>
        <LnSheetHeader
          tone="azul"
          icon={<Icon name="ubicacion" decorative />}
          title={`Viaje de ${pet.name}`}
          subtitle="Lo que pide el destino, lo que publica la aerolínea y lo que dice la libreta"
        />
        <div className="flex flex-col gap-6 p-4.5">
          <Link
            href={`/mis-mascotas/${pet.publicToken}`}
            className="font-ln-mono text-sm tracking-[.04em] text-[var(--color-ln-azul)] underline underline-offset-2"
          >
            ← Volver a la credencial
          </Link>

          {!trip && (
            <LnEmptyState
              variant="dashed"
              title="Todavía no hay un viaje registrado"
              description={`Registrá el destino y la fecha para ver qué pide el país, qué publica la aerolínea y qué dice la libreta de ${pet.name}.`}
            />
          )}

          {trip && view.trips.length > 1 && (
            <UrlTabs
              paramKey="viaje"
              defaultValue={trip.eventId}
              aria-label="Viajes registrados"
              tabs={view.trips.map((t) => ({ value: t.eventId, label: tripLabel(t) }))}
            >
              <UrlTabsContent value={trip.eventId}>{reading}</UrlTabsContent>
            </UrlTabs>
          )}
          {trip && view.trips.length === 1 && reading}

          <Section title="Certificado Veterinario Internacional (CVI)">
            {view.cvis.length === 0 ? (
              <p className="text-sm text-[var(--color-ln-mute)]">
                Todavía no registraste un CVI. Lo emite SENASA antes del viaje.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {view.cvis.map((cvi) => (
                  <li key={cvi.eventId} className="text-sm">
                    <span className="font-ln-mono">{cvi.cviNumber}</span>: emitido el{" "}
                    {isoToArDateDisplay(cvi.issuedDate)}
                    {cvi.validUntil
                      ? `, válido hasta el ${isoToArDateDisplay(cvi.validUntil)}`
                      : ""}
                  </li>
                ))}
              </ul>
            )}
            {canRecord && (
              <details className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] p-3">
                <summary className="cursor-pointer text-sm font-semibold">Registrar un CVI</summary>
                <div className="pt-3">
                  <CviForm
                    action={recordCviAction.bind(null, pet.publicToken)}
                    initialIdempotencyKey={crypto.randomUUID()}
                  />
                </div>
              </details>
            )}
          </Section>

          {canRecord && (
            <Section title={trip ? "Otro viaje" : "Registrar un viaje"}>
              <details
                open={!trip}
                className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] p-3"
              >
                <summary className="cursor-pointer text-sm font-semibold">
                  Destino, fecha y aerolínea
                </summary>
                <div className="pt-3">
                  <TripForm
                    action={recordTripAction.bind(null, pet.publicToken)}
                    corridors={CORRIDORS.map((c) => ({ id: c.id, label: c.label }))}
                    airlines={AIRLINES.map((a) => ({ id: a.id, label: a.name }))}
                    initialIdempotencyKey={crypto.randomUUID()}
                  />
                </div>
              </details>
            </Section>
          )}

          {trip && (
            <Section title="Documentación para llevar">
              <TravelExportButton petPublicToken={pet.publicToken} tripEventId={trip.eventId} />
            </Section>
          )}
        </div>
      </LnSheetCard>
    </LnSheetWrap>
  );
}
