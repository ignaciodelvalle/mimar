// /mis-mascotas/[publicToken]/viaje — the owner's trips abroad
// (viajes-fase-2, design D5 / task 5.3; v14 "Viaje en pasos", design part 2).
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
// v14 LAYOUT. Two tasks that used to share one long scroll are apart: SEEING a
// trip (the pase with its countdown and semáforo, three quick actions, then
// native <details> modules — "Lo que falta", "Para llevar", "Ya está",
// "Papeles" — of which only the first with work in it opens) and PLANNING one
// (the chained form, folded at the end). On a wide screen the quick actions
// and Papeles take a second column; on a narrow one everything stacks in the
// app's order. No module needs JavaScript to open, and the query string can
// open one (`?abrir=llevar`, `?abrir=papeles`), which is how the "Cargar el
// CZI" and "Ver los papeles" links land on the right one.
//
// What the page says never promises: the semáforo's labels live in
// lib/domain/travel-copy.ts, the airline notice shows only when the trip names
// an airline, and the disclaimer shows once.

import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Icon } from "@/components/Icon";
import { NotTitularNotice } from "@/components/pet-profile/NotTitularNotice";
import { LnBadge } from "@/components/ui/Badge";
import { LnButton } from "@/components/ui/Button";
import { LnSheetCard, LnSheetHeader, LnSheetWrap } from "@/components/ui/Sheet";
import { TRAVEL_AIRLINE_NOTICE } from "@/lib/domain/travel-copy";
import { requireTitularAccess } from "@/lib/infra/pet-access";
import type { TravelObligation, TravelTrip } from "@/lib/projections/travel-compliance";
import { TRAVEL_DISCLAIMER } from "@/lib/reference/cross-border-corridors";
import { isoToArDateDisplay } from "@/lib/utils/date-input-ar";
import { isoDateInAr } from "@/lib/utils/format";
import {
  type TravelView,
  loadTravelView,
  travelTripLabel as tripLabel,
} from "@/src/modules/pets/application/travel/load-travel-view";
import { travelFormOptions } from "@/src/modules/pets/application/travel/travel-options";
import {
  cancelTripAction,
  confirmTripDocumentAction,
  recordCviAction,
  recordTripAction,
} from "@/src/modules/pets/travel-actions";
import {
  PET_TRAVEL_ACTION_LABELS,
  type PetTravelCorridorOptionV1,
  petTravelObligationAction,
  petTravelRecordPaperLabel,
} from "@dim/contract/api";

import { CancelTripButton } from "./CancelTripButton";
import { CviForm } from "./CviForm";
import { TravelExportButton } from "./TravelExportButton";
import { TravelObligationsPanel } from "./TravelObligationsPanel";
import { TravelSemaforo } from "./TravelSemaforo";
import { TravelShareToVet } from "./TravelShareToVet";
import { TripDocumentsChecklist } from "./TripDocumentsChecklist";
import { TripForm, isShortcutCorridor } from "./TripForm";
import {
  countdownLabel,
  isPastTrip,
  moduleToOpen,
  papersTally,
  partitionObligations,
  semaforoTally,
  tripMetaLine,
} from "./trip-screen";

type PageContext = {
  publicToken: string;
  petName: string;
  /** The pet can still write (not deceased). */
  canRecord: boolean;
  corridors: PetTravelCorridorOptionV1[];
  todayIso: string;
};

/** One collapsible module: a native <details> with a summary that says its state. */
function Module({
  id,
  title,
  note,
  badge,
  open,
  children,
}: {
  id: string;
  title: string;
  note?: string | null;
  badge?: ReactNode;
  open: boolean;
  children: ReactNode;
}) {
  return (
    <details
      id={id}
      open={open}
      className="group rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)]"
    >
      <summary className="flex min-h-14 cursor-pointer list-none items-center gap-2.5 px-3.5 py-2 [&::-webkit-details-marker]:hidden">
        <span className="flex flex-1 flex-col">
          <span className="text-md font-semibold">{title}</span>
          {note && <span className="text-sm text-[var(--color-ln-mute)]">{note}</span>}
        </span>
        {badge}
        <Icon
          name="chevron-down"
          size="sm"
          decorative
          className="text-[var(--color-ln-mute)] transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="border-t border-[var(--color-ln-line-2)]">{children}</div>
    </details>
  );
}

/** The one-tap action of a requirement (the contract's rule → action table). */
function ObligationAction({
  obligation,
  ctx,
  trip,
  paperShortName,
  canWrite,
}: {
  obligation: TravelObligation;
  ctx: PageContext;
  trip: TravelTrip;
  paperShortName: string;
  canWrite: boolean;
}) {
  if (!canWrite) return null;
  const kind = petTravelObligationAction(obligation);
  const base = `/mis-mascotas/${ctx.publicToken}/viaje?viaje=${encodeURIComponent(trip.eventId)}`;
  switch (kind) {
    case "record_paper":
      return (
        <LnButton href={`${base}&abrir=papeles#papeles`} variant="ghost" size="sm">
          {petTravelRecordPaperLabel(paperShortName)}
        </LnButton>
      );
    case "confirm_papers":
      return (
        <LnButton href={`${base}&abrir=llevar#para-llevar`} variant="ghost" size="sm">
          {PET_TRAVEL_ACTION_LABELS.confirm_papers}
        </LnButton>
      );
    case "record_weight":
      return (
        <LnButton
          href={`/mis-mascotas/${ctx.publicToken}/eventos/nuevo/peso`}
          variant="ghost"
          size="sm"
        >
          {PET_TRAVEL_ACTION_LABELS.record_weight}
        </LnButton>
      );
    case "ask_vet":
    case "send_to_vet":
      return (
        <TravelShareToVet
          petPublicToken={ctx.publicToken}
          tripEventId={trip.eventId}
          petName={ctx.petName}
          tripLabel={tripLabel(trip)}
          label={PET_TRAVEL_ACTION_LABELS[kind]}
        />
      );
    default:
      return null;
  }
}

/** "Viaje 1 de 3 · Ver los otros": a line and a list, not a row of tabs. */
function TripSwitcher({
  view,
  trip,
  publicToken,
}: {
  view: TravelView;
  trip: TravelTrip;
  publicToken: string;
}) {
  if (view.trips.length < 2) return null;
  const index = view.trips.findIndex((t) => t.eventId === trip.eventId);
  return (
    <details className="relative text-sm text-[var(--color-ln-ink-2)]">
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        Viaje {index + 1} de {view.trips.length} ·{" "}
        <span className="font-medium text-[var(--color-ln-azul)] underline underline-offset-2">
          Ver los otros
        </span>
      </summary>
      <ul
        aria-label="Viajes registrados"
        className="mt-2 flex flex-col gap-1 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-2"
      >
        {view.trips.map((t) => (
          <li key={t.eventId}>
            <Link
              href={`/mis-mascotas/${publicToken}/viaje?viaje=${encodeURIComponent(t.eventId)}`}
              aria-current={t.eventId === trip.eventId ? "page" : undefined}
              className="block min-h-10 rounded-[var(--radius-xs)] px-2 py-2 text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)] aria-[current=page]:font-semibold"
            >
              {tripLabel(t)}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The CVIs on record and the form to add one. */
function PapersModule({
  view,
  ctx,
  corridor,
  open,
  canWrite,
}: {
  view: TravelView;
  ctx: PageContext;
  corridor: PetTravelCorridorOptionV1 | null;
  open: boolean;
  canWrite: boolean;
}) {
  const paper = corridor?.paper ?? null;
  const latest = view.cvis[0] ?? null;
  const note = latest
    ? `Certificado ${latest.cviNumber}, emitido el ${isoToArDateDisplay(latest.issuedDate)}`
    : paper
      ? `Todavía no cargaste el ${paper.shortName}`
      : "Todavía no cargaste un certificado";
  return (
    <Module id="papeles" title="Papeles" note={note} open={open}>
      <div className="flex flex-col gap-3 px-3.5 py-3 text-sm">
        {corridor && paper && (
          <p>
            <span className="font-semibold">{corridor.label} pide:</span> {paper.name}.
          </p>
        )}
        {view.cvis.length === 0 ? (
          <p className="text-[var(--color-ln-mute)]">
            Todavía no registraste un certificado. Lo emite SENASA antes del viaje.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5" aria-label="Certificados registrados">
            {view.cvis.map((cvi) => (
              <li key={cvi.eventId}>
                <span className="font-ln-mono">{cvi.cviNumber}</span>: emitido el{" "}
                {isoToArDateDisplay(cvi.issuedDate)}
                {cvi.validUntil ? `, válido hasta el ${isoToArDateDisplay(cvi.validUntil)}` : ""}
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <div className="flex flex-col gap-2 border-t border-[var(--color-ln-line-2)] pt-3">
            <p className="font-semibold">
              {paper ? petTravelRecordPaperLabel(paper.shortName) : "Cargar un certificado"}
            </p>
            <CviForm
              action={recordCviAction.bind(null, ctx.publicToken)}
              initialIdempotencyKey={crypto.randomUUID()}
            />
          </div>
        )}
        {view.selectedTrip && (
          <p className="text-[var(--color-ln-mute)]">
            PDF del viaje: el semáforo, cada requisito y sus fuentes.
          </p>
        )}
      </div>
    </Module>
  );
}

/** The trip form, folded at the end (open when there is no trip yet). */
function PlanTrip({
  ctx,
  open,
  initialCorridorId,
  label,
}: {
  ctx: PageContext;
  open: boolean;
  initialCorridorId: string;
  label: string;
}) {
  if (!ctx.canRecord) return null;
  return (
    <details
      id="nuevo-viaje"
      open={open}
      className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)]"
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-3.5 py-2 font-semibold text-[var(--color-ln-azul)] [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true">+</span>
        {label}
      </summary>
      <div className="border-t border-[var(--color-ln-line-2)] px-3.5 py-3">
        <TripForm
          action={recordTripAction.bind(null, ctx.publicToken)}
          {...travelFormOptions()}
          initialIdempotencyKey={crypto.randomUUID()}
          initialCorridorId={initialCorridorId}
          todayIso={ctx.todayIso}
        />
      </div>
    </details>
  );
}

function TripScreen({
  view,
  trip,
  ctx,
  opened,
  initialCorridorId,
}: {
  view: TravelView;
  trip: TravelTrip;
  ctx: PageContext;
  opened: string | null;
  initialCorridorId: string;
}) {
  const compliance = view.compliance;
  const corridor = ctx.corridors.find((c) => c.id === trip.corridorId) ?? null;
  const paperShortName = corridor?.paper?.shortName ?? "CVI";
  const past = isPastTrip(trip.travelDate, ctx.todayIso);
  // A trip already behind today is read-only: its modules inform, nothing writes.
  const canWrite = ctx.canRecord && !past;
  const modules = partitionObligations(compliance?.obligations ?? []);
  const autoOpen = moduleToOpen(modules);
  const open = (name: "falta" | "llevar" | "papeles") =>
    opened === name || (opened === null && autoOpen === name);
  const { done, total } = papersTally(modules.papers);
  const hasBlocker = modules.falta.some((o) => o.requirementLevel === "blocker");

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
      <div className="flex flex-col gap-2 lg:col-start-1 lg:row-start-1">
        {compliance && (
          <TravelSemaforo
            semaforo={compliance.semaforo}
            corridors={compliance.corridorsShown}
            pass={{
              destination: corridor?.label ?? trip.corridorId,
              countdown: countdownLabel(trip.travelDate, ctx.todayIso),
              meta: tripMetaLine(trip, view.airline?.name ?? null),
              tally: semaforoTally(modules),
              past,
            }}
            airlineNotice={view.airline ? `${TRAVEL_AIRLINE_NOTICE}: ${view.airline.name}` : null}
          />
        )}
      </div>

      <aside
        aria-label="Acciones del viaje"
        className="flex flex-col gap-2 lg:sticky lg:top-3 lg:col-start-2 lg:row-start-1"
      >
        <TravelExportButton petPublicToken={ctx.publicToken} tripEventId={trip.eventId} block />
        {canWrite && (
          <LnButton
            href={`/mis-mascotas/${ctx.publicToken}/viaje?viaje=${encodeURIComponent(trip.eventId)}&abrir=papeles#papeles`}
            variant="ghost"
            size="sm"
            block
          >
            {petTravelRecordPaperLabel(paperShortName)}
          </LnButton>
        )}
        <TravelShareToVet
          petPublicToken={ctx.publicToken}
          tripEventId={trip.eventId}
          petName={ctx.petName}
          tripLabel={tripLabel(trip)}
          label="Mandar a mi veterinaria"
          block
        />
      </aside>

      <div className="flex flex-col gap-3 lg:col-start-1 lg:row-start-2">
        <Module
          id="lo-que-falta"
          title="Lo que falta"
          note={modules.falta.length === 0 ? "Nada pendiente detectado" : null}
          badge={
            <LnBadge
              variant={modules.falta.length === 0 ? "success" : hasBlocker ? "danger" : "warning"}
            >
              {modules.falta.length}
            </LnBadge>
          }
          open={open("falta")}
        >
          <TravelObligationsPanel
            obligations={modules.falta}
            showDocuments={false}
            emptyText="No detectamos nada pendiente para este viaje."
            renderAction={(o) => (
              <ObligationAction
                obligation={o}
                ctx={ctx}
                trip={trip}
                paperShortName={paperShortName}
                canWrite={canWrite}
              />
            )}
          />
        </Module>

        {modules.papers && total > 0 && (
          <Module
            id="para-llevar"
            title="Para llevar"
            note={
              done === total ? "Confirmaste cada papel" : `Faltan ${total - done} por confirmar`
            }
            badge={<LnBadge variant="neutral">{`${done} de ${total}`}</LnBadge>}
            open={open("llevar")}
          >
            {canWrite ? (
              <TripDocumentsChecklist
                action={confirmTripDocumentAction.bind(null, ctx.publicToken)}
                tripEventId={trip.eventId}
                documents={modules.papers.documents ?? []}
                idempotencyKeys={(modules.papers.documents ?? []).map(() => crypto.randomUUID())}
              />
            ) : (
              <TravelObligationsPanel obligations={[modules.papers]} />
            )}
          </Module>
        )}

        <Module
          id="ya-esta"
          title="Ya está"
          badge={<LnBadge variant="success">{modules.yaEsta.length}</LnBadge>}
          open={false}
        >
          <TravelObligationsPanel
            obligations={modules.yaEsta}
            emptyText="Todavía no hay requisitos resueltos."
          />
        </Module>
      </div>

      <div className="lg:col-start-2 lg:row-start-2">
        <PapersModule
          view={view}
          ctx={ctx}
          corridor={corridor}
          open={open("papeles")}
          canWrite={canWrite}
        />
      </div>

      <div className="flex flex-col gap-3 lg:col-start-1 lg:row-start-3">
        <PlanTrip
          ctx={ctx}
          open={initialCorridorId !== ""}
          initialCorridorId={initialCorridorId}
          label="Planear otro viaje"
        />
        {canWrite && (
          <div>
            <CancelTripButton
              action={cancelTripAction.bind(null, ctx.publicToken)}
              tripEventId={trip.eventId}
              tripLabel={tripLabel(trip)}
              idempotencyKey={crypto.randomUUID()}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/** No trip yet: the call to plan one, the five destinations, and Papeles. */
function EmptyTrips({
  view,
  ctx,
  opened,
  initialCorridorId,
}: {
  view: TravelView;
  ctx: PageContext;
  opened: string | null;
  initialCorridorId: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border-[1.5px] border-dashed border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-4 py-4">
        <h2 className="text-lg font-semibold">
          Planeá un viaje y te mostramos qué le falta a {ctx.petName}
        </h2>
        <p className="text-sm text-[var(--color-ln-ink-2)]">
          Comparamos su libreta con lo que pide el destino y lo que publica la aerolínea.
        </p>
      </div>

      {ctx.canRecord && (
        <nav aria-label="Empezá por el destino" className="flex flex-col gap-2">
          <p className="font-ln-mono text-xs uppercase tracking-[.1em] text-[var(--color-ln-ink-2)]">
            O empezá por el destino
          </p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {ctx.corridors.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/mis-mascotas/${ctx.publicToken}/viaje?destino=${c.id}#nuevo-viaje`}
                  className="flex min-h-14 items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-3.5 py-2.5 text-[var(--color-ln-ink)] no-underline hover:border-[var(--color-ln-azul)]"
                >
                  <span className="font-medium">{c.label}</span>
                  <Icon name="chevron-right" size="sm" decorative />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}

      <PlanTrip ctx={ctx} open initialCorridorId={initialCorridorId} label="Planear un viaje" />

      <PapersModule
        view={view}
        ctx={ctx}
        corridor={null}
        open={opened === "papeles"}
        canWrite={ctx.canRecord}
      />

      <p className="text-xs text-[var(--color-ln-mute)]">{TRAVEL_DISCLAIMER}</p>
    </div>
  );
}

function firstParam(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

export default async function ViajePage({
  params,
  searchParams,
}: {
  params: Promise<{ publicToken: string }>;
  searchParams: Promise<{
    viaje?: string | string[];
    destino?: string | string[];
    abrir?: string | string[];
  }>;
}) {
  const { publicToken } = await params;
  const query = await searchParams;

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
    tripId: firstParam(query.viaje),
  });
  if (!result.ok) notFound();
  const { view } = result;
  const trip = view.selectedTrip;

  const destino = firstParam(query.destino);
  const ctx: PageContext = {
    publicToken: pet.publicToken,
    petName: pet.name,
    // A deceased animal travels nowhere; the writers refuse it too.
    canRecord: pet.status !== "deceased",
    corridors: travelFormOptions().corridors,
    todayIso: isoDateInAr(new Date()),
  };
  const initialCorridorId = isShortcutCorridor(destino) ? destino : "";
  const opened = firstParam(query.abrir);

  return (
    <LnSheetWrap>
      <LnSheetCard wide>
        <LnSheetHeader
          tone="azul"
          icon={<Icon name="ubicacion" decorative />}
          title={`Viaje de ${pet.name}`}
          subtitle="Lo que pide el destino, lo que publica la aerolínea y lo que dice la libreta"
        />
        <div className="flex flex-col gap-5 p-4.5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <Link
              href={`/mis-mascotas/${pet.publicToken}`}
              className="font-ln-mono text-sm tracking-[.04em] text-[var(--color-ln-azul)] underline underline-offset-2"
            >
              ← Volver a la credencial
            </Link>
            {trip && <TripSwitcher view={view} trip={trip} publicToken={pet.publicToken} />}
          </div>

          {trip ? (
            <TripScreen
              view={view}
              trip={trip}
              ctx={ctx}
              opened={opened}
              initialCorridorId={initialCorridorId}
            />
          ) : (
            <EmptyTrips
              view={view}
              ctx={ctx}
              opened={opened}
              initialCorridorId={initialCorridorId}
            />
          )}
        </div>
      </LnSheetCard>
    </LnSheetWrap>
  );
}
