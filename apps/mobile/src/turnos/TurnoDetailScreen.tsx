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

import type { MyAppointmentV1, MyAppointmentsV1 } from "@dim/contract/api";

import type { ApiResult } from "../api/client";
import { fetchMyAppointments, sendAppointmentCommand } from "../api/endpoints";
import { apiErrorMessage } from "../api/error-copy";
import { sessionPort } from "../auth/session-store";
import { CredentialQr } from "../credential/CredentialQr";
import { Body, Card, Loading, Row } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { Callout, PrimaryButton, Screen, SecondaryButton, Title } from "../ui/kit";
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
      return "No pudimos leer este turno.";
  }
}

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
      setState({ phase: "failed", message: failureMessage(result) });
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
      setNotice({ tone: "err", message: failureMessage(result) });
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
        <Card>
          <Body>
            No encontramos este turno en tu cuenta. Puede que ya no esté disponible o que lo haya
            reservado otra persona.
          </Body>
        </Card>
        <SecondaryButton label="Reintentar" onPress={() => void load()} />
      </Screen>
    );
  }

  const appointment = state.appointment;
  const { canCancel, canCheckIn } = appointment.capabilities;
  const kind = appointmentKindLabel(appointment);
  const phone = appointmentProviderPhone(appointment.provider);
  const calendarUrl = appointmentCalendarUrl(appointment);

  return (
    <Screen>
      <Title>{appointmentServiceLabel(appointment)}</Title>
      <Body>{appointmentStatusLabel(appointment.status)}</Body>

      {notice !== null && (
        <Callout tone={notice.tone}>
          <Body>{notice.message}</Body>
        </Callout>
      )}

      {/* THE STATE, described rather than the click reported. Drawn on every
          later visit too, which is the rule the web's cancelled callout follows:
          a confirmation that only exists in the frame after the tap is a
          confirmation somebody scrolling can miss. */}
      {appointment.status === "cancelled_by_owner" && notice === null && (
        <Callout tone="neutral">
          <Body>Cancelaste este turno y el horario quedó liberado.</Body>
        </Callout>
      )}
      {appointment.status === "cancelled_by_org" && (
        <Callout tone="warn">
          <Body>
            El prestador canceló este turno. Si lo necesitás, vas a tener que reservar otro.
          </Body>
        </Callout>
      )}

      <Card title="Detalle del turno">
        <Row label="Mascota" value={appointment.pet.name} />
        {kind !== null && <Row label="Tipo de servicio" value={kind} />}
        <Row label="Prestador" value={appointmentProviderLabel(appointment.provider)} />
        <Row label="Fecha y hora" value={appointmentWhenLabel(appointment.startsAt)} />
        <Row label="Duración" value={`${appointment.durationMinutes} minutos`} />
        <Row label="Precio" value={appointmentPriceLabel(appointment.priceArs)} />
        {appointment.provider.kind === "organization" && appointment.provider.locality !== null && (
          <Row label="Localidad" value={appointment.provider.locality} />
        )}
        {phone !== null && <Row label="Teléfono" value={phone} />}
      </Card>

      {/* CONFIRMED ONLY: a cancelled or attended turno is not an event anybody
          should be adding to next week. Opens the person's own calendar app
          with the event prefilled — no permission, no silent write; see
          appointmentCalendarUrl for why this is not expo-calendar. */}
      {appointment.status === "confirmed" && calendarUrl !== null && (
        <SecondaryButton
          label="Agregar al calendario"
          onPress={() => void Linking.openURL(calendarUrl).catch(() => {})}
        />
      )}

      {/* THE SERVER'S FLAG AND NOTHING ELSE. See the header. */}
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

      {appointment.status === "attended" && (
        <Callout tone="ok">
          <Body>
            Asististe a este turno. El registro médico quedó guardado en la libreta de{" "}
            {appointment.pet.name}.
          </Body>
        </Callout>
      )}

      {/* GATED ON THE SERVER FLAG, never on `status` and never on a date this
          device compared. Note it can be false while `canCheckIn` is true: that
          is a consultation in progress, and the two windows differ on purpose. */}
      {canCancel && (
        <View style={styles.actions}>
          {confirmingCancel ? (
            <Callout tone="warn">
              <Body>
                Al cancelar, el horario queda liberado para otra persona. Para volver a tenerlo
                habría que reservarlo de nuevo.
              </Body>
              <PrimaryButton
                label={busy ? "Cancelando…" : "Sí, cancelar el turno"}
                disabled={busy}
                onPress={() => void cancel()}
              />
              <SecondaryButton
                label="No, volver"
                disabled={busy}
                onPress={() => setConfirmingCancel(false)}
              />
            </Callout>
          ) : (
            <SecondaryButton
              label="Cancelar el turno"
              disabled={busy}
              onPress={() => setConfirmingCancel(true)}
            />
          )}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { gap: SPACE.sm, marginTop: SPACE.md },
  qrFrame: {
    alignSelf: "center",
    padding: SPACE.sm,
    borderRadius: RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    // TRUE WHITE, not the canvas. A scanner wants maximum contrast, and the
    // quiet zone around the modules is part of the symbol — the same reason
    // `CredentialQr` paints true black rather than the design system's ink.
    backgroundColor: "#ffffff",
  },
  token: {
    alignSelf: "center",
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.lg,
    letterSpacing: TYPE.lg * TRACKING.wider,
    color: COLORS.ink,
  },
});
