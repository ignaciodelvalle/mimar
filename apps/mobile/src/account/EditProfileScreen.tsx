// EDITAR MIS DATOS — the person's own name, phone, vet and emergency contact.
//
// WHY THE FOUR CONTACT FIELDS ARE HERE AND NOT ONLY ON THE PET
// ---------------------------------------------------------------------------
// A tester who opens their animal's "Editar" screen finds an emergency-contact
// block already — but that one is the pet-level OVERRIDE, and its own form says
// so: cleared, it falls back to "the account default". Until this screen
// existed, the phone had no way to set that default, so the fallback pointed at
// a value only a browser could write. Two pets meant typing the same vet twice.
//
// WHAT IS ABSENT, AND WHY EACH ONE IS
// ---------------------------------------------------------------------------
//   · THE AVATAR. It needs an image picker, which needs a native module, which
//     needs an EAS build — the pipeline the board rules out. The endpoint does
//     not carry an avatar URL either, deliberately: a payload holding one no
//     client can change would only be there to draw a control that cannot work.
//   · EMAIL, DNI, JURISDICTION, ROLE. None of them is editable on the web's own
//     form, and `GET /api/v1/me` withholds all four on purpose. This screen does
//     not get to be the place they leak onto a device.
//
// THE PHONE FORMAT IS A WARNING AND NOT A REFUSAL, which is the web's decision
// and the server's: `update-profile.ts` states it — "Older landlines, satellite
// phones, and foreign numbers all save without error." A native form that
// refused what the server accepts would be inventing a rule on behalf of
// somebody in Salta with a landline. So the hint is soft, the save is not
// blocked, and the copy matches `PhoneFormatWarning` on the web.
//
// CLEARING IS EXPLICIT AND THE THREE-WAY RULE SURVIVES THE ROUND TRIP. The
// server treats an omitted key as "leave it" and `""` as "clear it". This form
// renders all six fields, so it always sends all six — which means emptying a
// field really does clear it, and there is no case where a field this screen did
// not show gets erased by a save.

import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { MyProfileV1 } from "@dim/contract/api";
import {
  CONTACT_NAME_MAX_LENGTH,
  CONTACT_PHONE_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MIN_LENGTH,
} from "@dim/contract/input";

import type { ApiResult } from "../api/client";
import { fetchMyProfile, saveMyProfile } from "../api/endpoints";
import { apiErrorMessage } from "../api/error-copy";
import { sessionPort } from "../auth/session-store";
import { Body, Card, Loading, StaleNotice } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { Callout, PrimaryButton, Screen, SecondaryButton, TextField, Title } from "../ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../ui/reload-state";
import { COLORS, LEADING, SPACE, TYPE } from "../ui/theme";
import { sameDraft } from "../ui/use-draft-dirty";
import { useDraftDiscardGuard } from "../ui/use-draft-discard-guard";
import { useReturnKeyChain } from "../ui/use-return-key-chain";

import { type ProfileDraft, draftFrom, looksLikeArPhone, toEditInput } from "./profile-draft";

/**
 * One sentence per failure arm. No arm falls through to a generic shrug, and
 * none of them quotes anything the server sent.
 */
function failureMessage(result: ApiResult<unknown>): string {
  switch (result.outcome) {
    case "api-error":
      return apiErrorMessage(result.code);
    case "unsupported-version":
      return "Esta versión de la app no puede leer esta pantalla. Actualizá la app.";
    case "malformed":
      return "La respuesta del servidor no se pudo leer.";
    case "unreachable":
      return "No pudimos conectarnos. Revisá tu conexión.";
    default:
      return "No pudimos abrir tus datos.";
  }
}

type ScreenState =
  | { phase: "loading" }
  | ReadyState<MyProfileV1>
  | { phase: "failed"; message: string };

/** What just happened, for the line above the form. */
type Notice = { tone: "ok" | "err"; message: string } | null;

function PhoneHint({ value }: { value: string }) {
  if (value.trim().length === 0 || looksLikeArPhone(value)) return null;
  return (
    <Text style={styles.hint}>
      Formato inusual para Argentina — lo guardamos igual, revisalo si querés.
    </Text>
  );
}

export function EditProfileScreen() {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  // WHAT THE SERVER HAS, WHEN THE RE-READ COULD NOT CONFIRM IT (finding F1,
  // review 2026-09-07). See the `dirty` computation below for the whole story;
  // `null` means "the payload on screen is the authority", which it is on every
  // load that landed.
  const savedBaseline = useRef<ProfileDraft | null>(null);

  const load = useCallback(async (mode: "initial" | "refresh" = "initial") => {
    // A RE-READ DOES NOT BLANK THE FORM (S-2). `load` runs again after every
    // landed save, and setting `loading` there replaced the six filled fields
    // with a spinner for the length of a round trip — on a screen whose save had
    // just succeeded.
    if (mode === "initial") setState({ phase: "loading" });
    const result = await fetchMyProfile(sessionPort);
    if (result.outcome === "ok") {
      // THE DRAFT IS SEEDED FROM THE SERVER ON EVERY LOAD, including the re-read
      // after a save: the writer trims `displayName`, so the field has to end up
      // saying what was actually stored rather than what was typed.
      setDraft(draftFrom(result.payload as MyProfileV1));
      setState(loaded(result.payload as MyProfileV1));
      // A LANDED READ RETIRES THE LATCH. The payload just confirmed what the
      // server holds — including the trim the writer applied — so it is a better
      // baseline than the values this screen posted, and keeping the latch would
      // make the trim itself read as an unsaved edit.
      savedBaseline.current = null;
      return;
    }
    // AND A FAILED RE-READ DOES NOT DELETE IT EITHER. The save LANDED — the
    // server has the new values — so a full-screen "no pudimos abrir tus datos"
    // over it reads as if the save had failed, which is the opposite of what
    // happened.
    setState((current) => reloadFailed(current, result, failureMessage(result)));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (submitted: ProfileDraft) => {
      setBusy(true);
      setNotice(null);
      const result = await saveMyProfile(sessionPort, toEditInput(submitted));
      setBusy(false);
      if (result.outcome !== "ok") {
        setNotice({ tone: "err", message: failureMessage(result) });
        return;
      }
      // THE WRITE LANDED, SO THE FORM IS CLEAN — whatever the re-read then does.
      // Latched BEFORE the reload precisely because the reload is what may fail.
      savedBaseline.current = submitted;
      setNotice({ tone: "ok", message: "Tus datos fueron actualizados." });
      // Re-read rather than trust the draft: see `load`.
      await load("refresh");
    },
    [load],
  );

  // Return-key advance across the six single-line fields (QOL 2026-09-01).
  // Above the early returns — hooks may not sit below a conditional return.
  const chain = useReturnKeyChain(6);

  // THE BACK GESTURE MAY NOT DISCARD SIX EDITED FIELDS (A2-alta-asentar-08).
  //
  // THE BASELINE IS THE SERVER'S OWN ANSWER, not a value captured at mount, and
  // on this screen that is strictly better than a ref: `load` re-seeds the draft
  // from the payload after every landed save (the writer trims `displayName`),
  // so comparing against the payload makes "dirty" mean "differs from what the
  // server has" — it goes back to clean when a save lands, and it survives a
  // re-read that changed nothing.
  //
  // …EXCEPT WHEN THE RE-READ IS THE THING THAT FAILED (finding F1, review
  // 2026-09-07), WHICH IS THE ONE CASE THE PAYLOAD CANNOT ANSWER. `reloadFailed`
  // keeps the PRE-SAVE payload on an outage-shaped failure — that is its whole
  // job, and it is right — so on one bar of signal the sequence is: type a name,
  // tap Guardar, the write LANDS, the re-read comes back unreachable, and the
  // payload this comparison reads is still the old one. Without the latch the
  // back gesture would then be blocked by "Lo que escribiste hasta acá se
  // pierde." over a value that is already on the server: the H1 class this guard
  // exists to prevent, pointed at the person who did everything right.
  //
  // So the baseline is "the last thing the server confirmed, or failing that the
  // last thing it accepted". The latch is retired by the next landed read.
  const dirty =
    draft !== null &&
    state.phase === "ready" &&
    !sameDraft(savedBaseline.current ?? draftFrom(state.view), draft);
  useDraftDiscardGuard(dirty);

  if (state.phase === "loading") return <Loading label="Abriendo tus datos…" />;

  if (state.phase === "failed" || draft === null) {
    return (
      <Screen>
        <Title>Mis datos</Title>
        <Callout tone="err">
          <Text style={styles.calloutText}>
            {state.phase === "failed" ? state.message : "No pudimos abrir tus datos."}
          </Text>
        </Callout>
        <View style={styles.actions}>
          <SecondaryButton label="Reintentar" onPress={() => void load()} />
        </View>
      </Screen>
    );
  }

  const set = (field: keyof ProfileDraft) => (value: string) =>
    setDraft((current) => (current === null ? current : { ...current, [field]: value }));

  const nameLength = draft.displayName.trim().length;
  const nameUsable = nameLength >= DISPLAY_NAME_MIN_LENGTH && nameLength <= DISPLAY_NAME_MAX_LENGTH;

  return (
    // `keyboardAvoiding` like every sibling form (forms-M1): this screen is six
    // single-line fields down a scroll, and without it the keyboard covered the
    // one being typed into — the same defect its siblings fixed and it did not.
    <Screen keyboardAvoiding>
      <Title>Mis datos</Title>

      {notice === null ? null : (
        <Callout tone={notice.tone === "ok" ? "ok" : "err"}>
          <Text style={styles.calloutText}>{notice.message}</Text>
        </Callout>
      )}

      {state.phase === "ready" && state.staleFailure !== null ? (
        <StaleNotice message={state.staleFailure} onRetry={() => void load("refresh")} />
      ) : null}

      <Card title="Cómo te mostramos">
        <TextField
          {...chain(0)}
          label="Nombre"
          required
          value={draft.displayName}
          onChangeText={set("displayName")}
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          placeholder="Tu nombre o apodo"
          editable={!busy}
        />
        {nameUsable ? null : (
          <Text style={styles.hint}>
            El nombre tiene que tener al menos {DISPLAY_NAME_MIN_LENGTH} caracteres.
          </Text>
        )}
        <TextField
          {...chain(1)}
          label="Teléfono"
          value={draft.phone}
          onChangeText={set("phone")}
          maxLength={CONTACT_PHONE_MAX_LENGTH}
          keyboardType="phone-pad"
          placeholder="+54 9 11 1234-5678"
          editable={!busy}
        />
        <PhoneHint value={draft.phone} />
      </Card>

      <Card title="A quién llamar">
        <Body>
          Estos son tus contactos por defecto. Cada mascota puede tener los suyos; si los dejás
          vacíos en la mascota, se usan estos.
        </Body>
        <TextField
          {...chain(2)}
          label="Veterinaria de cabecera"
          value={draft.preferredVetName}
          onChangeText={set("preferredVetName")}
          maxLength={CONTACT_NAME_MAX_LENGTH}
          editable={!busy}
        />
        <TextField
          {...chain(3)}
          label="Teléfono de la veterinaria"
          value={draft.preferredVetPhone}
          onChangeText={set("preferredVetPhone")}
          maxLength={CONTACT_PHONE_MAX_LENGTH}
          keyboardType="phone-pad"
          editable={!busy}
        />
        <PhoneHint value={draft.preferredVetPhone} />
        <TextField
          {...chain(4)}
          label="Contacto de emergencia"
          value={draft.emergencyContactName}
          onChangeText={set("emergencyContactName")}
          maxLength={CONTACT_NAME_MAX_LENGTH}
          editable={!busy}
        />
        <TextField
          {...chain(5)}
          label="Teléfono de emergencia"
          value={draft.emergencyContactPhone}
          onChangeText={set("emergencyContactPhone")}
          maxLength={CONTACT_PHONE_MAX_LENGTH}
          keyboardType="phone-pad"
          editable={!busy}
        />
        <PhoneHint value={draft.emergencyContactPhone} />
      </Card>

      <View style={styles.actions}>
        <PrimaryButton
          label={busy ? "Guardando…" : "Guardar cambios"}
          disabled={busy || !nameUsable}
          onPress={() => void save(draft)}
        />
      </View>

      <Text style={styles.footnote}>
        La foto de perfil, el correo y tu DNI se cambian desde la web. Esta pantalla edita sólo lo
        que ves acá.
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
  hint: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.sm,
    color: COLORS.inkMuted,
    marginTop: -SPACE.xs,
  },
  footnote: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.sm,
    color: COLORS.inkMuted,
    marginTop: SPACE.lg,
  },
});
