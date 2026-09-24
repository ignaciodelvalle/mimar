// MIS TURNOS — everything this person has booked, in the web's three sections.
//
// A TOP-LEVEL SCREEN, beside `/mascotas` rather than under a pet, and the reason
// is the question rather than the data: every row names an animal, but somebody
// opening this is asking "what do I have booked", across all of them, ordered by
// time. Per-pet would answer a question nobody asked and would lose the ordering.
//
// It also lists turnos for animals this person does not own. `bookSlotAction`
// accepts any active ownership role, so a foster or a co-owner books under their
// own id; the turno is theirs even when the animal is not.
//
// THE SECTIONS ARE THE SERVER'S, NOT A FILTER THIS FILE APPLIES. Which bucket a
// row is in is a function of the server's clock against the slot, and a phone
// that split a flat list itself would file a turno by a device clock — see
// `turnos-view-model.ts`'s header for what that costs in each direction.
//
// BUSCAR IS NOW HERE, AND THIS HEADER USED TO SAY THE OPPOSITE. It read "what is
// not here: buscar y reservar … an empty state that reads 'reservá tu primer
// turno' with no way to reserve one is a promise the app cannot keep", and the
// empty state pointed at mimar.com.ar. Both were right while the search did not
// exist; the promise is keepable now, so the button is the primary action of this
// screen and the web link is gone rather than left as a second way to do one
// thing.
//
// THE ENTRY POINT IS HERE AND NOT ON `/mascotas`. Every other top-level feature
// of this app is reached from that screen's footer, and a "Buscar turno" row
// there would be a fourth. It is not one, because the question this button
// answers is asked HERE: somebody who opens Mis turnos and does not find the one
// they need is exactly the person looking for it, and the empty state's own
// sentence is the strongest place a control can sit.

import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";

import type { MyAppointmentV1, MyAppointmentsV1 } from "@dim/contract/api";

import type { ApiResult } from "../api/client";
import { fetchMyAppointments } from "../api/endpoints";
import { apiErrorMessage } from "../api/error-copy";
import { sessionPort } from "../auth/session-store";
import { Body, EmptyState, StaleNotice } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { Callout, Eyebrow, PrimaryButton, Screen, SecondaryButton, Title } from "../ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../ui/reload-state";
import { ListSkeleton } from "../ui/skeleton";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TRACKING, TYPE } from "../ui/theme";
import { useReconnect } from "../ui/use-reconnect";

import {
  appointmentProviderLabel,
  appointmentServiceLabel,
  appointmentShortWhenLabel,
  appointmentStatusLabel,
  appointmentsTotalLabel,
  emptyPastLabel,
  emptyUpcomingLabel,
} from "./turnos-view-model";

/** One sentence per failure arm. No arm falls through to a generic shrug. */
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
      return "No pudimos leer tus turnos.";
  }
}

type ScreenState =
  | { phase: "loading" }
  | ReadyState<MyAppointmentsV1>
  | { phase: "failed"; message: string };

export function TurnosScreen({
  onOpen,
  onSearch,
}: {
  onOpen: (appointmentToken: string) => void;
  onSearch: () => void;
}) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });

  // Pull-to-refresh (QOL 2026-09-01): the shared Screen carried the prop all
  // along and /mascotas + notificaciones already used it — these lists were
  // the odd ones out. A refresh keeps the list on screen instead of blanking
  // to the loading phase; only the very first load does that.
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (mode: "initial" | "refresh" = "initial") => {
    if (mode === "refresh") setRefreshing(true);
    else setState({ phase: "loading" });
    const result = await fetchMyAppointments(sessionPort);
    if (mode === "refresh") setRefreshing(false);
    if (result.outcome === "ok") {
      setState(loaded(result.payload));
      return;
    }
    // KEEPING WHAT IS ON SCREEN (S-2). A turno is something a person physically
    // attends: deleting the list because a re-read failed is how somebody stops
    // being able to check the time of the appointment they are on their way to.
    setState((current) => reloadFailed(current, result, failureMessage(result)));
  }, []);

  // ON FOCUS, NOT ONLY ON MOUNT (native QA batch 2, C1). Booking pushes
  // `turnos/buscar` on top of this screen; popping back does not remount it, so
  // a plain mount effect left the list showing the count from before the
  // reservation — the person had just booked a turno the screen said they did
  // not have. Same fix and same reasoning as `LibretaScreen`, which grew a write
  // on top of it for the same reason.
  //
  // THE RETURN IS A "refresh" AND NOT AN "initial" READ, and that distinction is
  // the whole difference between a fix and an annoyance: `initial` sets
  // `phase: "loading"`, which would blank the list to a skeleton every single
  // time somebody comes back from a detail screen. `refresh` keeps the rows on
  // screen and shows the pull-to-refresh spinner instead. The FIRST appearance
  // still takes the loading phase, because there is nothing yet to keep.
  const hasLoaded = useRef(false);
  useFocusEffect(
    useCallback(() => {
      void load(hasLoaded.current ? "refresh" : "initial");
      hasLoaded.current = true;
    }, [load]),
  );

  // WHEN THE NETWORK COMES BACK, TRY AGAIN (B-05, the other half of S-2). Keeping
  // the last good payload stops a dead spot from deleting the list; this stops
  // the list sitting stale beside an offline banner that has already cleared
  // itself. A `refresh`, so nothing on screen moves while it happens.
  useReconnect(() => void load("refresh"));

  const refresher = (
    <RefreshControl
      colors={[COLORS.accent]}
      onRefresh={() => void load("refresh")}
      refreshing={refreshing}
      tintColor={COLORS.accent}
    />
  );

  if (state.phase === "loading")
    return (
      <Screen>
        <ListSkeleton rows={3} label="Cargando tus turnos…" />
      </Screen>
    );

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Mis turnos</Title>
        {/* NOT an empty list. A read that failed and a person with no turnos are
            different facts, and "no tenés turnos" over a server outage is how
            somebody misses an appointment they have to physically attend. */}
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load()} />
      </Screen>
    );
  }

  const { upcoming, past, cancelled } = state.view;

  return (
    <Screen refreshControl={refresher}>
      <Title>Mis turnos</Title>
      {/* The count comes from the SAME three arrays rendered below, by
          construction — see the view-model for the web bug that rule exists for. */}
      <Body>{appointmentsTotalLabel(state.view)}</Body>

      {state.staleFailure === null ? null : (
        <StaleNotice message={state.staleFailure} onRetry={() => void load("refresh")} />
      )}

      {/* THE PRIMARY ACTION OF THIS SCREEN, above the sections rather than under
          them: a person with a long history still opens this to book the next
          one, and a control that has to be scrolled past three headings to reach
          is a control that reads as absent. */}
      <PrimaryButton label="Buscar un turno" onPress={onSearch} />

      <View style={styles.section}>
        <Eyebrow>Próximos</Eyebrow>
        {upcoming.length === 0 ? (
          <EmptyState
            headline={emptyUpcomingLabel()}
            // NAMES THE BUTTON THAT IS ON THIS SCREEN. It used to say "por ahora
            // los turnos se reservan desde mimar.com.ar", which was the honest
            // sentence while there was nothing to tap; pointing somebody at a
            // browser that does not share their session is not, once there is.
            body="Buscá un turno para tu mascota y reservalo desde acá."
          />
        ) : (
          upcoming.map((appointment) => (
            <TurnoRow
              key={appointment.appointmentToken}
              appointment={appointment}
              onOpen={onOpen}
            />
          ))
        )}
      </View>

      {/* Drawn only when it has rows — an empty "Pasados" above nothing is
          furniture, which is the rule the transfers hub follows for its history. */}
      {past.length > 0 && (
        <View style={styles.section}>
          <Eyebrow>Pasados</Eyebrow>
          {past.map((appointment) => (
            <TurnoRow
              key={appointment.appointmentToken}
              appointment={appointment}
              onOpen={onOpen}
            />
          ))}
        </View>
      )}

      {/* Same rule. A person with no cancellations should not be shown a heading
          that exists to hold them. */}
      {cancelled.length > 0 && (
        <View style={styles.section}>
          <Eyebrow>Cancelados</Eyebrow>
          {cancelled.map((appointment) => (
            <TurnoRow
              key={appointment.appointmentToken}
              appointment={appointment}
              onOpen={onOpen}
            />
          ))}
        </View>
      )}

      {/* The one place the empty-past sentence is worth saying, and only when
          there is something else on the screen to give it context. */}
      {past.length === 0 && upcoming.length > 0 && <Body>{emptyPastLabel()}</Body>}
    </Screen>
  );
}

/**
 * One turno, as a row.
 *
 * The whole row is the target rather than a "Ver" link at its end, because a
 * phone's touch target should be the thing you are looking at.
 * `accessibilityRole="button"` with a composed label, so a screen reader
 * announces the service, the animal, when it is and its state as one sentence
 * instead of reading four fragments.
 */
function TurnoRow({
  appointment,
  onOpen,
}: {
  appointment: MyAppointmentV1;
  onOpen: (appointmentToken: string) => void;
}) {
  const service = appointmentServiceLabel(appointment);
  const when = appointmentShortWhenLabel(appointment.startsAt);
  const provider = appointmentProviderLabel(appointment.provider);
  const status = appointmentStatusLabel(appointment.status);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[service, appointment.pet.name, when, status].join(". ")}
      onPress={() => onOpen(appointment.appointmentToken)}
      style={styles.row}
    >
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle}>{service}</Text>
        <Text style={styles.rowMeta}>{appointment.pet.name}</Text>
        <Text style={styles.rowMeta}>{when}</Text>
        <Text style={styles.rowMeta}>{provider}</Text>
      </View>
      <Text style={styles.rowBadge}>{status}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { gap: SPACE.sm, marginTop: SPACE.lg },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACE.sm,
    minHeight: TOUCH_TARGET,
    paddingVertical: SPACE.sm,
    paddingHorizontal: SPACE.md,
    borderRadius: RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  rowMain: { flex: 1, gap: SPACE.xs / 2 },
  rowTitle: {
    fontFamily: FONTS.serif,
    fontSize: TYPE.lg,
    lineHeight: TYPE.lg * LEADING.sm,
    color: COLORS.ink,
  },
  rowMeta: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.md,
    color: COLORS.inkMuted,
  },
  rowBadge: {
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * TRACKING.wider,
    textTransform: "uppercase",
    color: COLORS.inkMuted,
    flexShrink: 0,
  },
});
