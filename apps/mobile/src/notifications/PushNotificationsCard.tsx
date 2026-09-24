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
// WHY `denied` GETS A SENTENCE AND NO BUTTON. Once Android 13+ or iOS have
// permanently refused, `canAskAgain` is `false` and the module's own dialog
// cannot be shown again from inside the app — see `push-port.ts`'s header.
// Offering a button here would either silently no-op or, worse, look like it
// tried and failed. The one way back is the OS's own notification settings,
// so that is what this card points at.
//
// WHY THE CARD ITSELF (NOT INLINE IN `app/ajustes.tsx`). jest's `roots` is
// `<rootDir>/src` (see `AltaScreen.tsx`'s header for the Windows-glob reason),
// so nothing under `app/` is reachable by a test — the same argument
// `AccountDeletionCard.tsx`'s header already makes for the same screen.

import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import { sessionPort } from "../auth/session-store";
import type { PushPermissionPeek } from "../native/push-port";
import { getPushPermissionStatusSafely } from "../native/push-port";
import { Body, Card } from "../ui/components";
import { PrimaryButton } from "../ui/kit";
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

  // ON MOUNT ONLY. Ajustes does not re-focus into this card the way a tab
  // screen would, and a re-peek belongs to the moment right after the request
  // resolves (see `activate`), not to a render this component did not cause.
  useEffect(() => {
    void peek();
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
