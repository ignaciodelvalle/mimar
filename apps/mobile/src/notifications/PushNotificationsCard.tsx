// Ajustes' entry point back into notification permission — M4, decision 10A
// (finding M-1).
//
// WHY THIS EXISTS AT ALL. The priming line in `AltaScreen` offers the system
// dialog exactly once, right after the first successful alta. Two kinds of
// person never see it again after that: whoever tapped "Ahora no" — the
// dismissal decision 10A asks this app to remember — and whoever registered
// their only pet before this feature shipped, and so was never offered it at
// all. Both need a door back in that is not "register another pet", and
// Ajustes is the door decision 10A names.
//
// WHY IT PEEKS RATHER THAN JUST OFFERING A BUTTON UNCONDITIONALLY. An account
// that already granted, or whose build has no push module at all
// (`moduleMissingPush` — every device in the closed test today), has nothing
// this card can do for it: a button that reaches `requestPushPermissionAndRegister`
// for an already-granted install spends nothing new, and one offered on a
// build with no `expo-notifications` would promise a dialog that can never
// appear. Both are hidden rather than shown-and-disabled, because a settings
// screen with a dead control is its own kind of confusing.
//
// WHY `denied` GETS A SENTENCE, AND A DOOR TO THE OS RATHER THAN THE IN-APP
// BUTTON. Once Android 13+ or iOS have permanently refused, `canAskAgain` is
// `false` and the module's own dialog cannot be shown again from inside the
// app — see `push-port.ts`'s header. Offering `requestPushPermissionAndRegister`
// here would either silently no-op or, worse, look like it tried and failed.
// The one way back is the OS's own notification settings for this app, so
// "Abrir ajustes del teléfono" (`Linking.openSettings()`) is what this card
// offers instead of a dead permission button.
//
// WHY IT RE-PEEKS ON FOREGROUND. Flipping the switch in system settings and
// switching back to miMAR is the ordinary path through the door this card just
// opened, and that switch happens entirely outside this app's control — there
// is no event for it other than the app itself coming back to `active`. Without
// this, the card would keep showing "Desactivaste los avisos" (or the
// "Activar avisos" button) after the person just turned them on, until the
// next full remount of Ajustes.
//
// WHY THE CARD ITSELF (NOT INLINE IN `app/ajustes.tsx`). jest's `roots` is
// `<rootDir>/src` (see `AltaScreen.tsx`'s header for the Windows-glob reason),
// so nothing under `app/` is reachable by a test — the same argument
// `AccountDeletionCard.tsx`'s header already makes for the same screen.

import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus, Linking, StyleSheet, View } from "react-native";

import { sessionPort } from "../auth/session-store";
import type { PushPermissionPeek } from "../native/push-port";
import { getPushPermissionStatusSafely } from "../native/push-port";
import { Body, Card } from "../ui/components";
import { PrimaryButton, SecondaryButton } from "../ui/kit";
import { SPACE } from "../ui/theme";
import { requestPushPermissionAndRegister } from "./push-registration";

type CardState =
  | { phase: "loading" }
  | { phase: "idle"; status: PushPermissionPeek }
  | { phase: "requesting" };

export function PushNotificationsCard() {
  const [state, setState] = useState<CardState>({ phase: "loading" });

  const peek = useCallback(async () => {
    const status = await getPushPermissionStatusSafely();
    setState({ phase: "idle", status });
  }, []);

  // ON MOUNT, and every time the app returns to the foreground.
  useEffect(() => {
    void peek();
  }, [peek]);

  // SEEDED TO `"active"`, NOT READ FROM `AppState.currentState`. That read is
  // what `foreground-update.ts` uses, but it answers a question this
  // component does not need to ask: something is only mounting THIS card
  // right now because Ajustes is on screen, which is only possible while the
  // app is active — the platform's own idea of `currentState` at that instant
  // (unreliable in this repo's jest environment, among others) is not needed
  // to know that.
  const previousAppState = useRef<AppStateStatus>("active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      const cameFromBackground = previousAppState.current !== "active";
      previousAppState.current = next;
      // ONLY ON A REAL EDGE INTO `active`. Every other "change" (active to
      // inactive, inactive to background, and so on) is not the moment
      // somebody could have flipped the OS switch and come back — re-peeking
      // on those would just be a wasted read.
      if (next === "active" && cameFromBackground) void peek();
    });
    return () => subscription.remove();
  }, [peek]);

  const activate = useCallback(async () => {
    setState({ phase: "requesting" });
    await requestPushPermissionAndRegister(sessionPort);
    // RE-PEEK RATHER THAN TRUST THE OUTCOME DIRECTLY: the registration's own
    // result vocabulary (`registered` / `denied` / `unavailable` / `failed`)
    // is about the ROW, and this card only ever renders off the PERMISSION
    // peek — asking the same question the same way keeps the two paths (this
    // button, and the priming card) honouring one source of truth.
    await peek();
  }, [peek]);

  if (state.phase === "loading") return null;

  const status = state.phase === "idle" ? state.status.outcome : "requesting";

  // Nothing this card can do: already on, or no push in this build, or a peek
  // that answered nothing useful. A dead control is worse than no control.
  if (status === "granted" || status === "unavailable" || status === "failed") return null;

  if (status === "denied") {
    return (
      <Card title="Notificaciones">
        <Body>
          Desactivaste los avisos de miMAR. Para volver a activarlos, entrá a los ajustes de
          notificaciones del sistema para esta app.
        </Body>
        <View style={styles.actions}>
          <SecondaryButton
            label="Abrir ajustes del teléfono"
            onPress={() => void Linking.openSettings()}
          />
        </View>
      </Card>
    );
  }

  // `undetermined`, or a request in flight.
  return (
    <Card title="Notificaciones">
      <Body>
        Activá los avisos para enterarte cuándo vencen las vacunas de tus mascotas y si alguien
        encuentra a una que se perdió.
      </Body>
      <View style={styles.actions}>
        <PrimaryButton
          label={state.phase === "requesting" ? "Activando…" : "Activar avisos"}
          disabled={state.phase === "requesting"}
          onPress={() => void activate()}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  actions: { gap: SPACE.sm, marginTop: SPACE.xs },
});
