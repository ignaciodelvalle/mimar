// One pet, as ONE two-sided document — the native mirror of the web's card.
//
// TWO FACES, NOT THREE (PO decision, 2026-08-28): Credencial · frente (the
// owner's front face, `OwnerCredentialFace`) and Libreta · dorso
// (`LibretaScreen`), inside the shared `DocumentChromeNative` — band, mono
// title, situation chip, turn button, hairline frame. The public credential is
// a ROUTE one tap from the QR block and from "Más", not a face; see the route
// shell (`app/mascotas/[publicToken].tsx`) for the argument with the old
// three-face layering.
//
// THE TURN IS ANIMATED, AND THE INSTANT SWAP IS STILL A FIRST-CLASS PATH — it
// is what a reader who asked for less motion gets, and what this document
// shipped with. `DocumentTurn.tsx` owns the motion and the preference; see its
// header for why the preference lives in a ref instead of state.
//
// TWO FACE VARIABLES, AND THE DIFFERENCE MATTERS. `face` is what the reader
// REQUESTED (a button press changes it, and the turn button's toggle state
// reports it at once); `turn.paintedFace` is what is actually on the sheet, and
// it lags by the ~205ms the sheet spends standing edge-on. Everything that
// renders content — the sheet's body, the band's subtitle, and the sections
// BELOW the card — follows the painted face, so the whole screen changes at the
// single moment the document turns over rather than in two visible waves.
//
// WHO OWNS WHAT. This screen owns the one scroll view, the owner-detail read
// (the front face's data AND the band chip's situation — the chip must
// survive a flip to the back face, so the read cannot live inside the face
// that unmounts), and the face state. The libreta face brings its own read,
// failure copy and write, unchanged. The situation chip's key/tone/icon/label
// are decided SERVER-SIDE (`OwnerPetSituationV1`); nothing here re-derives
// them.
//
// NOT CACHED — the deliberate v1 decision the old owner face recorded, still
// true: `credential-cache.ts` justifies caching the PUBLIC document precisely
// because it is public; this payload (open cases, caretaker names, the
// household's other animals) is a different privacy class and none of that
// reasoning carries over. A failed read says so and offers a retry.

import type { OwnerPetSituationV1 } from "@dim/contract/api";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { BackHandler, StyleSheet, Text, View } from "react-native";

import { apiFailureMessage } from "../api/client";
import { fetchOwnerPetDetail } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body, Card, Loading, StaleNotice } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { Screen, pullToRefresh } from "../ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../ui/reload-state";
import { COLORS, LEADING, SPACE, TYPE } from "../ui/theme";
import { useReconnect } from "../ui/use-reconnect";
import { DocumentChromeNative, type DocumentFace } from "./DocumentChromeNative";
import { TurningSheet, useDocumentTurn } from "./DocumentTurn";
import { LibretaScreen } from "./LibretaScreen";
import { OwnerCredentialFace, OwnerExtraSections } from "./OwnerFace";
import { type OwnerFaceView, buildOwnerFaceView } from "./owner-face-view-model";

type OwnerState =
  | { phase: "loading" }
  | ReadyState<OwnerFaceView>
  | { phase: "failed"; message: string };

/** One sentence per failure arm. No arm may fall through to a generic shrug. */
/** The band chip's payload, read off the view — null when the read failed or
 *  the situation is the default (no pill rather than a green one). */
function situationOf(view: OwnerFaceView | null): OwnerPetSituationV1 | null {
  if (view === null || view.status.state !== "ok") return null;
  return view.status.data.situation;
}

export function PetDocumentScreen({
  publicToken,
  initialFace = "credencial",
}: {
  publicToken: string;
  /**
   * Which face the document opens on. Defaults to the credential — that is what
   * a person navigating to an animal expects to see, and every caller but one
   * omits it.
   *
   * THE ONE THAT DOES NOT is the writer's "Volver a la libreta" (native QA batch
   * 1, D3): saving an asiento used to return the reader to the FRONT of the
   * document they had just written into the back of. It is an INITIAL value and
   * not a controlled prop on purpose — the turn button owns the face from the
   * first tap onwards, and a prop that kept re-asserting itself would fight the
   * reader for control of their own document.
   */
  initialFace?: DocumentFace;
}) {
  const [face, setFace] = useState<DocumentFace>(initialFace);
  const turn = useDocumentTurn(face);
  const painted = turn.paintedFace;

  /**
   * THE HARDWARE BACK BUTTON TURNS THE CARD BACK OVER FIRST (T4-M2, native QA
   * batch 4), instead of leaving the screen the way every OTHER hardware-back
   * press on this app does. A reader who flipped to Libreta · dorso and then
   * reaches for the phone's own back gesture is asking to see what they were
   * just looking at, not to leave the document — the same distinction the turn
   * BUTTON already draws; the hardware key is a second way to reach it, not a
   * different action.
   *
   * A REF, NOT `face` IN THE LISTENER'S DEPENDENCIES. `BackHandler.
   * addEventListener` reads whichever closure it was registered with; a
   * listener that closed over a stale `face` would keep answering "already on
   * the front" after the reader had turned the card, so the read has to be
   * live. `faceRef` is that: written on every render, read only when the
   * hardware key is actually pressed. `CredentialScreen`'s `spotlightRef`
   * carries the same shape for the same reason.
   *
   * FOCUS-SCOPED (`useFocusEffect`, not `useEffect`), because a native-stack
   * screen stays MOUNTED underneath whatever gets pushed on top of it — a
   * mount-scoped listener would keep intercepting the hardware key on every
   * OTHER screen pushed above this document, turning their own "go back"
   * presses into silent no-ops here instead.
   *
   * RETURNS `true` ONLY WHEN IT ACTUALLY FLIPPED THE CARD. `true` tells
   * `BackHandler` the press was handled and stops it there; on the front face
   * this listener has nothing to do, and returning `false` lets the press fall
   * through to whatever handles it next (the gate's `<Redirect>`, the stack's
   * own pop) exactly as if this listener were not registered at all.
   */
  const faceRef = useRef(face);
  faceRef.current = face;
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        if (faceRef.current === initialFace) return false;
        setFace(initialFace);
        return true;
      });
      return () => subscription.remove();
    }, [initialFace]),
  );
  const [owner, setOwner] = useState<OwnerState>({ phase: "loading" });
  /**
   * The PLATFORM spinner's flag, and it is a different thing from
   * `owner.phase === "loading"` — which is what it used to be wired to, and
   * the bug that cost the document two ways at once. Bound to the read's
   * phase, the gesture's indicator ran during the FIRST read (next to the
   * screen's own "Leyendo la ficha…"), and a pull reset the phase to
   * `loading`, replacing the whole credential with that placeholder. A refresh
   * that unmounts what it is refreshing is a reload. The four list screens
   * that adopted `pullToRefresh` first (TurnosScreen, SharesScreen,
   * NotificationsScreen, TransfersScreen) already carry this separate boolean.
   */
  const [refreshing, setRefreshing] = useState(false);
  // Guards against a stale response overwriting a newer one after two fast
  // pulls — the same generation counter CredentialScreen uses, and for the
  // same reason. (It guarded a double-tapped "Actualizar" button until
  // 2026-09-03; the race is identical, the gesture is not.)
  const generation = useRef(0);
  /**
   * Bumped by every pull-to-refresh, and it is what gives the LIBRETA face a
   * way to reload now that its own "Actualizar" button is gone.
   *
   * The two faces have SEPARATE reads — this screen owns the owner detail,
   * `LibretaScreen` owns the ledger — so refreshing one does not refresh the
   * other, and a single pull has to reach both. It is a PROP the libreta
   * watches, not a `key` that remounts it: a remount threw the ledger away to
   * fetch it again, which is the same "reload, not refresh" defect the
   * spinner had. The one thing the libreta held that a remount would have
   * re-taken is `LibretaBody`'s `now`, frozen at mount for the day-boundary
   * labels — it is now re-taken only when the face is genuinely mounted, and a
   * screen left open across midnight keeps the labels it was drawn with.
   */
  const [refreshNonce, setRefreshNonce] = useState(0);

  /**
   * THREE MODES AND NOT TWO, because the middle one has no gesture behind it
   * (lote 1b review, F9):
   *
   *   · `initial` — nothing on screen yet. Blank to the placeholder.
   *   · `refresh` — the PULL. `refreshing` is the RefreshControl's own prop, so
   *     setting it drops the platform spinner; that is correct when a finger put
   *     it there and wrong otherwise.
   *   · `focus`   — coming back from "Editar datos". Keep the document, re-read
   *     underneath it, and touch NEITHER the phase nor the spinner. Bound to
   *     `refresh`, every single return from a pushed screen span the pull-to-
   *     refresh control at somebody who had not pulled anything.
   */
  const load = useCallback(
    async (mode: "initial" | "refresh" | "focus" = "initial") => {
      const mine = ++generation.current;
      // A refresh leaves the previous view mounted; only the first read has
      // nothing to show.
      if (mode === "refresh") setRefreshing(true);
      else if (mode === "initial") setOwner({ phase: "loading" });
      const result = await fetchOwnerPetDetail(sessionPort, publicToken);
      if (mine !== generation.current) return;
      // AFTER the guard, deliberately: a stale response must not stop the
      // spinner of the newer read that superseded it.
      if (mode === "refresh") setRefreshing(false);
      if (result.outcome === "ok") {
        setOwner(loaded(buildOwnerFaceView(result.payload)));
        return;
      }
      // KEEPING THE DOCUMENT ON SCREEN (S-2 / A3-documento-credencial-07). A
      // pull-to-refresh that failed used to replace the credential — chip,
      // face and every section — with a refusal, on a screen somebody may have
      // opened precisely because they are standing in front of a vet with no
      // signal. The document that was already read is still the document.
      setOwner((current) =>
        reloadFailed(current, result, apiFailureMessage(result) ?? "No pudimos leer esta mascota."),
      );
    },
    [publicToken],
  );

  // ON FOCUS, NOT ONLY ON MOUNT (A3-documento-credencial-01 / A5-ciudadanas-05 /
  // A4-custodia-07 — the shape `TransfersScreen` has carried since QA batch 3).
  // Every screen here pushes something ON TOP of itself that CHANGES it —
  // "Editar datos", the postulación form, a lost-mode command — and coming back
  // pops rather than remounts, so a mount-only effect left the reader looking at
  // the state from before their own write.
  //
  // THE RETURN IS A "focus" AND NOT AN "initial" READ: `initial` blanks the
  // screen to a skeleton, which would happen every single time somebody comes
  // back. The FIRST appearance still takes the loading phase, because there is
  // nothing yet to keep. And not a "refresh" either — see `load`: that mode owns
  // the RefreshControl's flag, and a focus return is not a pull.
  const hasLoaded = useRef(false);
  useFocusEffect(
    useCallback(() => {
      void load(hasLoaded.current ? "focus" : "initial");
      hasLoaded.current = true;
    }, [load]),
  );

  // WHEN THE NETWORK COMES BACK, TRY AGAIN (B-05, the other half of S-2). A
  // `focus` read and not a `refresh`: nobody pulled, so the platform spinner must
  // stay still — the same distinction F9 is about. The libreta's own ledger is a
  // separate read and keeps its own trigger; this one owns the owner detail.
  useReconnect(() => void load("focus"));

  const view = owner.phase === "ready" ? owner.view : null;

  return (
    // PULL TO REFRESH, and no button. A national credential's only blue
    // full-width control used to say "Actualizar" — the loudest thing on the
    // document was reload. The gesture Android already has does the same job
    // and costs no pixels. See `pullToRefresh` in the kit.
    <Screen
      refreshControl={pullToRefresh(() => {
        setRefreshNonce((n) => n + 1);
        void load("refresh");
      }, refreshing)}
    >
      {/* The "Ficha del dueño" eyebrow was deleted on 2026-09-03: an ALL-CAPS
          mono label floating above the document with no heading under it,
          saying what the band says two lines lower ("Libreta Sanitaria /
          Credencial · frente" — "Nacional" dropped from the title itself,
          PO 2026-09-24, see DocumentChromeNative.tsx).
          The viewer line — a caretaker or a foster reading this document needs
          to know WHY some things are missing from it; an unexplained gap reads
          as a bug. It is ABSENT for a titular, whose document is missing
          nothing: `viewerRoleLabel` returns null there.
          THE WRAPPER GOES WITH IT, and that is the whole point of this shape.
          The previous version returned null for the row and kept the <View>,
          which still spent its own gap and pushed the credential down the
          screen — a blank band above the document, where the titular used to
          read a line about themselves they did not need. Reported by the PO on
          2026-09-16: "empieza un poco más abajo la credencial como si
          estuviera". An element that renders nothing must also occupy
          nothing. */}
      {view?.viewerLabel == null ? null : (
        <View style={styles.masthead}>
          <Text style={styles.viewerLine}>{view.viewerLabel}</Text>
        </View>
      )}

      <TurningSheet turn={turn}>
        <DocumentChromeNative
          face={painted}
          isLibretaActive={face === "libreta"}
          onTurn={() => setFace((current) => (current === "credencial" ? "libreta" : "credencial"))}
          situation={situationOf(view)}
        >
          {painted === "credencial" ? (
            <FrontFaceBody state={owner} />
          ) : (
            <LibretaScreen
              publicToken={publicToken}
              // S-3: the ledger's "Próximo" block is not drawn for an animal
              // that has died. This screen is the one that knows.
              deceased={view?.status.state === "ok" && view.status.data.petStatus === "deceased"}
              refreshNonce={refreshNonce}
              onRefreshSettled={() => setRefreshing(false)}
            />
          )}
        </DocumentChromeNative>
      </TurningSheet>

      {painted === "credencial" && view !== null ? <OwnerExtraSections view={view} /> : null}
    </Screen>
  );
}

/** The front face's three phases, inside the chrome. A failed read renders its
 *  refusal INSIDE the card — the document is still a document, just unread. */
function FrontFaceBody({ state }: { state: OwnerState }) {
  if (state.phase === "loading") {
    return (
      <View style={styles.facePad}>
        <Loading label="Leyendo la ficha…" />
      </View>
    );
  }
  if (state.phase === "failed") {
    return (
      <View style={styles.facePad}>
        <Card title="No disponible">
          <Body>{state.message}</Body>
        </Card>
      </View>
    );
  }
  return (
    <>
      {state.staleFailure === null ? null : (
        <View style={styles.facePad}>
          <StaleNotice message={state.staleFailure} />
        </View>
      )}
      <OwnerCredentialFace view={state.view} />
    </>
  );
}

const styles = StyleSheet.create({
  masthead: { gap: SPACE.xs },
  viewerLine: {
    fontFamily: FONTS.sansMedium,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.inkSoft,
  },
  // The `.ln-sec` phone padding, for the two non-face bodies (loading/failed).
  facePad: { paddingVertical: 20, paddingHorizontal: 18 },
});
