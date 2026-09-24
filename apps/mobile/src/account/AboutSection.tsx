// "Acerca de miMAR" — the read-only answer to "¿qué versión tenés?".
//
// WHY THIS EXISTS: the OTA-rehearsal prep found no screen naming the app
// version, the running update's id, or its channel, and `expo-updates` was
// never imported anywhere in app code — logcat was the only way to know
// what a given phone was running. During the pilot the first support
// question is "¿qué versión tenés?", so this sits at the bottom of Ajustes:
// read-only, no copy button, nothing to interact with.
//
// THE PAIRING THIS WAS BRIEFED FOR DOES NOT EXIST ON THIS SDK
// ---------------------------------------------------------------------------
// `Constants.nativeApplicationVersion` / `Constants.nativeBuildVersion` were
// removed from `expo-constants` years ago (its own CHANGELOG: "Remove
// deprecated ... nativeAppVersion, nativeBuildVersion ... properties") and
// are not in this app's ~57 typings at all — verified against
// node_modules/expo-constants/build/Constants.types.d.ts, which only
// mentions `nativeBuildVersion` once, inside a `@deprecated` pointer on a
// DIFFERENT, unrelated field. Their replacement lives in `expo-application`
// (`Application.nativeApplicationVersion` / `nativeBuildVersion`), a package
// this app does NOT depend on — adding it is a NEW native module, a
// different cost than importing `expo-updates` (already linked): it changes
// the fingerprint (`runtimeVersion: { policy: "fingerprint" }`,
// app.config.ts) and needs a native rebuild, exactly the class of cost
// `PrivacyScreen.tsx`'s own header already ruled out for a small addition
// ("adding either means a native module, which means an EAS build — the
// pipeline that cost six builds and five distinct root causes for the pet
// photo"). There is no config value to fall back to either:
// `eas.json`'s `appVersionSource: "remote"` means the native build number is
// assigned by EAS at build time and is never written into app.json.
//
// So this shows the version fact that IS real and already available —
// `app.json`'s `expo.version`, read via `Constants.expoConfig` — and leans on
// `expo-updates` (already a dependency; importing it in JS changes nothing
// native) for the finer-grained facts an OTA rehearsal actually needs: which
// update is running, and on which channel.
//
// WHY THIS IS A COMPONENT IN `src/account/` AND NOT INLINE IN `app/ajustes.tsx`
// ---------------------------------------------------------------------------
// Jest's `roots` is `<rootDir>/src` (jest.config.js) — nothing under `app/`
// is reachable by a test, the same reason `AccountDeletionCard` lives here
// instead of inside the screen it renders on.

import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { useCallback, useState, useSyncExternalStore } from "react";

import { crashReportingActive } from "../observability/sentry";
import { Body, Card, Row } from "../ui/components";
import { SecondaryButton } from "../ui/kit";
// THE BINDING LIVES IN ITS OWN MODULE since finding F7: `app/_layout.tsx` needs
// the port and must not import a settings Card to get it.
import { EXPO_UPDATES_PORT } from "./expo-updates-port";
import { isUpdateStaged, subscribeUpdateStaged } from "./foreground-update";
import {
  type UpdateCheckState,
  type UpdatesPort,
  checkForUpdate,
  downloadUpdate,
  restartForUpdate,
  updateActionBusy,
  updateActionLabel,
  updateCheckMessage,
} from "./update-check";

/** Enough of an update id to tell two updates apart in a screenshot, without
 * asking a tester to read out a full UUID over WhatsApp. */
const UPDATE_ID_PREFIX_LENGTH = 8;

/**
 * The runtime version, truncated the same way (OTA-4).
 *
 * WHY IT BELONGS BESIDE THE OTHER THREE. `runtimeVersion` is what decides
 * whether an OTA update reaches a phone AT ALL: the policy is `fingerprint`
 * (app.config.ts, CANON-449), so two installs on the same `version` and the
 * same `channel` can still be on different native fingerprints — and the one
 * whose fingerprint moved will never see the update, silently and forever. When
 * a tester reports "no me llegó la actualización" this is the single field that
 * answers it, and until now it was readable only from an EAS dashboard.
 *
 * A fingerprint is 40 hex characters, which nobody reads out loud. The first
 * eight distinguish every build this pilot will ever have.
 */
const RUNTIME_VERSION_PREFIX_LENGTH = 8;

function appInfo(): {
  version: string;
  update: string;
  channel: string;
  runtime: string;
  reporting: string;
} {
  const version = Constants.expoConfig?.version ?? "—";

  // "integrada" covers two different facts with one honest word: either this
  // IS the build's own embedded code (no OTA update has ever applied), or
  // expo-updates is disabled altogether (the dev client, where `updateId` is
  // always null) — in neither case is a truncated UUID a fact worth showing.
  const updateId = Updates.updateId;
  const update =
    Updates.isEmbeddedLaunch || updateId === null || updateId === ""
      ? "integrada"
      : updateId.slice(0, UPDATE_ID_PREFIX_LENGTH);

  const channel = Updates.channel ?? "—";

  const runtimeVersion = Updates.runtimeVersion;
  const runtime =
    runtimeVersion === null || runtimeVersion === ""
      ? "—"
      : runtimeVersion.slice(0, RUNTIME_VERSION_PREFIX_LENGTH);

  // The word, not the boolean: "activo"/"inactivo" is what a tester reads back
  // over WhatsApp, and "false" would need a translator.
  const reporting = crashReportingActive() ? "activo" : "inactivo";

  return { version, update, channel, runtime, reporting };
}

export function AboutSection({ updates = EXPO_UPDATES_PORT }: { updates?: UpdatesPort } = {}) {
  const { version, update, channel, runtime, reporting } = appInfo();
  const [state, setState] = useState<UpdateCheckState>({ phase: "idle" });
  // OPENS ON THE STAGED BUNDLE WHEN THERE IS ONE, AND KEEPS WATCHING
  // (A6-cuenta-resiliencia-08, corrected by finding F8). The foreground check
  // downloads silently, so without this the card would offer "Buscar
  // actualización" over a bundle already sitting on the device — and pressing it
  // would answer "Ya tenés la última versión", which is true of what has been
  // DOWNLOADED and false of what is RUNNING. That is the exact sentence that
  // left support with nothing to say.
  //
  // IT WAS A `useState` INITIALIZER, which reads the flag ONCE. Ajustes is three
  // taps down and people leave it open; a bundle staged while it is on screen
  // never reached the card, and the card went on producing the sentence this
  // feature exists to eliminate. `useSyncExternalStore` is the shape module
  // state owes a component that has to stay right after mount.
  const staged = useSyncExternalStore(subscribeUpdateStaged, isUpdateStaged);

  // WHAT THE CARD IS ACTUALLY SHOWING, once the two sources are reconciled.
  //
  // A STAGED BUNDLE ONLY OVERRIDES THE TWO PHASES THAT WOULD BE LYING — `idle`
  // (nothing has been asked) and `up-to-date` (the sentence itself). It
  // deliberately does NOT override a failure: `restartForUpdate`'s rejection
  // lands on `failed` with its own sentence, and a background flag that painted
  // "Reiniciá la app" over "No pudimos reiniciar la app" would re-open finding
  // M2 from the other side. Nor does it override a check in flight.
  const view: UpdateCheckState =
    staged && (state.phase === "idle" || state.phase === "up-to-date") ? { phase: "ready" } : state;

  const onPress = useCallback(async () => {
    if (view.phase === "ready") {
      // `restarting` FIRST, and that is a change from the first draft (finding
      // M2). The old comment here argued that a "Reiniciando…" label surviving a
      // rejection would be a screen frozen on a lie — true of a label with no
      // failure arm behind it, and the answer is the failure arm, not the
      // silence: `restartForUpdate` lands on `failed` with its own sentence, so
      // the label is only ever shown while the reload is genuinely in flight.
      // It is also what disables the button: nothing stopped a second tap from
      // firing a second `reloadAsync` against the first.
      setState({ phase: "restarting" });
      setState(await restartForUpdate(updates));
      return;
    }
    setState({ phase: "checking" });
    const checked = await checkForUpdate(updates);
    setState(checked);
    if (checked.phase !== "downloading") return;
    setState(await downloadUpdate(updates));
  }, [view.phase, updates]);

  const message = updateCheckMessage(view);

  return (
    <Card title="Acerca de miMAR">
      <Row label="Versión" value={version} />
      <Row label="Actualización" value={update} />
      <Row label="Canal" value={channel} />
      <Row label="Versión nativa" value={runtime} />
      <Row label="Reporte de errores" value={reporting} />
      <Body>Decinos esto si nos escribís por un problema.</Body>
      <SecondaryButton
        label={updateActionLabel(view)}
        disabled={updateActionBusy(view)}
        onPress={() => {
          void onPress();
        }}
      />
      {message === null ? null : <Body>{message}</Body>}
    </Card>
  );
}
