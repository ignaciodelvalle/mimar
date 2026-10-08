// MODO PERDIDA — the screen a person opens at two in the morning.
//
// ONE SCREEN FOR THE WHOLE FEATURE, where the web has two places: a page for
// marking lost and updating the last-seen point, and a block on the profile for
// the search, the feed, the disclosure toggles and the poster link. On a phone
// that split would be two taps between "what has happened" and "tell it what
// happened next", and this is the flow where those two questions are the same
// question.
//
// EVERY AFFORDANCE COMES FROM `capabilities`, NEVER FROM `status`. The server
// decides which of the state commands this caller may send, because four of the
// five conditions need facts a client does not hold — whether a
// `lost_pet_episode` is open, and whether this caller reached the animal through
// an organization (which is refused for reactivation and for nothing else). A
// screen that computed them from `status` would get four right and the fifth
// wrong, and the wrong one would only show up as a 403 in somebody's hands.
//
// "REPORTAR" IS THE EXCEPTION, AND IT IS NOT A CAPABILITY. The sixth command
// takes an ITEM rather than the animal, and the right to report one is
// co-extensive with the right to read the feed it is on — so there is no flag to
// obey, and a flag would have been `true` on every payload that ever reached
// this screen. What decides where the control appears is the item's KIND: a
// sighting and a finder message were typed by an anonymous stranger, a scan is a
// machine reading a QR. `feedItemReportable` is that one line.
//
// AND IT IS "REPORTAR", NEVER "DENUNCIAR". In this product `denuncia` already
// names a Ley 14.346 animal-cruelty complaint routed to an authority. Using that
// word on a button that hides a message would promise a proceeding that is not
// happening.
//
// THE DISCLOSURE ROWS ARE THE PRIVACY SURFACE, and they are the reason this
// screen says who sees each thing rather than just naming it. Every toggle
// governs a field on the PUBLIC credential — the page a stranger who scanned the
// QR is reading — and a row labelled only "Mostrar mi teléfono" does not say to
// whom. A preference this caller may not change is SHOWN and marked, not hidden:
// hiding it would leave a caretaker wondering whether the setting exists, and
// rendering a live switch that answers 403 would be a control that lies.
//
// ONE KEY PER AVISTAJE FORM MOUNT, the same rule "Asentar" follows and for the
// same reason: a double tap on a flaky connection must not put two sightings in
// one episode. The other five commands send no key at all — their writers are
// idempotent on the state, and a key they would ignore is a guarantee nobody
// has. `report_content` APPENDS and still sends none, which is the proof the
// rule is about state: an item already reported is not reported twice.
//
// NO MAP AND NO COORDINATES. The web captures a pin; this sends the last-seen
// place as TEXT, which is exactly what an untouched web wizard sends. Adding a
// pin later is a widget here and nothing at all on the server — the contract's
// pair is already optional and both-or-neither.
//
// THE FILE IS SPLIT BY PANE (custody polish, 2026-10-07), the route is not: this
// file holds the screen state, the read, the one `run` every command goes
// through and the pane switch; `LostOverview.tsx` is the overview (one primary
// per state, the rest as rows and modules), `LostForms.tsx` the three forms, and
// `lost-ui.tsx` the shapes they share.

import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import type { LostCommandAckV1, LostFeedItemV1, PetLostV1 } from "@dim/contract/api";
import type { LostCommandInput } from "@dim/contract/input";

import { type ApiResult, apiFailureMessage } from "../api/client";
import { fetchPetLostMode, sendLostCommand } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body, StaleNotice } from "../ui/components";
import { hapticError, hapticSuccess } from "../ui/haptics";
import { Callout, Eyebrow, PrimaryButton, Screen, Title } from "../ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../ui/reload-state";
import { ListSkeleton } from "../ui/skeleton";
import { SPACE } from "../ui/theme";

import { MarkLostForm, ReportContentForm, ReportForm } from "./LostForms";
import { LostOverview } from "./LostOverview";
import { commandDoneLabel, commandUnchangedLabel } from "./lost-view-model";

/** One sentence per failure arm. No arm may fall through to a generic shrug. */
type ScreenState =
  | { phase: "loading" }
  | ReadyState<PetLostV1>
  | { phase: "failed"; message: string };

/**
 * Which pane is on screen. The forms are panes, not routes.
 *
 * `report` is the AVISTAJE form and `report-content` is the MODERATION one, and
 * the two names are close enough to be worth separating out loud: one adds a
 * sighting to the search, the other takes a stranger's message off it. The
 * commands behind them are `report_last_seen` and `report_content`, which is the
 * same collision the contract carries — "reportar un avistaje" is the ordinary
 * Spanish for logging one, and the word arrived here first.
 */
type Pane = "overview" | "mark-lost" | "report" | "report-content";

export function LostScreen({ publicToken }: { publicToken: string }) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [pane, setPane] = useState<Pane>("overview");
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; message: string } | null>(null);
  // The feed row the person chose to report. Held on the SCREEN and not inside
  // the pane, because the pane is unmounted the moment the command returns and
  // the row's id has to survive being handed to it.
  const [reporting, setReporting] = useState<LostFeedItemV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Guards against a stale response overwriting a newer one after a fast double
  // tap on "Actualizar" — the same generation counter every other screen uses.
  const generation = useRef(0);

  /**
   * Read the search.
   *
   * THE MODE IS NOT DECORATION AND THIS SCREEN SHIPPED WITHOUT IT (lote 1b
   * review, F7). `hasLoaded` below was assigned and never read, so every focus —
   * including returning from the avistaje form, which is a PANE two lines away —
   * took the `loading` branch and blanked the whole panel; and every failure took
   * `{ phase: "failed" }`, deleting a search that was on screen a moment before.
   * That is the exact S-2 rule this batch exists to enforce, violated on the
   * screen somebody opens at 2 a.m. looking for their dog. `PetDocumentScreen`
   * had the shape right; it was written there and not wired here.
   */
  const load = useCallback(
    async (mode: "initial" | "refresh" = "initial") => {
      const mine = ++generation.current;
      if (mode === "initial") setState({ phase: "loading" });
      const result = await fetchPetLostMode(sessionPort, publicToken);
      if (mine !== generation.current) return;
      if (result.outcome === "ok") {
        setState(loaded(result.payload));
        return;
      }
      setState((current) =>
        reloadFailed(
          current,
          result,
          apiFailureMessage(result) ?? "No pudimos leer el modo perdida.",
        ),
      );
    },
    [publicToken],
  );

  // ON FOCUS, NOT ONLY ON MOUNT (A5-ciudadanas-05 / A4-custodia-07 — the shape
  // `TransfersScreen` has carried since QA batch 3). This screen pushes
  // something on top of itself that CHANGES it, and coming back pops rather than
  // remounts, so a mount-only effect left the reader looking at the state from
  // before their own write.
  //
  // THE REF IS READ AT THE CALL SITE, which is what makes the mode above mean
  // anything. Only the first appearance has nothing to keep.
  const hasLoaded = useRef(false);
  useFocusEffect(
    useCallback(() => {
      void load(hasLoaded.current ? "refresh" : "initial");
      hasLoaded.current = true;
    }, [load]),
  );

  const petSex = state.phase === "ready" ? state.view.petSex : null;

  /**
   * Send one command, then RE-READ.
   *
   * The acknowledgement deliberately does not carry the new state — the read is
   * the one place the episode, the feed, the preferences and the capability
   * flags are computed together, and patching four of them from a write would be
   * a second, thinner source for the same facts.
   */
  const run = useCallback(
    async (input: LostCommandInput, idempotencyKey: string | null) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      const result: ApiResult<LostCommandAckV1> = await sendLostCommand(
        sessionPort,
        publicToken,
        input,
        idempotencyKey,
      );
      setBusy(false);
      if (result.outcome !== "ok") {
        hapticError();
        setError(apiFailureMessage(result) ?? "No pudimos leer el modo perdida.");
        return;
      }
      // The haptic tracks `changed` the way the copy does: a replay that
      // changed nothing gets the warn sentence and NO success buzz — a buzz
      // saying "done" over "ya estaba así" would be the two channels
      // disagreeing.
      if (result.payload.changed) hapticSuccess();
      setNotice(
        result.payload.changed
          ? { tone: "ok", message: commandDoneLabel(result.payload.command, petSex) }
          : { tone: "warn", message: commandUnchangedLabel(result.payload.command, petSex) },
      );
      setPane("overview");
      // A REFRESH: the command already succeeded and its notice is on screen.
      // Blanking the panel to re-read what the person just changed would hide
      // that notice behind a spinner, and a re-read that then failed would
      // delete the search along with the confirmation of their own write.
      await load("refresh");
    },
    [load, petSex, publicToken],
  );

  return (
    <Screen keyboardAvoiding>
      <View style={styles.header}>
        <Eyebrow>Modo perdida</Eyebrow>
        <Title>Búsqueda</Title>
      </View>

      {state.phase === "loading" ? <ListSkeleton rows={2} label="Leyendo la búsqueda…" /> : null}

      {state.phase === "failed" ? (
        <>
          <Callout tone="err" title="No disponible">
            <Body>{state.message}</Body>
          </Callout>
          <PrimaryButton label="Reintentar" onPress={() => void load("initial")} />
        </>
      ) : null}

      {/* The failed RE-read, over the search it could not replace (S-2). */}
      {state.phase === "ready" && state.staleFailure !== null ? (
        <StaleNotice message={state.staleFailure} onRetry={() => void load("refresh")} />
      ) : null}

      {notice === null ? null : (
        <Callout tone={notice.tone} title={notice.tone === "ok" ? "Listo" : "Sin cambios"}>
          <Body>{notice.message}</Body>
        </Callout>
      )}

      {error === null ? null : (
        <Callout tone="err" title="No se pudo">
          <Body>{error}</Body>
        </Callout>
      )}

      {state.phase === "ready" && pane === "overview" ? (
        <LostOverview
          view={state.view}
          busy={busy}
          onMarkLost={() => setPane("mark-lost")}
          onReport={() => setPane("report")}
          onReportItem={(item) => {
            setReporting(item);
            setPane("report-content");
          }}
          onRun={run}
          onReload={() => void load("refresh")}
        />
      ) : null}

      {state.phase === "ready" && pane === "mark-lost" ? (
        <MarkLostForm
          view={state.view}
          busy={busy}
          onCancel={() => setPane("overview")}
          onRun={run}
        />
      ) : null}

      {state.phase === "ready" && pane === "report" ? (
        <ReportForm
          busy={busy}
          onCancel={() => setPane("overview")}
          onRun={run}
          startQuery={state.view.episode?.jurisdictionLocality ?? null}
        />
      ) : null}

      {state.phase === "ready" && pane === "report-content" && reporting !== null ? (
        <ReportContentForm
          item={reporting}
          busy={busy}
          onCancel={() => {
            setReporting(null);
            setPane("overview");
          }}
          onRun={run}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: SPACE.xs },
});
