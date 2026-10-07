// VIAJE — the owner's trips, the semáforo, the trip wizard and the CVI form
// (viajes-fase-2, task 6.2; redesigned in modules, PO-approved 2026-10-07).
//
// TWO TASKS, NO LONGER MIXED. Planning a trip is a four-step wizard
// (`TripWizard`, one question per screen); following one is this screen: the
// "pase" (destination, countdown, the server's semáforo), three quick actions
// (the PDF one tap away instead of eleven screens down), and folding modules —
// "Lo que falta", "Para llevar", "Ya está", "Papeles". Every requirement keeps
// everything it said before (source, who asks, legal note), behind "Ver
// detalle", in place.
//
// THE WHOLE OWNER FLOW, IN THE APP. Registering a trip, recording a CVI,
// cancelling, ticking each paper and reading the semáforo all go through
// `GET|POST /pets/{token}/travel`, which reach the SAME loader and use-cases
// the web page reaches. Nothing on this screen sends anybody to a browser.
//
// THE SEMÁFORO IS DRAWN AS IT COMES. Colour, label, obligations, their level
// and their evidence are the server's; this screen arranges them (see the
// view-model's header for why it never derives a verdict). The disclaimers
// travel with every reading and are drawn once, under the pase.
//
// ONE KEY PER ATTEMPT, four kinds of attempt. The trip wizard and the CVI form
// each hold an attempt session (`pets/idempotency.ts`): the key is minted on the
// first submit and reused on every retry of that same submit, so a retry that
// lost its response answers `replayed: true` instead of appending a second trip.
// A landed write restarts it. Cancels hold one session PER TRIP, and a paper's
// tick one per (trip, paper, direction), so no write can ever replay another.
// While any write is in flight every tick is disabled, so two papers are never
// ticked at once (the server reads the current ticks, then appends the list).
//
// THE READ IS RE-DONE AFTER EVERY WRITE, NOT PATCHED, and a re-read that fails
// keeps what is on screen (`ui/reload-state.ts`).
//
// BACK, INSIDE THE WIZARD, IS ONE STEP BACK and keeps every answer. On its
// first step it closes the wizard; once a destination is chosen there, the
// discard guard asks before the screen is left (`useDraftDiscardGuard`).
//
// WHO MAY PLAN A TRIP IS NOT DECIDED HERE. `capabilities.canRecord` (false for
// a deceased animal) is the one lever the payload hands over: without it there
// is no wizard, no tick, no CVI form, no cancel — and no write quick action.

import { useNavigation, useRouter } from "expo-router";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Linking, Modal, Pressable, StyleSheet, Text, View } from "react-native";

import type {
  PetTravelCommandAckV1,
  PetTravelObligationV1,
  PetTravelTripV1,
  PetTravelV1,
} from "@dim/contract/api";
import type { PetTravelCommandInput } from "@dim/contract/input";

import { apiFailureMessage } from "../api/client";
import { fetchPetTravel, sendPetTravelCommand } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { type AttemptSession, createAttemptSession } from "../pets/idempotency";
import { DISCARD_COPY, confirmDiscard } from "../pets/use-discard-guard";
import { Body, Loading, StaleNotice } from "../ui/components";
import { FONTS } from "../ui/fonts";
import {
  Callout,
  CollapsibleModule,
  DateField,
  Eyebrow,
  LinkText,
  ListRow,
  PrimaryButton,
  Screen,
  SecondaryButton,
  TextField,
  Title,
} from "../ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../ui/reload-state";
import { recordEventRoute } from "../ui/routes";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TYPE } from "../ui/theme";
import { useDraftDiscardGuard } from "../ui/use-draft-discard-guard";
import { useScrollToError } from "../ui/use-scroll-to-error";

import { TripWizard } from "./TripWizard";
import { shareTravelExport } from "./travel-export-share";
import {
  FinePrint,
  GroupLabel,
  OptionRow,
  PaperCheckRow,
  QuickAction,
  SealLink,
  TripPase,
} from "./travel-ui";
import {
  type CviDraft,
  EMPTY_CVI_DRAFT,
  NO_CVI_LINE,
  NO_TRIP_LINE,
  type PaperGroup,
  type TripModuleId,
  buildCancelTrip,
  buildConfirmDocument,
  buildCvi,
  buildTrip,
  cancelQuestion,
  contributorsLine,
  cviIssuedBounds,
  cviLine,
  declaredSeal,
  documentStatusLine,
  initialOpenModule,
  noTripTitle,
  obligationActionLabel,
  paperKey,
  paperShortName,
  papersCountLabel,
  pendingCountLine,
  requirementLevelLabel,
  selectedTrip,
  sourceLine,
  splitObligations,
  travelAckMessage,
  travelDateBounds,
  tripLabel,
  tripMetaLine,
  tripPaper,
  vetShareMessage,
} from "./travel-view-model";
import {
  CORRIDOR_CODES,
  EMPTY_WIZARD_DRAFT,
  type WizardState,
  countdownLabel,
  daysUntil,
  previousStep,
  shortWeekday,
  startWizard,
  travelDateRangeMessage,
} from "./trip-wizard-model";

const FAILED = "No pudimos leer el viaje.";
const WRITE_FAILED = "No pudimos guardar el cambio.";

/** After the share sheet closes. It cannot know whether something was sent. */
const EXPORT_SHEET_CLOSED =
  "Si cerraste sin elegir una app, podés volver a exportarlo cuando quieras.";

/** One sentence per failure arm; none of them quotes the server. */
type ScreenState =
  | { phase: "loading" }
  | ReadyState<PetTravelV1>
  | { phase: "failed"; message: string };

type Notice = { tone: "ok" | "err"; message: string } | null;

type Busy =
  | { what: "trip" }
  | { what: "cvi" }
  | { what: "cancel"; tripEventId: string }
  | { what: "document"; label: string }
  | null;

/** How the last PDF share went, for the trip it was made for. */
type ShareState =
  | { phase: "idle" }
  | { phase: "working"; kind: "export" | "vet" }
  | { phase: "closed"; kind: "export" | "vet" }
  | { phase: "failed"; kind: "export" | "vet"; message: string };

type SendOutcome = { ok: true; ack: PetTravelCommandAckV1 } | { ok: false; message: string };

/** React Navigation's object, narrowed to the one event this screen listens to. */
type BackListenable = {
  addListener: (
    type: "beforeRemove",
    cb: (e: { preventDefault: () => void }) => void,
  ) => () => void;
};

export function TravelScreen({ publicToken }: { publicToken: string }) {
  const router = useRouter();
  const navigation = useNavigation() as unknown as BackListenable;
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [wizard, setWizard] = useState<WizardState | null>(null);
  const [wizardError, setWizardError] = useState<string | null>(null);
  const [cviDraft, setCviDraft] = useState<CviDraft>(EMPTY_CVI_DRAFT);
  const [cviFormOpen, setCviFormOpen] = useState(false);
  /** The trip whose cancel is waiting for its second tap. */
  const [confirmingCancel, setConfirmingCancel] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // ONE error on screen at a time, and the screen scrolls to it: the wizard's
  // under its date field, the reading's at the top (QA 2026-10-07, bug 6).
  const visibleError =
    wizard !== null
      ? wizardError
      : notice !== null && notice.tone === "err"
        ? notice.message
        : null;
  const { anchorRef: errorAnchor, scrollRef } = useScrollToError(visibleError);

  // THE BACK GESTURE MAY NOT DISCARD A CHOSEN TRIP OR A TYPED CVI — once there
  // is nothing a step back could return to. ONE HANDLER OWNS EACH GESTURE, never
  // two (a dialog AND a step back would be one gesture doing two things):
  //   · reading, no wizard      → the guard, while a CVI is typed;
  //   · wizard, first step, with
  //     a destination chosen    → the guard: leaving would lose the choice;
  //   · wizard, anywhere else   → the listener below: one step back, or closed
  //     from a clean first step. The CVI draft is not touched by either, so it
  //     needs no question there.
  const wizardAtStart = wizard !== null && previousStep(wizard) === null;
  const wizardDirty = wizard !== null && wizard.draft !== EMPTY_WIZARD_DRAFT;
  const wizardOwnsBack = wizard !== null && !(wizardAtStart && wizardDirty);
  useDraftDiscardGuard(
    wizard === null ? cviDraft !== EMPTY_CVI_DRAFT : wizardAtStart && wizardDirty,
  );

  useEffect(() => {
    if (!wizardOwnsBack) return undefined;
    return navigation.addListener("beforeRemove", (event) => {
      event.preventDefault();
      setWizardError(null);
      setWizard((current) => (current === null ? null : previousStep(current)));
    });
  }, [navigation, wizardOwnsBack]);

  // ONE KEY PER ATTEMPT — see the header. `useRef`, so no re-render can mint
  // a different key mid-attempt.
  const tripAttempt = useRef(createAttemptSession());
  const cviAttempt = useRef(createAttemptSession());
  const cancelAttempts = useRef(new Map<string, AttemptSession>());
  const documentAttempts = useRef(new Map<string, AttemptSession>());

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
      setSwitcherOpen(false);
      void load("refresh");
    },
    [load],
  );

  /** Send one command; the ack, or the sentence that says why it failed. */
  const send = useCallback(
    async (input: PetTravelCommandInput, key: string, what: Busy): Promise<SendOutcome> => {
      setBusy(what);
      const result = await sendPetTravelCommand(sessionPort, publicToken, input, key);
      setBusy(null);
      if (result.outcome !== "ok") {
        return { ok: false, message: apiFailureMessage(result) ?? WRITE_FAILED };
      }
      return { ok: true, ack: result.payload };
    },
    [publicToken],
  );

  /** A command from the reading: its answer goes to the notice at the top. */
  const sendFromReading = useCallback(
    async (input: PetTravelCommandInput, key: string, what: Busy) => {
      setNotice(null);
      const outcome = await send(input, key, what);
      if (!outcome.ok) {
        setNotice({ tone: "err", message: outcome.message });
        return null;
      }
      setNotice({ tone: "ok", message: travelAckMessage(outcome.ack) });
      return outcome.ack;
    },
    [send],
  );

  const openWizard = useCallback((corridorId: string | null) => {
    // A NEW TRIP IS A NEW ATTEMPT. A key left over from a create whose answer
    // was lost must not ride along on a different trip (a true duplicate is
    // still `trip_duplicate` on the server).
    tripAttempt.current.restart();
    setNotice(null);
    setWizardError(null);
    setConfirmingCancel(null);
    setWizard(startWizard(corridorId));
  }, []);

  /**
   * "Volver": one step back keeping every answer. From the first step it
   * closes the wizard — after ASKING when a destination was chosen there, the
   * same question the back gesture asks, since that answer would be lost.
   */
  const backInWizard = useCallback(() => {
    setWizardError(null);
    if (wizard === null) return;
    const previous = previousStep(wizard);
    if (previous !== null) {
      setWizard(previous);
      return;
    }
    if (wizard.draft === EMPTY_WIZARD_DRAFT) {
      setWizard(null);
      return;
    }
    confirmDiscard(DISCARD_COPY.form, () => setWizard(null));
  }, [wizard]);

  const createTrip = useCallback(async () => {
    if (wizard === null) return;
    setWizardError(null);
    // The CONTRACT's schema, locally first, then the window the server keeps
    // — each with its own sentence, under the field, before any round trip.
    const built = buildTrip(wizard.draft);
    if (!built.ok) {
      setWizardError(built.message);
      return;
    }
    if (built.input.command !== "record_trip") return;
    const outOfRange = travelDateRangeMessage(built.input.travelDate, travelDateBounds(new Date()));
    if (outOfRange !== null) {
      setWizardError(outOfRange);
      return;
    }
    const outcome = await send(built.input, tripAttempt.current.key(), { what: "trip" });
    if (!outcome.ok) {
      setWizardError(outcome.message);
      return;
    }
    const ack = outcome.ack;
    if (ack.command !== "record_trip") return;
    tripAttempt.current.restart();
    setWizard(null);
    setNotice({ tone: "ok", message: travelAckMessage(ack) });
    // The trip just written is the one the owner wants to read next.
    requestedTrip.current = ack.eventId;
    await load("refresh");
  }, [wizard, send, load]);

  const recordCvi = useCallback(async () => {
    setNotice(null);
    const built = buildCvi(cviDraft);
    if (!built.ok) {
      setNotice({ tone: "err", message: built.message });
      return;
    }
    const ack = await sendFromReading(built.input, cviAttempt.current.key(), { what: "cvi" });
    if (ack === null || ack.command !== "record_cvi") return;
    cviAttempt.current.restart();
    setCviDraft(EMPTY_CVI_DRAFT);
    setCviFormOpen(false);
    await load("refresh");
  }, [cviDraft, sendFromReading, load]);

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
      const ack = await sendFromReading(built.input, session.key(), {
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
    [sendFromReading, load],
  );

  const confirmDocument = useCallback(
    async (trip: PetTravelTripV1, label: string, confirmed: boolean) => {
      const built = buildConfirmDocument(trip.tripEventId, label, confirmed);
      if (!built.ok) {
        setNotice({ tone: "err", message: built.message });
        return;
      }
      const sessionKey = `${trip.tripEventId}\u0000${label}\u0000${confirmed}`;
      const sessions = documentAttempts.current;
      let session = sessions.get(sessionKey);
      if (session === undefined) {
        session = createAttemptSession();
        sessions.set(sessionKey, session);
      }
      const ack = await sendFromReading(built.input, session.key(), { what: "document", label });
      if (ack === null || ack.command !== "confirm_trip_document") return;
      session.restart();
      // The obligation's colour is the server's to recompute.
      await load("refresh");
    },
    [sendFromReading, load],
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
  const now = new Date();

  if (wizard !== null && view.capabilities.canRecord) {
    return (
      // `keyboardAvoiding`: the destination search and the date are typed.
      <Screen keyboardAvoiding scrollRef={scrollRef}>
        <TripWizard
          view={view}
          state={wizard}
          onChange={(next) => {
            setWizardError(null);
            setWizard(next);
          }}
          onBack={backInWizard}
          onSubmit={() => void createTrip()}
          now={now}
          busy={busy?.what === "trip"}
          error={wizardError}
          errorAnchor={errorAnchor}
        />
      </Screen>
    );
  }

  const trip = selectedTrip(view.trips, view.selectedTripEventId);
  const cviCard = (
    <PapersModuleBody
      view={view}
      trip={trip}
      draft={cviDraft}
      onChange={setCviDraft}
      open={cviFormOpen}
      onOpen={() => setCviFormOpen(true)}
      now={now}
      busy={busy}
      onSubmit={() => void recordCvi()}
    />
  );

  return (
    // `keyboardAvoiding`: the CVI number and its dates are typed down a scroll.
    <Screen keyboardAvoiding scrollRef={scrollRef}>
      {state.staleFailure !== null ? (
        <StaleNotice message={state.staleFailure} onRetry={() => void load("refresh")} />
      ) : null}

      {notice !== null && (
        <View ref={notice.tone === "err" ? errorAnchor : undefined}>
          <Callout tone={notice.tone}>
            <Body>{notice.message}</Body>
          </Callout>
        </View>
      )}

      {trip === null ? (
        <EmptyTravel view={view} onPlan={openWizard} papers={cviCard} />
      ) : (
        <TripReading
          // Keyed by trip: open modules, open details and the share line all
          // belong to the trip they were opened on.
          key={trip.tripEventId}
          view={view}
          trip={trip}
          now={now}
          busy={busy}
          publicToken={publicToken}
          confirmingCancel={confirmingCancel === trip.tripEventId}
          onOpenSwitcher={() => setSwitcherOpen(true)}
          onAskCancel={() => setConfirmingCancel(trip.tripEventId)}
          onBackFromCancel={() => setConfirmingCancel(null)}
          onConfirmCancel={() => void cancelTrip(trip)}
          onConfirmDocument={(label, confirmed) => void confirmDocument(trip, label, confirmed)}
          onPlanAnother={() => openWizard(null)}
          onLoadPaper={() => {
            setCviFormOpen(true);
          }}
          onRecordWeight={() => router.push(recordEventRoute(publicToken, { kind: "weight" }))}
          scrollToEnd={() => scrollRef.current?.scrollToEnd?.({ animated: true })}
          papers={cviCard}
        />
      )}

      {trip !== null && view.trips.length > 1 ? (
        <TripSwitcherSheet
          visible={switcherOpen}
          trips={view.trips}
          selected={trip.tripEventId}
          disabled={busy !== null}
          onSelect={selectTrip}
          onClose={() => setSwitcherOpen(false)}
        />
      ) : null}
    </Screen>
  );
}

/**
 * No trip yet: ONE call to action, at the top (it was under the CVI and the
 * notices), and the five destinations as shortcuts that open the wizard on its
 * second step.
 */
function EmptyTravel({
  view,
  onPlan,
  papers,
}: {
  view: PetTravelV1;
  onPlan: (corridorId: string | null) => void;
  papers: ReactNode;
}) {
  const [papersOpen, setPapersOpen] = useState(false);
  const canRecord = view.capabilities.canRecord;
  const latest = view.cvis[0];
  return (
    <>
      <Title>{`Viaje de ${view.petName}`}</Title>
      <View style={styles.emptyHero}>
        <Text style={styles.emptyTitle}>{noTripTitle(view.petName)}</Text>
        <Body>{NO_TRIP_LINE}</Body>
        {canRecord ? <PrimaryButton label="Planear un viaje" onPress={() => onPlan(null)} /> : null}
      </View>
      {canRecord ? (
        <>
          <GroupLabel>O empezá por el destino</GroupLabel>
          <View style={styles.options}>
            {view.options.corridors.map((c) => (
              <OptionRow
                key={c.id}
                code={(CORRIDOR_CODES as Record<string, string | undefined>)[c.id] ?? null}
                label={c.label}
                onPress={() => onPlan(c.id)}
              />
            ))}
          </View>
        </>
      ) : null}
      <CollapsibleModule
        title="Papeles"
        summary={latest === undefined ? NO_CVI_LINE : cviLine(latest)}
        open={papersOpen}
        onToggle={() => setPapersOpen((open) => !open)}
      >
        {papers}
      </CollapsibleModule>
      {view.disclaimers.map((line) => (
        <FinePrint key={line}>{line}</FinePrint>
      ))}
    </>
  );
}

/**
 * One trip: the pase, the disclaimer once, three quick actions, the modules,
 * then trip management — "Planear otro viaje" and the cancel, as a link.
 */
function TripReading({
  view,
  trip,
  now,
  busy,
  publicToken,
  confirmingCancel,
  onOpenSwitcher,
  onAskCancel,
  onBackFromCancel,
  onConfirmCancel,
  onConfirmDocument,
  onPlanAnother,
  onLoadPaper,
  onRecordWeight,
  scrollToEnd,
  papers,
}: {
  view: PetTravelV1;
  trip: PetTravelTripV1;
  now: Date;
  busy: Busy;
  publicToken: string;
  confirmingCancel: boolean;
  onOpenSwitcher: () => void;
  onAskCancel: () => void;
  onBackFromCancel: () => void;
  onConfirmCancel: () => void;
  onConfirmDocument: (label: string, confirmed: boolean) => void;
  onPlanAnother: () => void;
  onLoadPaper: () => void;
  onRecordWeight: () => void;
  scrollToEnd: () => void;
  papers: ReactNode;
}) {
  const compliance = view.compliance;
  const split = splitObligations(compliance);
  const paper = tripPaper(view.options.corridors, trip.corridorId);
  const canRecord = view.capabilities.canRecord;
  const days = daysUntil(trip.travelDate, now);
  const past = days !== null && days < 0;
  const position = view.trips.findIndex((t) => t.tripEventId === trip.tripEventId);

  // THE OPENING RULE — only the first module with work opens by itself. The
  // person's own taps win from then on, for this trip (the parent keys this
  // component by trip, so another trip starts from the rule again).
  const [opened, setOpened] = useState<Partial<Record<TripModuleId, boolean>>>(() => {
    const first = initialOpenModule(split);
    return first === null ? {} : { [first]: true };
  });
  const isOpen = (id: TripModuleId) => opened[id] === true;
  const toggle = (id: TripModuleId) => setOpened((now) => ({ ...now, [id]: !now[id] }));

  const [share, setShare] = useState<ShareState>({ phase: "idle" });
  const runShare = async (kind: "export" | "vet") => {
    setShare({ phase: "working", kind });
    const result = await shareTravelExport(
      sessionPort,
      publicToken,
      view.petName,
      trip.tripEventId,
      kind === "vet" ? `PDF del viaje de ${view.petName}, para tu veterinaria` : undefined,
    );
    setShare(
      result.kind === "closed"
        ? { phase: "closed", kind }
        : { phase: "failed", kind, message: result.message },
    );
  };

  const loadPaper = () => {
    onLoadPaper();
    setOpened((now) => ({ ...now, papeles: true }));
    scrollToEnd();
  };

  const onAction = (kind: string) => {
    switch (kind) {
      case "record_paper":
        loadPaper();
        return;
      case "ask_vet":
      case "send_to_vet":
        void runShare("vet");
        return;
      case "record_weight":
        onRecordWeight();
        return;
    }
  };

  const shortName = paperShortName(paper);
  const sharing = share.phase === "working";
  const pendingCount = split.pending.length;
  const unticked = split.papers.filter((p) => !p.document.confirmed);

  return (
    <>
      {view.trips.length > 1 ? (
        <View style={styles.switcher}>
          <Text
            style={styles.switcherLabel}
          >{`Viaje ${position + 1} de ${view.trips.length}`}</Text>
          <LinkText onPress={onOpenSwitcher} accessibilityHint="Abre la lista de viajes.">
            Ver los otros
          </LinkText>
        </View>
      ) : (
        <Eyebrow>{`Viaje de ${view.petName}`}</Eyebrow>
      )}

      <TripPase
        destination={trip.corridorLabel}
        countdown={countdownLabel(trip.travelDate, now)}
        meta={tripMetaLine(trip, shortWeekday(trip.travelDate))}
        semaforo={compliance?.semaforo ?? null}
        semaforoLabel={compliance?.semaforoLabel ?? null}
        countLine={pendingCountLine(split)}
        past={past}
      />

      {view.disclaimers.map((line) => (
        <FinePrint key={line}>{line}</FinePrint>
      ))}

      <View style={styles.quick}>
        <QuickAction
          label={share.phase === "working" && share.kind === "export" ? "Armando…" : "Exportar PDF"}
          disabled={busy !== null || sharing}
          onPress={() => void runShare("export")}
        />
        {canRecord && !past ? (
          <QuickAction
            label={`Cargar el ${shortName}`}
            disabled={busy !== null}
            onPress={loadPaper}
          />
        ) : null}
        <QuickAction
          label={
            share.phase === "working" && share.kind === "vet"
              ? "Armando…"
              : "Mandar a mi veterinaria"
          }
          disabled={busy !== null || sharing}
          onPress={() => void runShare("vet")}
        />
      </View>
      <ShareStatus share={share} message={vetShareMessage(view.petName, trip)} />

      <CollapsibleModule
        title="Lo que falta"
        summary={pendingCount === 0 ? "Nada pendiente detectado" : null}
        badge={String(pendingCount)}
        badgeTone={pendingCount === 0 ? "ok" : split.pending.some(isBlocker) ? "err" : "warn"}
        open={isOpen("falta")}
        onToggle={() => toggle("falta")}
      >
        {split.pending.map((obligation) => (
          <ObligationItem
            key={obligation.id}
            obligation={obligation}
            action={offeredAction(obligation, paper, canRecord)}
            onAction={onAction}
            disabled={busy !== null || sharing}
          />
        ))}
        {compliance === null ? (
          <View style={styles.inset}>
            <Body>Todavía no hay una lectura de este viaje.</Body>
          </View>
        ) : null}
      </CollapsibleModule>

      {split.papers.length > 0 ? (
        <CollapsibleModule
          title="Para llevar"
          summary={
            unticked.length === 0
              ? "Todos confirmados, según indicaste"
              : `Sin confirmar: ${unticked.map((p) => p.document.label).join(", ")}`
          }
          badge={papersCountLabel(split.papers)}
          open={isOpen("llevar")}
          onToggle={() => toggle("llevar")}
        >
          {split.paperGroups.map((group) => (
            <PaperGroupRows
              key={group.obligation.id}
              group={group}
              busy={busy}
              canRecord={canRecord}
              onConfirmDocument={onConfirmDocument}
            />
          ))}
        </CollapsibleModule>
      ) : null}

      <CollapsibleModule
        title="Ya está"
        badge={String(split.done.length)}
        badgeTone="ok"
        open={isOpen("listo")}
        onToggle={() => toggle("listo")}
      >
        {split.done.length === 0 ? (
          <View style={styles.inset}>
            <Body>Todavía nada está resuelto para este viaje.</Body>
          </View>
        ) : (
          split.done.map((obligation) => (
            <ObligationItem
              key={obligation.id}
              obligation={obligation}
              action={null}
              onAction={onAction}
              disabled={busy !== null}
            />
          ))
        )}
      </CollapsibleModule>

      <CollapsibleModule
        title="Papeles"
        summary={view.cvis[0] === undefined ? NO_CVI_LINE : cviLine(view.cvis[0])}
        open={isOpen("papeles")}
        onToggle={() => toggle("papeles")}
      >
        {papers}
      </CollapsibleModule>

      {canRecord ? (
        <OptionRow
          label="Planear otro viaje"
          variant="quiet"
          disabled={busy !== null}
          onPress={onPlanAnother}
        />
      ) : null}

      {canRecord ? (
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
    </>
  );
}

function isBlocker(obligation: PetTravelObligationV1): boolean {
  return obligation.requirementLevel === "blocker";
}

/**
 * The button a requirement offers HERE. The two that write something (load
 * the paper, record a weight) need `canRecord`; asking the vet is a share, a
 * read, and stays.
 */
function offeredAction(
  obligation: PetTravelObligationV1,
  paper: Parameters<typeof obligationActionLabel>[1],
  canRecord: boolean,
): { kind: string; label: string } | null {
  const action = obligationActionLabel(obligation, paper);
  if (action === null) return null;
  const writes = action.kind === "record_paper" || action.kind === "record_weight";
  return writes && !canRecord ? null : action;
}

/**
 * How the last share went. "Closed" never says "enviado" — the sheet cannot
 * tell. The vet share adds the suggested message, SELECTABLE so it can be
 * pasted: a file share cannot pre-fill the text on Android.
 */
function ShareStatus({ share, message }: { share: ShareState; message: string }) {
  if (share.phase === "failed") {
    return (
      <Callout tone="err">
        <Body>{share.message}</Body>
      </Callout>
    );
  }
  if (share.phase === "closed" && share.kind === "export")
    return <Body>{EXPORT_SHEET_CLOSED}</Body>;
  if (share.phase === "closed" && share.kind === "vet") {
    return (
      <Callout title="Mensaje sugerido para tu veterinaria">
        <Body selectable>{message}</Body>
        <Body>{EXPORT_SHEET_CLOSED}</Body>
      </Callout>
    );
  }
  return null;
}

/**
 * The papers one obligation lists, as boxes — and, around them, what that
 * obligation says about ITSELF: a stale or unverified source as a warning box
 * ABOVE the boxes (never folded away: a degraded datum is not drawn as
 * settled), and its sources and legal note behind "Ver detalle".
 */
function PaperGroupRows({
  group,
  busy,
  canRecord,
  onConfirmDocument,
}: {
  group: PaperGroup;
  busy: Busy;
  canRecord: boolean;
  onConfirmDocument: (label: string, confirmed: boolean) => void;
}) {
  const [detail, setDetail] = useState(false);
  const { obligation } = group;
  const contributors = contributorsLine(obligation);
  return (
    <View>
      {obligation.freshnessNotice ? (
        <View style={styles.inset}>
          <Callout tone="warn">
            <Body>{obligation.freshnessNotice}</Body>
          </Callout>
        </View>
      ) : null}
      {group.papers.map((paper) => (
        <PaperCheckRow
          key={paperKey(paper)}
          label={paper.document.label}
          status={documentStatusLine(paper.document)}
          checked={paper.document.confirmed}
          busy={busy?.what === "document" && busy.label === paper.document.label}
          disabled={busy !== null}
          onToggle={
            canRecord
              ? () => onConfirmDocument(paper.document.label, !paper.document.confirmed)
              : undefined
          }
        />
      ))}
      <View style={styles.paperFoot}>
        <LinkText onPress={() => setDetail((open) => !open)}>
          {detail ? "Ocultar detalle" : "Ver detalle"}
        </LinkText>
        {detail ? (
          <View style={styles.detail}>
            {obligation.detail ? <Body>{obligation.detail}</Body> : null}
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
        ) : null}
      </View>
    </View>
  );
}

/**
 * One requirement: WHAT, its state, its action — three lines (design pin 18).
 * Its own `Row`-free layout: the title wraps and the level never shrinks, so
 * neither breaks letter by letter (QA 2026-10-07, bug 2). The source, who asks
 * and the legal note stay, behind "Ver detalle", opened in place.
 */
function ObligationItem({
  obligation,
  action,
  onAction,
  disabled,
}: {
  obligation: PetTravelObligationV1;
  action: { kind: string; label: string } | null;
  onAction: (kind: string) => void;
  disabled: boolean;
}) {
  const [detail, setDetail] = useState(false);
  const seal = declaredSeal(obligation);
  const contributors = contributorsLine(obligation);
  const level = obligation.requirementLevel;
  return (
    <View style={styles.obligation}>
      <View style={styles.obligationHead}>
        <Text style={styles.obligationTitle}>{obligation.label}</Text>
        {level === "info" ? null : (
          <Text style={[styles.level, level === "blocker" ? styles.levelErr : styles.levelWarn]}>
            {requirementLevelLabel(level)}
          </Text>
        )}
      </View>
      {seal !== null ? (
        <View style={styles.seal}>
          <Text style={styles.sealLabel}>{seal}</Text>
        </View>
      ) : null}
      <Text style={styles.obligationState}>{obligation.state}</Text>
      {obligation.freshnessNotice ? (
        // A degraded datum is never drawn as settled (spec travel-reference-
        // freshness): the notice stays out of the fold, as a warning box.
        <Callout tone="warn">
          <Body>{obligation.freshnessNotice}</Body>
        </Callout>
      ) : null}
      <View style={styles.actions}>
        {action !== null ? (
          <View style={styles.actionButton}>
            <SecondaryButton
              label={action.label}
              disabled={disabled}
              onPress={() => onAction(action.kind)}
            />
          </View>
        ) : null}
        <LinkText onPress={() => setDetail((open) => !open)}>
          {detail ? "Ocultar detalle" : "Ver detalle"}
        </LinkText>
      </View>
      {detail ? (
        <View style={styles.detail}>
          {obligation.detail ? <Body>{obligation.detail}</Body> : null}
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
      ) : null}
    </View>
  );
}

/** "Papeles": the CVIs on record, the paper this trip asks for, the form. */
function PapersModuleBody({
  view,
  trip,
  draft,
  onChange,
  open,
  onOpen,
  now,
  busy,
  onSubmit,
}: {
  view: PetTravelV1;
  trip: PetTravelTripV1 | null;
  draft: CviDraft;
  onChange: (draft: CviDraft) => void;
  open: boolean;
  onOpen: () => void;
  now: Date;
  busy: Busy;
  onSubmit: () => void;
}) {
  const canRecord = view.capabilities.canRecord;
  const paper = trip === null ? null : tripPaper(view.options.corridors, trip.corridorId);
  return (
    <View style={styles.inset}>
      {paper !== null && trip !== null ? (
        <Body>{`${trip.corridorLabel} pide: ${paper.name}.`}</Body>
      ) : null}
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
        <SecondaryButton
          label={`Cargar el ${paperShortName(paper)}`}
          disabled={busy !== null}
          onPress={onOpen}
        />
      ) : null}
      {canRecord && open ? (
        <View style={styles.form}>
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
    </View>
  );
}

/** The two-step cancel, as a seal-red link at the end: the first tap asks. */
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
    return <SealLink label="Cancelar este viaje" disabled={disabled} onPress={onAsk} />;
  }
  return (
    <Callout>
      <View style={styles.form}>
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

/**
 * "Ver los otros": the trips in a bottom sheet, one row each, instead of a
 * chip per trip stacked over the semáforo (280dp with five trips).
 */
function TripSwitcherSheet({
  visible,
  trips,
  selected,
  disabled,
  onSelect,
  onClose,
}: {
  visible: boolean;
  trips: readonly PetTravelTripV1[];
  selected: string;
  disabled: boolean;
  onSelect: (tripEventId: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheetRoot}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cerrar la lista de viajes"
          style={styles.sheetScrim}
          onPress={onClose}
        />
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>Tus viajes</Text>
          {trips.map((t) => (
            <ListRow
              key={t.tripEventId}
              label={tripLabel(t)}
              caption={t.tripEventId === selected ? "Es el que estás viendo" : undefined}
              // A pick, not a destination: no chevron (ListRow's default since
              // 2026-10-07 is for rows that open another screen).
              trailing={null}
              onPress={
                disabled || t.tripEventId === selected ? undefined : () => onSelect(t.tripEventId)
              }
            />
          ))}
          <SecondaryButton label="Cerrar" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  options: { gap: SPACE.sm },
  paperFoot: {
    gap: SPACE.xs,
    paddingHorizontal: SPACE.md + 2,
    paddingBottom: SPACE.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.borderSoft,
    paddingTop: SPACE.sm,
  },
  form: { gap: SPACE.md },
  inset: { gap: SPACE.sm, paddingHorizontal: SPACE.md + 2, paddingVertical: SPACE.md },
  emptyHero: {
    gap: SPACE.sm + 2,
    paddingHorizontal: SPACE.lg,
    paddingVertical: SPACE.lg + 2,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: COLORS.borderStrong,
    borderRadius: RADIUS.control * 2,
    backgroundColor: COLORS.surface,
  },
  emptyTitle: {
    fontFamily: FONTS.sansSemibold,
    fontSize: TYPE.base,
    lineHeight: TYPE.base * LEADING.base,
    color: COLORS.ink,
  },
  // The line holds the only way to the other trips: a full touch row.
  switcher: {
    minHeight: TOUCH_TARGET,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACE.sm,
  },
  switcherLabel: {
    flexShrink: 1,
    fontFamily: FONTS.sans,
    fontSize: TYPE.md,
    color: COLORS.inkSoft,
  },
  quick: { flexDirection: "row", gap: SPACE.sm },
  obligation: {
    gap: SPACE.xs,
    paddingHorizontal: SPACE.md + 2,
    paddingVertical: SPACE.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.borderSoft,
  },
  obligationHead: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "baseline",
    justifyContent: "space-between",
    columnGap: SPACE.sm + 2,
  },
  obligationTitle: {
    flexShrink: 1,
    fontFamily: FONTS.sansSemibold,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.ink,
  },
  level: { flexShrink: 0, fontFamily: FONTS.sansSemibold, fontSize: TYPE.xs },
  levelErr: { color: COLORS.danger },
  levelWarn: { color: COLORS.warnInk },
  seal: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: COLORS.warnInk,
    borderRadius: RADIUS.chip,
    backgroundColor: COLORS.warnSurface,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  sealLabel: {
    fontFamily: FONTS.sansSemibold,
    fontSize: TYPE.xs,
    lineHeight: TYPE.xs * LEADING.xs,
    color: COLORS.warnInk,
  },
  obligationState: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.sm,
    color: COLORS.inkSoft,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: SPACE.md,
    marginTop: SPACE.xs,
  },
  actionButton: { flexShrink: 1 },
  detail: {
    marginTop: SPACE.xs,
    gap: SPACE.xs + 2,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm + 2,
    borderRadius: RADIUS.control,
    backgroundColor: COLORS.canvas2,
  },
  sheetRoot: { flex: 1, justifyContent: "flex-end" },
  sheetScrim: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    // The ink token at 40%: a scrim has to be translucent, which no token is.
    backgroundColor: "rgba(27, 42, 51, 0.4)",
  },
  sheet: {
    gap: SPACE.sm,
    padding: SPACE.xl,
    borderTopLeftRadius: RADIUS.card,
    borderTopRightRadius: RADIUS.card,
    backgroundColor: COLORS.canvas,
  },
  sheetTitle: {
    fontFamily: FONTS.serif,
    fontSize: TYPE.xl,
    lineHeight: TYPE.xl * LEADING.xl,
    color: COLORS.ink,
  },
});
