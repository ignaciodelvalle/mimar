// One turno: what it is, the check-in QR, and the cancel.
//
// IT READS THE HUB, not a per-token endpoint — the instrument
// `TransferDetailScreen` established. The union of the three lists
// `/me/appointments` returns is exactly the set this caller is authorized to see:
// the server built them from `appointments.owner_user_id` and dropped every
// soft-deleted animal. So a token that is not in it is one this person may not
// read, and this screen can say so without a second round trip and without the
// server having to answer a question that would tell a stranger whether a token
// is real.
//
// THE CHECK-IN QR IS DRAWN FROM `canCheckIn` AND FROM NOTHING ELSE
// ---------------------------------------------------------------------------
// Not from `status`, not from a date compared against `Date.now()`. The flag is
// the server's clock against the slot's END, and it is the one thing on this
// screen where a wrong answer costs somebody something concrete: a phone running
// fast would hide the code from a person standing at the desk, and a phone
// running slow would offer a code for a turno that finished this morning.
//
// THE CODE UNDER THE QR IS NOT DECORATION. The web prints the token in mono
// under the image "si el escáner no lo lee, dictá el código de abajo", and that
// fallback matters more on a phone than in a browser: a cracked screen, a dark
// clinic, or a reader that does not exist yet (see below) all end with somebody
// reading the token out loud.
//
// A DECLARED DEBT THIS SCREEN CARRIES AND DOES NOT FIX
// ---------------------------------------------------------------------------
// The QR encodes `mimar://appointment/{token}`, which is what the web encodes,
// and `DEEP_LINK_MAP.appointment` records that this `appPath` NAMES NO SCREEN —
// it is the single member of `APP_PATH_NAMES_NO_SCREEN`. It is a placeholder
// payload for a front-desk reader that does not exist yet. Producing a different
// string here would be worse than the debt: the browser and the phone would print
// two different codes for one turno. See `turnos-view-model.ts`'s header.
//
// ONE PRIMARY ACTION, THE REST AS ROWS (pulido-avisos, the Viaje treatment)
// ---------------------------------------------------------------------------
// The screen used to stack a primary and five outline buttons. Now: the status
// is a Callout right under the title (what happened is said, not implied), the
// check-in QR when the server allows it, ONE primary — "Agregar al calendario"
// on a confirmed turno — the detail, and "Cancelar el turno" as a row that
// opens its confirmation. Cancelling still takes two taps, the second one in
// the seal red the web reserves for acts that end something.
//
// CANCELLING RE-READS ON EVERY FAILURE, ALWAYS
// ---------------------------------------------------------------------------
// There is no idempotency key and the endpoint asks for none. The writer's UPDATE
// is conditional on `status = 'confirmed'`, which REFUSES a replay rather than
// absorbing it — so a refusal after a timeout may mean this person's own first
// attempt landed, or that the clinic cancelled it first. Re-reading is the only
// thing that can tell them apart, which is why the error copy says "actualizá"
// rather than "volvé a intentar".

import * as Linking from "expo-linking";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { AppointmentStatusV1, MyAppointmentV1, MyAppointmentsV1 } from "@dim/contract/api";

import { apiFailureMessage } from "../api/client";
import { fetchMyAppointments, sendAppointmentCommand } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { CredentialQr } from "../credential/CredentialQr";
import { Body, Card, Loading, Row } from "../ui/components";
import { FONTS } from "../ui/fonts";
import {
  Callout,
  type CalloutTone,
  Eyebrow,
  ListRow,
  PrimaryButton,
  Screen,
  SecondaryButton,
  Title,
} from "../ui/kit";
import { COLORS, RADIUS, SPACE, TRACKING, TYPE } from "../ui/theme";

import {
  appointmentCalendarUrl,
  appointmentKindLabel,
  appointmentPriceLabel,
  appointmentProviderLabel,
  appointmentProviderPhone,
  appointmentServiceLabel,
  appointmentStatusLabel,
  appointmentWhenLabel,
  buildCancelAppointment,
  checkInQrValue,
  findAppointment,
} from "./turnos-view-model";

/** Rendered pixel size of the check-in QR. Matches the web's 180. */
const QR_SIZE = 180;

type ScreenState =
  | { phase: "loading" }
  | { phase: "ready"; appointment: MyAppointmentV1 }
  | { phase: "missing" }
  | { phase: "failed"; message: string };

type Notice = { tone: "ok" | "err"; message: string } | null;

export function TurnoDetailScreen({ appointmentToken }: { appointmentToken: string }) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    const result = await fetchMyAppointments(sessionPort);
    if (result.outcome !== "ok") {
      setState({
        phase: "failed",
        message: apiFailureMessage(result) ?? "No pudimos leer este turno.",
      });
      return;
    }
    const found = findAppointment(result.payload as MyAppointmentsV1, appointmentToken);
    setState(found === null ? { phase: "missing" } : { phase: "ready", appointment: found });
  }, [appointmentToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const cancel = useCallback(async () => {
    const built = buildCancelAppointment(appointmentToken);
    if (!built.ok) {
      setNotice({ tone: "err", message: built.message });
      return;
    }
    setBusy(true);
    setNotice(null);
    const result = await sendAppointmentCommand(sessionPort, built.input);
    setBusy(false);
    setConfirmingCancel(false);
    if (result.outcome !== "ok") {
      setNotice({
        tone: "err",
        message: apiFailureMessage(result) ?? "No pudimos leer este turno.",
      });
      // RE-READ ON FAILURE, ALWAYS. See the header: without an idempotency key a
      // refusal after a timeout may mean the first attempt landed.
      await load();
      return;
    }
    setNotice({
      tone: "ok",
      message: "Cancelaste el turno y el horario quedó liberado.",
    });
    await load();
  }, [appointmentToken, load]);

  if (state.phase === "loading") return <Loading label="Cargando el turno…" />;

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Turno</Title>
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load()} />
      </Screen>
    );
  }

  if (state.phase === "missing") {
    // NOT "no existe". This caller may simply not be the person who booked it —
    // a co-owner does not hold the other co-owner's turno — and the two are
    // deliberately indistinguishable from here.
    return (
      <Screen>
        <Title>Turno</Title>
        <Callout tone="neutral">
          <Body>
            No encontramos este turno en tu cuenta. Puede que ya no esté disponible o que lo haya
            reservado otra persona.
          </Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load()} />
      </Screen>
    );
  }

  const appointment = state.appointment;
  const { canCancel, canCheckIn } = appointment.capabilities;
  const kind = appointmentKindLabel(appointment);
  const phone = appointmentProviderPhone(appointment.provider);
  const calendarUrl = appointmentCalendarUrl(appointment);

  const status = statusCallout(appointment, notice !== null);

  return (
    <Screen>
      <View style={styles.head}>
        {kind !== null && <Eyebrow>{kind}</Eyebrow>}
        <Title>{appointmentServiceLabel(appointment)}</Title>
      </View>

      {/* THE STATE, described rather than the click reported, in ONE Callout.
          Drawn on every later visit too, which is the rule the web's cancelled
          callout follows: a confirmation that only exists in the frame after
          the tap is a confirmation somebody scrolling can miss. */}
      {status !== null && (
        <Callout tone={status.tone} title={appointmentStatusLabel(appointment.status)}>
          {status.body === null ? null : <Body>{status.body}</Body>}
        </Callout>
      )}

      {notice !== null && (
        <Callout tone={notice.tone}>
          <Body>{notice.message}</Body>
        </Callout>
      )}

      {/* THE SERVER'S FLAG AND NOTHING ELSE. See the header. First after the
          status, because the person who has it open at the desk is here for it. */}
      {canCheckIn && (
        <Card title="Check-in en la clínica">
          <Body>Mostrá este QR cuando llegues. Si el escáner no lo lee, dictá el código.</Body>
          <View style={styles.qrFrame}>
            <CredentialQr
              value={checkInQrValue(appointment.appointmentToken)}
              size={QR_SIZE}
              label={`Código de check-in del turno de ${appointment.pet.name}`}
            />
          </View>
          {/* `selectable` so the token can be copied as well as read aloud. */}
          <Text selectable style={styles.token}>
            {appointment.appointmentToken}
          </Text>
        </Card>
      )}

      {/* THE ONE PRIMARY. CONFIRMED ONLY: a cancelled or attended turno is not
          an event anybody should be adding to next week. Opens the person's own
          calendar app with the event prefilled — no permission, no silent
          write; see appointmentCalendarUrl for why this is not expo-calendar. */}
      {appointment.status === "confirmed" && calendarUrl !== null && (
        <PrimaryButton
          label="Agregar al calendario"
          onPress={() => void Linking.openURL(calendarUrl).catch(() => {})}
        />
      )}

      <Card title="Detalle del turno">
        <Row label="Mascota" value={appointment.pet.name} />
        <Row label="Prestador" value={appointmentProviderLabel(appointment.provider)} />
        <Row label="Fecha y hora" value={appointmentWhenLabel(appointment.startsAt)} />
        <Row label="Duración" value={`${appointment.durationMinutes} minutos`} />
        <Row label="Precio" value={appointmentPriceLabel(appointment.priceArs)} />
        {appointment.provider.kind === "organization" && appointment.provider.locality !== null && (
          <Row label="Localidad" value={appointment.provider.locality} />
        )}
        {phone !== null && <Row label="Teléfono" value={phone} />}
      </Card>

      {/* GATED ON THE SERVER FLAG, never on `status` and never on a date this
          device compared. Note it can be false while `canCheckIn` is true: that
          is a consultation in progress, and the two windows differ on purpose.
          A ROW, NOT A BUTTON: it is not what this screen is for, and the act it
          opens is the confirmation below, not the cancel itself. */}
      {canCancel &&
        (confirmingCancel ? (
          <Callout tone="warn" title="¿Cancelar el turno?">
            <View style={styles.confirm}>
              <Body>
                Al cancelar, el horario queda liberado para otra persona. Para volver a tenerlo
                habría que reservarlo de nuevo.
              </Body>
              <PrimaryButton
                tone="seal"
                label={busy ? "Cancelando…" : "Confirmar cancelación"}
                disabled={busy}
                onPress={() => void cancel()}
              />
              <SecondaryButton
                label="Volver"
                disabled={busy}
                onPress={() => setConfirmingCancel(false)}
              />
            </View>
          </Callout>
        ) : (
          <ListRow
            label="Cancelar el turno"
            caption="Libera el horario para otra persona. Te vamos a pedir que lo confirmes."
            onPress={busy ? undefined : () => setConfirmingCancel(true)}
          />
        ))}
    </Screen>
  );
}

/**
 * The status Callout: its tone, and the sentence under the status label.
 *
 * `cancelled_by_owner` DROPS ITS SENTENCE while a notice is up, because the
 * notice says the same fact in the frame after the tap ("Cancelaste el
 * turno…"). The status label stays: the screen always names the state.
 */
function statusCallout(
  appointment: MyAppointmentV1,
  noticeShown: boolean,
): { tone: CalloutTone; body: string | null } | null {
  const status: AppointmentStatusV1 = appointment.status;
  switch (status) {
    case "confirmed":
      return { tone: "ok", body: appointmentWhenLabel(appointment.startsAt) };
    case "attended":
      return {
        tone: "ok",
        body: `Asististe a este turno. El registro médico quedó guardado en la libreta de ${appointment.pet.name}.`,
      };
    case "cancelled_by_owner":
      return {
        tone: "neutral",
        body: noticeShown ? null : "Cancelaste este turno y el horario quedó liberado.",
      };
    case "cancelled_by_org":
      return {
        tone: "warn",
        body: "El prestador canceló este turno. Si lo necesitás, vas a tener que reservar otro.",
      };
    case "no_show":
      return { tone: "warn", body: null };
  }
}

const styles = StyleSheet.create({
  head: { gap: SPACE.xs },
  confirm: { gap: SPACE.sm },
  qrFrame: {
    alignSelf: "center",
    padding: SPACE.sm,
    borderRadius: RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    // TRUE WHITE, not the canvas. A scanner wants maximum contrast, and the
    // quiet zone around the modules is part of the symbol — the same reason
    // `CredentialQr` paints true black rather than the design system's ink.
    // Unlike that black (no token is that dark), true white already IS
    // `COLORS.surface` — reusing it changes no pixel.
    backgroundColor: COLORS.surface,
  },
  token: {
    alignSelf: "center",
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.lg,
    letterSpacing: TYPE.lg * TRACKING.wider,
    color: COLORS.ink,
  },
});
