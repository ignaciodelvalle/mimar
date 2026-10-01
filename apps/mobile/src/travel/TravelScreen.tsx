// VIAJE — the owner's trips, the semáforo, and the trip and CVI forms
// (viajes-fase-2, task 6.2).
//
// THE WHOLE OWNER FLOW, IN THE APP. The web's /viaje page registers a trip,
// records a CVI, cancels a trip and reads the semáforo; every one of those is
// here, through `GET|POST /pets/{token}/travel`, which reach the SAME loader and
// the SAME use-cases the web page reaches. Nothing on this screen sends anybody
// to a browser.
//
// THE SEMÁFORO IS DRAWN AS IT COMES. Colour, label, obligations and their
// freshness are the server's; this screen arranges them (see the view-model's
// header for why it never derives a verdict). The disclaimers travel with every
// reading and are drawn with every reading.
//
// ONE KEY PER ATTEMPT, three kinds of attempt. The trip form and the CVI form
// each hold an attempt session (`pets/idempotency.ts`): the key is minted on the
// first submit and reused on every retry of that same submit, so a retry that
// lost its response answers `replayed: true` instead of appending a second trip.
// A landed write restarts it — the next trip is a different trip. Cancels hold
// one session PER TRIP, so a cancel of trip B can never reuse the key of an
// earlier cancel of trip A that may have landed unheard.
//
// THE READ IS RE-DONE AFTER EVERY WRITE, NOT PATCHED — the semáforo of a new
// trip, or of a trip after a new CVI, is the server's to compute. And a re-read
// that fails keeps what is on screen (`ui/reload-state.ts`): the ack is true
// whether or not the refresh behind it lands.
//
// WHO MAY PLAN A TRIP IS NOT DECIDED HERE. The face offers the row to owner,
// co-owner and foster; the server's `canAccessTravel` is the rule, and a
// refusal arrives as its sentence. `capabilities.canRecord` (false for a
// deceased animal) is the one lever the payload hands over, and the forms and
// the cancel follow it.

import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, View } from "react-native";

import type { PetTravelObligationV1, PetTravelTripV1, PetTravelV1 } from "@dim/contract/api";
import type { PetTravelCommandInput } from "@dim/contract/input";

import { apiFailureMessage } from "../api/client";
import { fetchPetTravel, sendPetTravelCommand } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { type AttemptSession, createAttemptSession } from "../pets/idempotency";
import { Body, Card, Loading, Row, StaleNotice } from "../ui/components";
import {
  Callout,
  Choice,
  DateField,
  LinkText,
  PrimaryButton,
  Screen,
  SecondaryButton,
  TextField,
  Title,
} from "../ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../ui/reload-state";
import { useDraftDiscardGuard } from "../ui/use-draft-discard-guard";
import { useScrollToError } from "../ui/use-scroll-to-error";

import { shareTravelExport } from "./travel-export-share";
import {
  type CviDraft,
  EMPTY_CVI_DRAFT,
  EMPTY_TRIP_DRAFT,
  MODALITY_LABELS,
  MODE_LABELS,
  NO_CVI_LINE,
  NO_OBLIGATIONS_LINE,
  NO_TRIP_TITLE,
  type ObligationSection,
  type TravelModality,
  type TravelMode,
  type TripDraft,
  airlineNoticeBody,
  buildCancelTrip,
  buildCvi,
  buildTrip,
  cancelQuestion,
  contributorsLine,
  cviIssuedBounds,
  cviLine,
  noTripLine,
  obligationSections,
  requirementLevelLabel,
  selectedTrip,
  semaforoTone,
  sourceLine,
  travelAckMessage,
  travelDateBounds,
  tripLabel,
  tripSummary,
} from "./travel-view-model";

const FAILED = "No pudimos leer el viaje.";
const WRITE_FAILED = "No pudimos guardar el cambio.";

const EXPORT_BUTTON_LABEL = "Exportar PDF";
const EXPORT_CARD_BODY =
  "Un PDF con este viaje, el semáforo y lo que pide cada requisito, con sus fuentes. Guardalo o mandalo por WhatsApp.";
/** After the share sheet closes. It cannot know whether something was sent. */
const EXPORT_SHEET_CLOSED =
  "Si cerraste sin elegir una app, podés volver a exportarlo cuando quieras.";

/** One sentence per failure arm; none of them quotes the server. */
type ScreenState =
  | { phase: "loading" }
  | ReadyState<PetTravelV1>
  | { phase: "failed"; message: string };

type Notice = { tone: "ok" | "err"; message: string } | null;

type Busy = { what: "trip" } | { what: "cvi" } | { what: "cancel"; tripEventId: string } | null;

/** The picker's "not chosen" option. `Choice` takes strings; `""` is none. */
const NONE = "";

const MODE_OPTIONS = ["", "air", "land", "sea"] as const;
const MODALITY_OPTIONS = ["", "cabin", "hold", "cargo"] as const;

export function TravelScreen({ publicToken }: { publicToken: string }) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [tripDraft, setTripDraft] = useState<TripDraft>(EMPTY_TRIP_DRAFT);
  const [cviDraft, setCviDraft] = useState<CviDraft>(EMPTY_CVI_DRAFT);
  /** The trip form is open by default only while there is no trip — the web's `<details open={!trip}>`. */
  const [tripFormOpen, setTripFormOpen] = useState(false);
  const [cviFormOpen, setCviFormOpen] = useState(false);
  /** The trip whose cancel is waiting for its second tap. */
  const [confirmingCancel, setConfirmingCancel] = useState<string | null>(null);
  const { anchorRef: errorAnchor, scrollRef } = useScrollToError(
    notice !== null && notice.tone === "err" ? notice.message : null,
  );
  // THE BACK GESTURE MAY NOT DISCARD A TYPED TRIP OR CVI. Both drafts go back
  // to their EMPTY constants after a landed write, so the guard lifts itself.
  useDraftDiscardGuard(tripDraft !== EMPTY_TRIP_DRAFT || cviDraft !== EMPTY_CVI_DRAFT);

  // ONE KEY PER ATTEMPT — see the header. `useRef`, so no re-render can mint
  // a different key mid-attempt.
  const tripAttempt = useRef(createAttemptSession());
  const cviAttempt = useRef(createAttemptSession());
  const cancelAttempts = useRef(new Map<string, AttemptSession>());

  // A stale response must not overwrite a newer one when a trip switch and a
  // write's re-read overlap — the counter every sibling screen keeps.
  const generation = useRef(0);
  /** The trip the owner asked to read; null lets the server pick the next one. */
  const requestedTrip = useRef<string | null>(null);

  const load = useCallback(
    async (mode: "initial" | "refresh"): Promise<boolean> => {
      const mine = ++generation.current;
      if (mode === "initial") setState({ phase: "loading" });
      const result = await fetchPetTravel(sessionPort, publicToken, requestedTrip.current);
      if (mine !== generation.current) return false;
      if (result.outcome === "ok") {
        setState(loaded(result.payload));
        return true;
      }
      setState((current) => reloadFailed(current, result, apiFailureMessage(result) ?? FAILED));
      return false;
    },
    [publicToken],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  const selectTrip = useCallback(
    (tripEventId: string) => {
      requestedTrip.current = tripEventId;
      setConfirmingCancel(null);
      void load("refresh");
    },
    [load],
  );

  /** Send one command; answers the ack, or null after saying why it failed. */
  const send = useCallback(
    async (input: PetTravelCommandInput, key: string, what: Busy) => {
      setNotice(null);
      setBusy(what);
      const result = await sendPetTravelCommand(sessionPort, publicToken, input, key);
      setBusy(null);
      if (result.outcome !== "ok") {
        setNotice({ tone: "err", message: apiFailureMessage(result) ?? WRITE_FAILED });
        return null;
      }
      setNotice({ tone: "ok", message: travelAckMessage(result.payload) });
      return result.payload;
    },
    [publicToken],
  );

  const recordTrip = useCallback(async () => {
    setNotice(null);
    // The CONTRACT's schema, locally first, so a missing field gets its own
    // sentence instead of a round trip answering `invalid_request`.
    const built = buildTrip(tripDraft);
    if (!built.ok) {
      setNotice({ tone: "err", message: built.message });
      return;
    }
    const ack = await send(built.input, tripAttempt.current.key(), { what: "trip" });
    if (ack === null || ack.command !== "record_trip") return;
    tripAttempt.current.restart();
    setTripDraft(EMPTY_TRIP_DRAFT);
    setTripFormOpen(false);
    // The trip just written is the one the owner wants to read next.
    requestedTrip.current = ack.eventId;
    await load("refresh");
  }, [tripDraft, send, load]);

  const recordCvi = useCallback(async () => {
    setNotice(null);
    const built = buildCvi(cviDraft);
    if (!built.ok) {
      setNotice({ tone: "err", message: built.message });
      return;
    }
    const ack = await send(built.input, cviAttempt.current.key(), { what: "cvi" });
    if (ack === null || ack.command !== "record_cvi") return;
    cviAttempt.current.restart();
    setCviDraft(EMPTY_CVI_DRAFT);
    setCviFormOpen(false);
    await load("refresh");
  }, [cviDraft, send, load]);

  const cancelTrip = useCallback(
    async (trip: PetTravelTripV1) => {
      const built = buildCancelTrip(trip.tripEventId);
      if (!built.ok) {
        setNotice({ tone: "err", message: built.message });
        return;
      }
      const sessions = cancelAttempts.current;
      let session = sessions.get(trip.tripEventId);
      if (session === undefined) {
        session = createAttemptSession();
        sessions.set(trip.tripEventId, session);
      }
      const ack = await send(built.input, session.key(), {
        what: "cancel",
        tripEventId: trip.tripEventId,
      });
      if (ack === null || ack.command !== "cancel_trip") return;
      session.restart();
      setConfirmingCancel(null);
      // The cancelled trip leaves the list; the server picks what to read next.
      if (requestedTrip.current === trip.tripEventId) requestedTrip.current = null;
      await load("refresh");
    },
    [send, load],
  );

  if (state.phase === "loading") {
    return (
      <Screen>
        <Title>Viaje</Title>
        <Loading label="Leyendo el viaje…" />
      </Screen>
    );
  }

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Viaje</Title>
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load("initial")} />
      </Screen>
    );
  }

  const view = state.view;
  const trip = selectedTrip(view.trips, view.selectedTripEventId);
  const canRecord = view.capabilities.canRecord;
  const now = new Date();
  const showTripForm = canRecord && (trip === null || tripFormOpen);

  return (
    // `keyboardAvoiding`: the CVI number and the dates are typed down a scroll.
    <Screen keyboardAvoiding scrollRef={scrollRef}>
      <Title>Viaje de {view.petName}</Title>
      <Body>Lo que pide el destino, lo que publica la aerolínea y lo que dice la libreta.</Body>

      {state.staleFailure !== null ? (
        <StaleNotice message={state.staleFailure} onRetry={() => void load("refresh")} />
      ) : null}

      {notice !== null && (
        <View ref={errorAnchor}>
          <Callout tone={notice.tone}>
            <Body>{notice.message}</Body>
          </Callout>
        </View>
      )}

      {trip === null ? (
        <Card title={NO_TRIP_TITLE}>
          <Body>{noTripLine(view.petName)}</Body>
        </Card>
      ) : null}

      {trip !== null ? (
        <TripReading
          view={view}
          trip={trip}
          busy={busy}
          confirmingCancel={confirmingCancel === trip.tripEventId}
          onSelectTrip={selectTrip}
          onAskCancel={() => setConfirmingCancel(trip.tripEventId)}
          onBackFromCancel={() => setConfirmingCancel(null)}
          onConfirmCancel={() => void cancelTrip(trip)}
        />
      ) : null}

      {view.disclaimers.map((line) => (
        <Body key={line}>{line}</Body>
      ))}

      <CviCard
        view={view}
        draft={cviDraft}
        onChange={setCviDraft}
        open={cviFormOpen}
        onOpen={() => setCviFormOpen(true)}
        now={now}
        busy={busy}
        onSubmit={() => void recordCvi()}
      />

      {canRecord ? (
        <Card title={trip === null ? "Registrar un viaje" : "Otro viaje"}>
          {showTripForm ? (
            <TripForm
              draft={tripDraft}
              onChange={setTripDraft}
              view={view}
              now={now}
              busy={busy?.what === "trip"}
              disabled={busy !== null}
              onSubmit={() => void recordTrip()}
            />
          ) : (
            <SecondaryButton
              label="Registrar otro viaje"
              disabled={busy !== null}
              onPress={() => setTripFormOpen(true)}
            />
          )}
        </Card>
      ) : null}

      {trip !== null ? (
        <ExportCard
          // Keyed by trip: a "PDF listo" line belongs to the trip it was made for.
          key={trip.tripEventId}
          publicToken={publicToken}
          petName={view.petName}
          tripEventId={trip.tripEventId}
          disabled={busy !== null}
        />
      ) : null}
    </Screen>
  );
}

type ExportState =
  | { phase: "idle" }
  | { phase: "working" }
  | { phase: "closed" }
  | { phase: "failed"; message: string };

/**
 * "Documentación para llevar" — the web's section of the same name: the travel
 * PDF of the trip on screen, into the share sheet (task 6.5). The server makes
 * the PDF (`travel-export-share.ts`); this card only reports how the attempt
 * went, and "closed" never says "enviado" — the sheet cannot tell.
 */
function ExportCard({
  publicToken,
  petName,
  tripEventId,
  disabled,
}: {
  publicToken: string;
  petName: string;
  tripEventId: string;
  disabled: boolean;
}) {
  const [state, setState] = useState<ExportState>({ phase: "idle" });
  const onExport = useCallback(async () => {
    setState({ phase: "working" });
    const result = await shareTravelExport(sessionPort, publicToken, petName, tripEventId);
    setState(
      result.kind === "closed" ? { phase: "closed" } : { phase: "failed", message: result.message },
    );
  }, [petName, publicToken, tripEventId]);

  return (
    <Card title="Documentación para llevar">
      <Body>{EXPORT_CARD_BODY}</Body>
      {state.phase === "failed" ? (
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
      ) : null}
      {state.phase === "closed" ? <Body>{EXPORT_SHEET_CLOSED}</Body> : null}
      <SecondaryButton
        label={state.phase === "working" ? "Armando el PDF…" : EXPORT_BUTTON_LABEL}
        disabled={disabled || state.phase === "working"}
        onPress={() => void onExport()}
      />
    </Card>
  );
}

/**
 * One trip's reading: the picker when there are several, the semáforo, the
 * cancel, and the three lists — all as the server computed them.
 */
function TripReading({
  view,
  trip,
  busy,
  confirmingCancel,
  onSelectTrip,
  onAskCancel,
  onBackFromCancel,
  onConfirmCancel,
}: {
  view: PetTravelV1;
  trip: PetTravelTripV1;
  busy: Busy;
  confirmingCancel: boolean;
  onSelectTrip: (tripEventId: string) => void;
  onAskCancel: () => void;
  onBackFromCancel: () => void;
  onConfirmCancel: () => void;
}) {
  const compliance = view.compliance;
  return (
    <>
      {view.trips.length > 1 ? (
        <Choice
          label="Viajes registrados"
          options={view.trips.map((t) => t.tripEventId)}
          selected={trip.tripEventId}
          optionLabel={(id) => {
            const t = view.trips.find((candidate) => candidate.tripEventId === id);
            return t === undefined ? id : tripLabel(t);
          }}
          onSelect={onSelectTrip}
          disabled={busy !== null}
        />
      ) : null}

      {compliance !== null ? (
        <Callout tone={semaforoTone(compliance.semaforo)} title={compliance.semaforoLabel}>
          <Body>{tripSummary(trip)}</Body>
        </Callout>
      ) : null}

      {view.capabilities.canRecord ? (
        <CancelControl
          trip={trip}
          confirming={confirmingCancel}
          busy={busy?.what === "cancel" && busy.tripEventId === trip.tripEventId}
          disabled={busy !== null}
          onAsk={onAskCancel}
          onBack={onBackFromCancel}
          onConfirm={onConfirmCancel}
        />
      ) : null}

      {compliance !== null
        ? obligationSections(compliance, trip).map((section) => (
            <ObligationGroupCard key={section.group} section={section} trip={trip} />
          ))
        : null}
    </>
  );
}

/** The CVIs on record, and the form that records one. */
function CviCard({
  view,
  draft,
  onChange,
  open,
  onOpen,
  now,
  busy,
  onSubmit,
}: {
  view: PetTravelV1;
  draft: CviDraft;
  onChange: (draft: CviDraft) => void;
  open: boolean;
  onOpen: () => void;
  now: Date;
  busy: Busy;
  onSubmit: () => void;
}) {
  const canRecord = view.capabilities.canRecord;
  return (
    <Card title="Certificado Veterinario Internacional (CVI)">
      {view.cvis.length === 0 ? (
        <Body>{NO_CVI_LINE}</Body>
      ) : (
        view.cvis.map((cvi) => (
          <Body key={cvi.eventId} selectable>
            {cviLine(cvi)}
          </Body>
        ))
      )}
      {canRecord && !open ? (
        <SecondaryButton label="Registrar un CVI" disabled={busy !== null} onPress={onOpen} />
      ) : null}
      {canRecord && open ? (
        <View style={{ gap: 12 }}>
          <TextField
            label="Número de CVI"
            required
            mono
            autoCapitalize="characters"
            autoCorrect={false}
            value={draft.cviNumber}
            onChangeText={(cviNumber) => onChange({ ...draft, cviNumber })}
          />
          <DateField
            label="Fecha de emisión"
            required
            {...cviIssuedBounds(now)}
            value={draft.issuedDate}
            onChangeText={(issuedDate) => onChange({ ...draft, issuedDate })}
          />
          <DateField
            label="Válido hasta (si figura en el certificado)"
            value={draft.validUntil}
            onChangeText={(validUntil) => onChange({ ...draft, validUntil })}
          />
          <PrimaryButton
            label={busy?.what === "cvi" ? "Registrando…" : "Registrar CVI"}
            disabled={busy !== null}
            onPress={onSubmit}
          />
        </View>
      ) : null}
    </Card>
  );
}

/** The web's two-step cancel: the first tap asks, the second confirms. */
function CancelControl({
  trip,
  confirming,
  busy,
  disabled,
  onAsk,
  onBack,
  onConfirm,
}: {
  trip: PetTravelTripV1;
  confirming: boolean;
  busy: boolean;
  disabled: boolean;
  onAsk: () => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  if (!confirming) {
    return <SecondaryButton label="Cancelar este viaje" disabled={disabled} onPress={onAsk} />;
  }
  return (
    <Callout>
      <View style={{ gap: 12 }}>
        <Body>{cancelQuestion(trip)}</Body>
        <PrimaryButton
          tone="seal"
          label={busy ? "Cancelando…" : "Confirmar cancelación"}
          disabled={disabled}
          onPress={onConfirm}
        />
        <SecondaryButton label="Volver" disabled={disabled} onPress={onBack} />
      </View>
    </Callout>
  );
}

/** One of the three lists: Destino, Aerolínea, Libreta. */
function ObligationGroupCard({
  section,
  trip,
}: {
  section: ObligationSection;
  trip: PetTravelTripV1;
}) {
  return (
    <Card title={section.title}>
      {section.airlineNotice !== null && trip.airlineName !== null ? (
        <Callout tone="warn" title={section.airlineNotice}>
          <Body>{airlineNoticeBody(trip.airlineName)}</Body>
        </Callout>
      ) : null}
      {section.obligations.length === 0 ? (
        <Body>{NO_OBLIGATIONS_LINE}</Body>
      ) : (
        section.obligations.map((obligation) => (
          <ObligationItem key={obligation.id} obligation={obligation} />
        ))
      )}
    </Card>
  );
}

function ObligationItem({ obligation }: { obligation: PetTravelObligationV1 }) {
  const contributors = contributorsLine(obligation);
  return (
    <View style={{ gap: 4, paddingVertical: 8 }}>
      <Row label={obligation.label} value={requirementLevelLabel(obligation.requirementLevel)} />
      <Body>{obligation.state}</Body>
      {obligation.detail ? <Body>{obligation.detail}</Body> : null}
      {obligation.freshnessNotice ? (
        // A degraded datum is never drawn as settled (spec travel-reference-
        // freshness): the notice is a warning box, not a grey footnote.
        <Callout tone="warn">
          <Body>{obligation.freshnessNotice}</Body>
        </Callout>
      ) : null}
      {contributors !== null ? <Body>{contributors}</Body> : null}
      {obligation.sources.map((source) => (
        <LinkText
          key={`${source.kind}:${source.sourceUrl}:${source.label}`}
          accessibilityHint="Abre la fuente publicada."
          onPress={() => void Linking.openURL(source.sourceUrl).catch(() => {})}
        >
          {sourceLine(source)}
        </LinkText>
      ))}
      <Body>{obligation.legalFootnote}</Body>
    </View>
  );
}

/** The record-trip form: destination, date, how, airline, where on board. */
function TripForm({
  draft,
  onChange,
  view,
  now,
  busy,
  disabled,
  onSubmit,
}: {
  draft: TripDraft;
  onChange: (draft: TripDraft) => void;
  view: PetTravelV1;
  now: Date;
  busy: boolean;
  disabled: boolean;
  onSubmit: () => void;
}) {
  const corridorLabel = (id: string) =>
    view.options.corridors.find((c) => c.id === id)?.label ?? id;
  const airlineName = (id: string) =>
    id === NONE
      ? "Sin aerolínea elegida"
      : (view.options.airlines.find((a) => a.id === id)?.name ?? id);
  return (
    <View style={{ gap: 12 }}>
      <Choice
        label="Destino"
        required
        options={view.options.corridors.map((c) => c.id)}
        selected={draft.corridorId === NONE ? null : draft.corridorId}
        optionLabel={corridorLabel}
        onSelect={(corridorId) => onChange({ ...draft, corridorId })}
        disabled={disabled}
      />
      <DateField
        label="Fecha de salida"
        required
        {...travelDateBounds(now)}
        value={draft.travelDate}
        onChangeText={(travelDate) => onChange({ ...draft, travelDate })}
      />
      <Choice
        label="Cómo viaja"
        options={MODE_OPTIONS}
        selected={draft.mode}
        optionLabel={(mode) => (mode === NONE ? "Sin indicar" : MODE_LABELS[mode as TravelMode])}
        onSelect={(mode) => onChange({ ...draft, mode })}
        disabled={disabled}
      />
      <Body>Si elegís una aerolínea, queda registrado como viaje en avión.</Body>
      <Choice
        label="Aerolínea"
        options={[NONE, ...view.options.airlines.map((a) => a.id)]}
        selected={draft.airlineId}
        optionLabel={airlineName}
        onSelect={(airlineId) => onChange({ ...draft, airlineId })}
        disabled={disabled}
      />
      <Choice
        label="Dónde viaja la mascota"
        options={MODALITY_OPTIONS}
        selected={draft.intendedModality}
        optionLabel={(m) => (m === NONE ? "Sin indicar" : MODALITY_LABELS[m as TravelModality])}
        onSelect={(intendedModality) => onChange({ ...draft, intendedModality })}
        disabled={disabled}
      />
      <Body>Cada aerolínea tiene reglas distintas para cabina, bodega y carga.</Body>
      <PrimaryButton
        label={busy ? "Registrando…" : "Registrar viaje"}
        disabled={disabled}
        onPress={onSubmit}
      />
    </View>
  );
}
