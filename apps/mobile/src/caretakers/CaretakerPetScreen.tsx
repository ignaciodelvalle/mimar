// Cuidador temporal, from the TITULAR'S side, for one animal.
//
// It mirrors the web's two pieces on `/mis-mascotas/{token}`: the banner that
// says who is looking after the pet, and the controls beside it —
// `DesignateCaretakerForm` when nothing is running, `CaretakerGrantControls`
// when something is.
//
// ONE ARRANGEMENT AT A TIME, AND THAT IS THE DATABASE'S RULE, NOT THIS SCREEN'S.
// Two partial unique indexes allow at most one `pending` and at most one
// `accepted` grant per pet, so the form and the controls are never both useful.
// The screen reads which of the two states it is in from the server's row rather
// than from a local flag, and offers the form only when there is no row at all.
//
// THE TWO CONTROLS ARE DIFFERENT FACTS AND THE COPY KEEPS THEM APART:
//
//   · RETIRAR una invitación pendiente — nothing ever started. No ownership row
//     existed, no spine event is written, and the person loses nothing because
//     they never had anything.
//   · FINALIZAR un cuidado activo — a real arrangement ends, `caretaker_ended`
//     is appended with `outcome='revoked_by_owner'`, and another person's access
//     disappears without their consent. The titular has exactly that right; the
//     confirmation step is what keeps it from firing by accident.
//
// AND THE CONFIRMATION FOR THE SECOND ONE SAYS WHAT IT DOES NOT DO. Ending the
// grant ends ACCESS. The animal may still be at the caretaker's house, and a
// titular who reads "finalizar" as "get my pet back" has been misled by their own
// credential. The web's dialog says so in as many words; so does this one.
//
// NO IDEMPOTENCY KEY on any of the three, and the reflex to add one for `revoke`
// is right but the answer is no: a spine write travels there, and the endpoint
// still does not read the header, because `endCaretakerGrant` takes no
// `clientIdempotencyKey`. What protects a retry is a locked re-read that refuses
// unless the row is still `accepted`. So a timeout comes back as
// `caretaker_already_resolved`, and the only correct response is to RE-READ —
// which is what this screen does after every failure, and why its copy says
// "actualizá" rather than "volvé a intentar".

import { useCallback, useEffect, useState } from "react";
import { Share, StyleSheet, View } from "react-native";

import type { CaretakerCommandAckV1, MyCaretakerGrantV1 } from "@dim/contract/api";
import {
  CARETAKER_NOTE_MAX,
  type CaretakerCommandInput,
  type CaretakerCommandInputCode,
} from "@dim/contract/input";

import type { ApiResult } from "../api/client";
import { fetchMyCaretakerGrants, sendCaretakerCommand } from "../api/endpoints";
import { apiErrorMessage } from "../api/error-copy";
import { sessionPort } from "../auth/session-store";
import { caretakerGrantPageUrl } from "../config/api";
import { Body, Card, Loading, Row } from "../ui/components";
import { isoToDateInput } from "../ui/date-input";
import {
  Callout,
  DateField,
  PrimaryButton,
  Screen,
  SecondaryButton,
  TextField,
  Title,
} from "../ui/kit";
import { SPACE } from "../ui/theme";
import { useIsDirty } from "../ui/use-draft-dirty";
import { useDraftDiscardGuard } from "../ui/use-draft-discard-guard";
import { useScrollToError } from "../ui/use-scroll-to-error";

import {
  CARETAKER_STATE_MOVED_CODES,
  CARETAKER_WINDOW_DAYS,
  buildCancelCaretakerGrant,
  buildDesignateCaretaker,
  buildRevokeCaretakerGrant,
  caretakerCounterpartyLabel,
  caretakerDesignateRefusalMessage,
  caretakerPeriodLabel,
  caretakerStatusLabel,
  grantForPet,
  todayInAr,
} from "./caretakers-view-model";

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
      return "No pudimos leer el cuidado de esta mascota.";
  }
}

/**
 * One sentence per command, for the line above the card.
 *
 * EXHAUSTIVE OVER THE CONTRACT'S UNION on purpose, including the two commands
 * this screen never sends: a new command becomes a compile error here rather than
 * a blank line on a phone.
 */
function ackLabel(ack: CaretakerCommandAckV1): string {
  switch (ack.command) {
    case "designate":
      return ack.inviteeNeedsAccount === true
        ? "Invitación creada. Esa dirección todavía no tiene cuenta en miMAR, así que avisale vos."
        : "Invitación enviada. Le avisamos a esa persona.";
    case "cancel":
      return "Retiraste la invitación.";
    case "revoke":
      return "Finalizaste el cuidado. Esa persona ya no tiene acceso.";
    case "accept":
      return "Aceptaste el cuidado.";
    case "reject":
      return "Rechazaste la invitación.";
  }
}

type ScreenState =
  | { phase: "loading" }
  | { phase: "ready"; grant: MyCaretakerGrantV1 | null }
  | { phase: "failed"; message: string };

type Notice = { tone: "ok" | "err"; message: string } | null;

export function CaretakerPetScreen({
  publicToken,
  petName,
}: {
  publicToken: string;
  /** For the copy. `null` when the caller reached this screen by deep link. */
  petName: string | null;
}) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  // A REFUSAL moves the view, an "ok" notice does not: the refusal sits above
  // a form the person is at the bottom of, so without this it lands off-screen.
  const { anchorRef: errorAnchor, scrollRef } = useScrollToError(
    notice !== null && notice.tone === "err" ? notice.message : null,
  );

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    const result = await fetchMyCaretakerGrants(sessionPort);
    if (result.outcome !== "ok") {
      setState({ phase: "failed", message: failureMessage(result) });
      return;
    }
    setState({ phase: "ready", grant: grantForPet(result.payload, publicToken) });
  }, [publicToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (input: CaretakerCommandInput) => {
      setBusy(true);
      setNotice(null);
      const result = await sendCaretakerCommand(sessionPort, input);
      setBusy(false);
      setConfirmingEnd(false);
      if (result.outcome !== "ok") {
        // THE SCREEN'S OWN SENTENCE FOR TWO CODES, and only on the command that
        // can actually meet them from here (A3-documento-credencial-05,
        // A4-custodia-06). `caretaker_forbidden` on a `revoke` is a different
        // fact — you did not grant this one — and must keep the shared copy.
        const shared = failureMessage(result);
        setNotice({
          tone: "err",
          message:
            result.outcome === "api-error" && input.command === "designate"
              ? (caretakerDesignateRefusalMessage(result.code) ?? shared)
              : shared,
        });
        // RE-READ ONLY WHEN THE SERVER'S STATE MOVED (A4-custodia-04). `load()`
        // sets `phase: "loading"`, which UNMOUNTS `DesignateForm` and takes its
        // draft with it — so a titular who typed the neighbour's address, the
        // medication routine and a "Hasta" 200 days out read "Revisá las
        // fechas…" over an empty form, and had to type all of it again to fix
        // one day. The two codes below are the ones a re-read answers: something
        // else really did change and the screen must show what. Every other
        // refusal is about THIS submission and the form is what the person needs
        // in front of them.
        //
        // The `unreachable` case is deliberately in the second group even though
        // the write may have landed: a re-read has no network either, so it
        // would replace the send's message with a read failure and destroy the
        // draft on the way. The ack for a designation that in fact landed
        // arrives on the next open of this screen.
        if (result.outcome === "api-error" && CARETAKER_STATE_MOVED_CODES.has(result.code)) {
          await load();
        }
        return;
      }
      setNotice({ tone: "ok", message: ackLabel(result.payload) });
      await load();
    },
    [load],
  );

  const subject = petName ?? "esta mascota";

  if (state.phase === "loading") return <Loading label="Leyendo el cuidado…" />;

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Cuidador temporal</Title>
        {/* NOT "no hay ningún cuidado". A read that failed and an animal nobody
            is looking after are different facts, and saying the second over a
            server outage would invite a titular to designate a SECOND caretaker
            while one is already running. */}
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load()} />
      </Screen>
    );
  }

  return (
    <Screen keyboardAvoiding scrollRef={scrollRef}>
      <Title>Cuidador temporal</Title>

      {notice !== null && (
        <View ref={errorAnchor}>
          <Callout tone={notice.tone}>
            <Body>{notice.message}</Body>
          </Callout>
        </View>
      )}

      {state.grant === null ? (
        <DesignateForm
          publicToken={publicToken}
          subject={subject}
          busy={busy}
          onSubmit={(input) => void run(input)}
          onInvalid={(message) => setNotice({ tone: "err", message })}
        />
      ) : (
        <ExistingGrant
          grant={state.grant}
          subject={subject}
          busy={busy}
          confirming={confirmingEnd}
          onConfirm={() => setConfirmingEnd(true)}
          onBack={() => setConfirmingEnd(false)}
          onEnd={(input) => void run(input)}
        />
      )}
    </Screen>
  );
}

/**
 * Hand the invitation over by hand, through the OS sheet.
 *
 * BEST-EFFORT AND SILENT ON REFUSAL, the rule `SharesScreen` and `PrivacyScreen`
 * already follow: `Share.share` rejects when the person dismisses the sheet, and
 * a dismissal is not an error to report back to them.
 */
async function shareInvitation(grantToken: string, subject: string): Promise<void> {
  try {
    await Share.share({
      message: `Te invito a cuidar a ${subject} en miMAR: ${caretakerGrantPageUrl(grantToken)}`,
    });
  } catch {
    // Dismissed. Nothing to say.
  }
}

/**
 * The arrangement that exists, and the one lever the titular has over it.
 *
 * WHICH LEVER IS DECIDED BY `capabilities`, never by `status`. They happen to
 * agree today — `canCancel` is pending, `canRevoke` is accepted — and reading the
 * status instead would be this screen re-deriving a rule that also folds in
 * "did YOU grant this", which the payload never tells it.
 */
function ExistingGrant({
  grant,
  subject,
  busy,
  confirming,
  onConfirm,
  onBack,
  onEnd,
}: {
  grant: MyCaretakerGrantV1;
  subject: string;
  busy: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onBack: () => void;
  onEnd: (input: CaretakerCommandInput) => void;
}) {
  const { canCancel, canRevoke } = grant.capabilities;
  const counterparty = caretakerCounterpartyLabel(grant);
  const ending = canRevoke;
  // NOBODY HAS BEEN TOLD (A4-custodia-10). `counterpartyName === null` on a
  // pending invitation is the payload's way of saying the address has no
  // profile behind it, which is exactly when the native write sends no mail and
  // the ack says "avisale vos" — while giving the titular nothing to hand over.
  // An ACCEPTED grant is excluded on purpose: that person is already in, and a
  // live invitation link is not a thing to keep passing around.
  const needsHandOff = grant.status === "pending" && grant.counterpartyName === null;

  const built = ending
    ? buildRevokeCaretakerGrant(grant.pet.publicToken, grant.grantToken)
    : buildCancelCaretakerGrant(grant.pet.publicToken, grant.grantToken);

  return (
    <>
      <Card title={caretakerStatusLabel(grant.status)}>
        {counterparty !== null && <Body>{counterparty}</Body>}
        <Row label="Período" value={caretakerPeriodLabel(grant)} />
        {grant.note !== null && <Row label="Nota" value={grant.note} />}
        {/* THE SCOPE, from the server. Both halves, always: the titular has at
            least as much right to read what they handed over as the person who
            accepted it. */}
        <Row label="Qué puede hacer" value={grant.scopeSentence} />
      </Card>

      {needsHandOff && (
        <Card title="Todavía no le avisamos">
          {/* THE TENSE IS THE FIX (finding F10, review 2026-09-07). This card
              read "Esa dirección no tiene cuenta en miMAR" — a present-tense
              claim about somebody else's account, derived from a fact captured
              at DESIGNATION time. The proxy is exact then (the `handle_new_user`
              trigger makes `counterpartyName === null` ⟺ the invitee has no
              profile), and it never refreshes: `caretakerUserId` is written once
              and never backfilled, so the day that person signs up the card goes
              on saying they have no account — while `addressedToCaller` matches
              them by e-mail and the invitation is already sitting in their app.
              The titular then reads "no le mandamos nada" and chases somebody
              who is looking at the invitation.

              What is permanently true is what miMAR DID: no mail was sent, at
              designation time, because there was nobody to send it to. That is
              what the copy says now, and the rest is offered as the two
              possibilities the client cannot tell apart. */}
          <Body>
            Cuando la designaste, esa dirección no tenía cuenta en miMAR, así que no le mandamos
            nada. Si desde entonces se creó una cuenta con ese correo, la invitación ya le aparece
            en su app. Si no, pasale vos el link: al abrirlo puede crear su cuenta y aceptar el
            cuidado de {subject}.
          </Body>
          <SecondaryButton
            label="Compartir el link de la invitación"
            onPress={() => void shareInvitation(grant.grantToken, subject)}
          />
        </Card>
      )}

      {(canCancel || canRevoke) &&
        (confirming ? (
          <Callout tone="warn">
            {ending ? (
              <Body>
                Esa persona pierde el acceso a {subject} en este momento y deja de recibir los
                avisos. Si {subject} sigue en su casa, esto no la trae de vuelta: vas a tener que
                coordinar la devolución igual.
              </Body>
            ) : (
              <Body>
                La invitación se retira y el link deja de servir. Nunca tuvo acceso a {subject}, así
                que no pierde nada; si querés, después podés invitarla de nuevo.
              </Body>
            )}
            <PrimaryButton
              tone="seal"
              label={
                busy ? "Procesando…" : ending ? "Confirmar la finalización" : "Confirmar el retiro"
              }
              disabled={busy || !built.ok}
              onPress={() => built.ok && onEnd(built.input)}
            />
            <SecondaryButton label="Volver" disabled={busy} onPress={onBack} />
          </Callout>
        ) : (
          <View style={styles.actions}>
            <SecondaryButton
              label={ending ? "Finalizar el cuidado ahora" : "Retirar la invitación"}
              disabled={busy}
              onPress={onConfirm}
            />
          </View>
        ))}
    </>
  );
}

/**
 * The designation form.
 *
 * OFFERED WHENEVER NOTHING IS RUNNING, and refused by the server for a caller who
 * may not designate — a person-path holder whose ownership role is `caretaker`,
 * which is deny-list row `caretaker-sub-designation`. This payload carries no
 * flag for that, and a local guess would be a second copy of a rule that lives in
 * one place. The screen asks and renders `caretaker_forbidden` when the answer is
 * no, exactly as the transfer form does for its own narrower rule.
 *
 * THE DATES ARE ARGENTINE CALENDAR DAYS typed as `AAAA-MM-DD`, the same control
 * the asiento form uses, for the same reason: a native date picker would be a new
 * dependency and a second calendar. The contract refuses a day that does not
 * exist (`isRealArDay`) BEFORE the round trip, so `2026-02-31` gets a field
 * sentence here rather than a period that silently ends on the 3rd of March.
 */
function DesignateForm({
  publicToken,
  subject,
  busy,
  onSubmit,
  onInvalid,
}: {
  publicToken: string;
  subject: string;
  busy: boolean;
  onSubmit: (input: CaretakerCommandInput) => void;
  onInvalid: (message: string) => void;
}) {
  const [email, setEmail] = useState("");
  // Today in ARGENTINE time, computed rather than taken from the device's locale:
  // a phone that travels with its owner would otherwise offer "yesterday" from a
  // plane over the Atlantic, and the server would refuse a day nobody chose.
  // Pre-filled in the format the FIELD shows, not the wire's: `todayInAr`
  // speaks `AAAA-MM-DD` and the mask would read it as eight digits.
  const [startsAt, setStartsAt] = useState(() => isoToDateInput(todayInAr()));
  const [endsAt, setEndsAt] = useState("");
  const [note, setNote] = useState("");
  // WHICH field the refusal was about, for the red border (forms-F3). The code
  // the contract already returned picks the box; nothing new is validated here.
  // `DATE_INVALID` names both days, because the contract judges them together.
  const [invalidCode, setInvalidCode] = useState<CaretakerCommandInputCode | null>(null);
  const clearInvalid = () => setInvalidCode(null);

  // THE BACK GESTURE MAY NOT DISCARD AN INVITATION IN PROGRESS
  // (A2-alta-asentar-08). `startsAt` is PRE-FILLED with today, so a predicate
  // that compared against a blank form would call this screen dirty on mount
  // and ask the question of everybody who opened it; `useIsDirty` measures
  // against what this form actually started with, which is that pre-filled day.
  useDraftDiscardGuard(useIsDirty({ email, startsAt, endsAt, note }));

  const submit = useCallback(() => {
    // The CONTRACT's schema, run locally first, so a bad address or an impossible
    // day gets a field sentence instead of a round trip that answers
    // `invalid_request` with no field detail.
    const built = buildDesignateCaretaker({
      petPublicToken: publicToken,
      inviteeEmail: email,
      startsAt,
      endsAt,
      note,
    });
    if (!built.ok) {
      onInvalid(built.message);
      setInvalidCode(built.code);
      return;
    }
    setInvalidCode(null);
    onSubmit(built.input);
  }, [email, endsAt, note, onInvalid, onSubmit, publicToken, startsAt]);

  return (
    <>
      <Body>
        Le dejás {subject} a alguien de confianza por un tiempo. Puede cargar eventos médicos, notas
        y marcarla perdida o encontrada. Seguís siendo el titular y podés finalizar el cuidado
        cuando quieras, sin pedir permiso.
      </Body>

      <TextField
        accessibilityLabel="Correo de la persona"
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        editable={!busy}
        inputMode="email"
        invalid={invalidCode === "EMAIL_INVALID"}
        label="Correo de la persona"
        onChangeText={(value) => {
          setEmail(value);
          clearInvalid();
        }}
        placeholder="persona@ejemplo.com"
        required
        value={email}
      />

      {/* `DateField` and not a mono TextField asking for the wire format
          (forms-F1/F2): `keyboardType="numbers-and-punctuation"` is iOS-only,
          so Android opened QWERTY on both of these, and the field asked for
          `AAAA-MM-DD` — the format nobody in Argentina writes. The view-model
          converts before the contract judges. */}
      <DateField
        accessibilityLabel="Desde"
        editable={!busy}
        invalid={invalidCode === "DATE_INVALID"}
        label="Desde"
        onChangeText={(value) => {
          setStartsAt(value);
          clearInvalid();
        }}
        required
        value={startsAt}
      />

      <DateField
        accessibilityLabel="Hasta"
        editable={!busy}
        invalid={invalidCode === "DATE_INVALID"}
        label="Hasta"
        onChangeText={(value) => {
          setEndsAt(value);
          clearInvalid();
        }}
        required
        value={endsAt}
      />
      <Body>El período máximo de cuidado es de {CARETAKER_WINDOW_DAYS} días.</Body>

      <TextField
        accessibilityLabel="Nota para quien cuida"
        editable={!busy}
        invalid={invalidCode === "NOTE_TOO_LONG"}
        label="Nota (opcional)"
        maxLength={CARETAKER_NOTE_MAX}
        multiline
        onChangeText={(value) => {
          setNote(value);
          clearInvalid();
        }}
        placeholder="Rutina, medicación, lo que necesite saber"
        value={note}
      />

      <PrimaryButton
        label={busy ? "Enviando…" : "Invitar como cuidador/a"}
        disabled={busy || email.trim().length === 0 || endsAt.trim().length === 0}
        onPress={submit}
      />
    </>
  );
}

const styles = StyleSheet.create({
  actions: { gap: SPACE.sm, marginTop: SPACE.md },
});
