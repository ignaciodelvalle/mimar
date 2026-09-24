// PRIVACIDAD — the two rights Ley 25.326 gives a person over their own file,
// finally exercisable from the phone.
//
// WHAT THIS REPLACES, AND WHAT IT DOES NOT
// ---------------------------------------------------------------------------
// `AccountDeletionCard` used to be the whole story: a link that opened
// `/cuenta/privacidad` in a browser. That link satisfied Google Play and it
// accepted two costs its own docblock named — the person re-authenticates in a
// signed-out tab, and this app cannot know whether the deletion happened. Both
// are gone now: the erasure is a bearer call, and its 200 is what drops the
// session here.
//
// One cost is NOT gone and this screen says so rather than hiding it: THERE IS
// NO WAY TO SAVE A FILE TO THE PHONE. `expo-file-system` and `expo-sharing` are
// not dependencies of this app, and adding either means a native module, which
// means an EAS build — the pipeline that cost six builds and five distinct root
// causes for the pet photo, and which the board explicitly rules out as a first
// task. So art. 14 is served two ways that need no module: the file is SHOWN
// (that is the access right, literally) and handed to the OS share sheet
// (`react-native`'s own `Share`, core, no dependency). Somebody who wants a
// `.json` on disk still has the web page, which is why the link stays.
//
// WHY THE EXPORT IS NOT RENDERED IN FULL
// ---------------------------------------------------------------------------
// It is the subject's entire record — every pet, every sanitary event, every
// identification. Painting that into a ScrollView would be a screen nobody can
// read and a list nobody can scroll to the end of. What is drawn is the SHAPE:
// each top-level section of the export with how many rows it holds, which is
// what answers "what do you have on me" at a glance. The bytes themselves go
// out through the share sheet, unaltered.
//
// THE ERASURE IS TWO TAPS AND A SENTENCE, WHICH IS THE WEB'S SHAPE
// ---------------------------------------------------------------------------
// `PrivacyActions.tsx` hides the destructive control behind "Quiero eliminar mi
// cuenta", then requires a motivo of at least five characters before the confirm
// button is live. This mirrors both, and mirrors them because they are the right
// design rather than out of deference: the reason field is a five-second pause
// on an act with no undo, and the disclosure step means the red button is never
// under a thumb that was aiming at something else.

import { useCallback, useState } from "react";
import { Share, StyleSheet, Text, View } from "react-native";

import type { MySubjectDataExportV1 } from "@dim/contract/api";
import { ERASURE_REASON_MAX_LENGTH, ERASURE_REASON_MIN_LENGTH } from "@dim/contract/input";

import { apiFailureMessage } from "../api/client";
import { fetchMySubjectDataExport } from "../api/endpoints";
import { eraseAccount, sessionPort } from "../auth/session-store";
import { ACCOUNT_DELETION_URL } from "../config/api";
import { Body, Card, Row } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { Callout, PrimaryButton, Screen, SecondaryButton, TextField, Title } from "../ui/kit";
import { ROUTES } from "../ui/routes";
import { COLORS, LEADING, SPACE, TYPE } from "../ui/theme";

import { type ExportSection, exportSections, exportShareText } from "./subject-data-summary";

/**
 * One sentence per failure arm. No arm falls through to a generic shrug, and
 * none of them quotes anything the server sent.
 */
type ExportState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; view: MySubjectDataExportV1; sections: ExportSection[] }
  | { phase: "failed"; message: string };

type EraseState =
  | { phase: "idle" }
  | { phase: "confirming" }
  | { phase: "sending" }
  | { phase: "failed"; message: string };

export function PrivacyScreen() {
  const [exportState, setExportState] = useState<ExportState>({ phase: "idle" });
  const [erase, setErase] = useState<EraseState>({ phase: "idle" });
  const [reason, setReason] = useState("");

  const requestExport = useCallback(async () => {
    setExportState({ phase: "loading" });
    const result = await fetchMySubjectDataExport(sessionPort);
    if (result.outcome === "ok") {
      setExportState({
        phase: "ready",
        view: result.payload,
        sections: exportSections(result.payload.subject),
      });
      return;
    }
    setExportState({
      phase: "failed",
      message: apiFailureMessage(result) ?? "No pudimos pedir tus datos.",
    });
  }, []);

  const shareExport = useCallback(async (view: MySubjectDataExportV1) => {
    // BEST-EFFORT AND SILENT ON REFUSAL. `Share.share` rejects when the user
    // dismisses the sheet, which is not an error and must not be reported as
    // one — the file is still on the screen behind it.
    try {
      await Share.share({ message: exportShareText(view) });
    } catch {
      // Dismissed, or no share target. Nothing to say.
    }
  }, []);

  const confirmErase = useCallback(async () => {
    setErase({ phase: "sending" });
    // The path travels with the erasure for the reason `signOut` takes one: the
    // gate must suppress the sign-in `next` for THIS screen and no other, since
    // the reason it reads ("account_erased") outlives the navigation that
    // caused it. See `signedOutHref`.
    const result = await eraseAccount(reason, ROUTES.privacidad);
    if (!result.ok) {
      setErase({ phase: "failed", message: result.message });
      return;
    }
    // On success the store flips to `signed-out` with reason `account_erased`
    // and every gate in the app redirects. Nothing to navigate to from here —
    // and deliberately no `router.replace`, which would race the redirect the
    // store has already started.
  }, [reason]);

  const reasonUsable =
    reason.trim().length >= ERASURE_REASON_MIN_LENGTH &&
    reason.trim().length <= ERASURE_REASON_MAX_LENGTH;

  return (
    // A6-cuenta-resiliencia-17: this and EditProfileScreen were the last two
    // text-input screens without it. The motivo box sits under the confirm
    // button, so an iOS keyboard covered both what was being typed and the
    // control that submits it.
    <Screen keyboardAvoiding>
      <Title>Privacidad y datos personales</Title>
      <Body>
        Ejercé los derechos que te garantiza la Ley 25.326 de Protección de Datos Personales. El
        pedido y la supresión quedan registrados con la cita normativa.
      </Body>

      {/* ---------- Art. 14 — acceso ---------- */}
      <Card title="Descargar mis datos">
        <Body>
          Un resumen de lo que guardamos sobre vos: tu perfil, tus mascotas, sus identificaciones y
          los eventos sanitarios asociados. El archivo que descargás tiene todo, completo. Ley
          25.326, art. 14 (derecho de acceso).
        </Body>

        {exportState.phase === "failed" ? (
          <Callout tone="err">
            <Text style={styles.calloutText}>{exportState.message}</Text>
          </Callout>
        ) : null}

        {exportState.phase === "ready" ? (
          <>
            <Callout tone="ok" title="Estos son tus datos">
              <Text style={styles.calloutText}>
                Versión del export: {String(exportState.view.subject.schema_version ?? "—")}
              </Text>
            </Callout>
            {exportState.sections.map((section) => (
              <Row key={section.key} label={section.label} value={section.summary} />
            ))}
            <Body>
              Para guardar el archivo completo, compartilo con vos mismo — por correo, o a la app de
              archivos de tu teléfono.
            </Body>
            <View style={styles.actions}>
              <PrimaryButton
                label="Compartir el archivo"
                onPress={() => void shareExport(exportState.view)}
              />
              <SecondaryButton label="Volver a pedirlo" onPress={() => void requestExport()} />
            </View>
          </>
        ) : (
          <View style={styles.actions}>
            <PrimaryButton
              label={exportState.phase === "loading" ? "Armando el archivo…" : "Pedir mis datos"}
              disabled={exportState.phase === "loading"}
              onPress={() => void requestExport()}
            />
          </View>
        )}
      </Card>

      {/* ---------- Art. 16 — supresión ---------- */}
      <Card title="Eliminar mi cuenta">
        <Body>
          La supresión es un borrado con anonimización: tu nombre, tu teléfono y tu DNI quedan
          hasheados y tu cuenta sale del sistema. Ley 25.326, art. 16 (derecho de supresión).
        </Body>
        <Body>
          Los eventos sanitarios de tus mascotas se conservan como historial de salud del animal —
          ese historial lo acompaña aunque cambie de responsable. Dentro de esos eventos, el texto
          libre que escribiste vos se reemplaza por un aviso de contenido eliminado. Si querés que
          borremos también los registros sanitarios, pedínoslo: no invocamos ninguna obligación
          legal de conservación para negarte ese borrado.
        </Body>
        <Body>Es definitivo. No hay forma de deshacerlo ni de recuperar la cuenta después.</Body>

        {erase.phase === "failed" ? (
          <Callout tone="err">
            <Text style={styles.calloutText}>{erase.message}</Text>
          </Callout>
        ) : null}

        {erase.phase === "idle" ? (
          <View style={styles.actions}>
            <SecondaryButton
              label="Quiero eliminar mi cuenta"
              onPress={() => setErase({ phase: "confirming" })}
            />
          </View>
        ) : (
          <>
            <TextField
              label="Motivo"
              required
              multiline
              numberOfLines={3}
              maxLength={ERASURE_REASON_MAX_LENGTH}
              value={reason}
              onChangeText={setReason}
              placeholder="Ya no uso miMAR / me mudo a otra plataforma / …"
              editable={erase.phase !== "sending"}
            />
            <View style={styles.actions}>
              <PrimaryButton
                label={erase.phase === "sending" ? "Dando de baja…" : "Confirmar borrado"}
                tone="seal"
                disabled={!reasonUsable || erase.phase === "sending"}
                onPress={() => void confirmErase()}
              />
              <SecondaryButton
                label="Cancelar"
                disabled={erase.phase === "sending"}
                onPress={() => {
                  setReason("");
                  setErase({ phase: "idle" });
                }}
              />
            </View>
          </>
        )}
      </Card>

      {/* THE WEB LINK STAYS, AS A SECONDARY AFFORDANCE — the same shape
          `PASSWORD_RECOVERY_URL` took when `/recuperar` went native. It is not
          dead weight while it sits here: it is the only way to get a real
          `.json` file onto a device today, and a Play reviewer can still read
          the destination the Data safety form names. Delete it on the day this
          app can write a file, and not before. */}
      <Text style={styles.footnote}>
        También podés hacer todo esto desde la web, donde el export se descarga como archivo:
      </Text>
      <Text selectable style={styles.url}>
        {ACCOUNT_DELETION_URL}
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { gap: SPACE.sm, marginTop: SPACE.sm },
  calloutText: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.ink,
  },
  footnote: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.sm,
    color: COLORS.inkMuted,
    marginTop: SPACE.lg,
  },
  url: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.sm,
    color: COLORS.accent,
    marginTop: SPACE.xs,
  },
});
