// RESERVAR — one offering's slot grid, the animal picker, and the write.
//
// ONE SCREEN FOR WHAT THE WEB SPLITS ACROSS TWO PAGES
// ---------------------------------------------------------------------------
// The browser draws the grid at `/turnos/buscar/{offering}` and the pet picker at
// `.../reservar/{slotId}`, which is a second page and a second round trip inside a
// two-tap flow. The read here carries both, because the screen cannot honestly
// offer a time to somebody with no bookable animal — so it has to know about the
// animals before it draws the grid, not after.
//
// EVERY AFFORDANCE IS THE SERVER'S ANSWER AND NONE IS DERIVED HERE
// ---------------------------------------------------------------------------
//   · Which slots exist — the read already dropped the full, the cancelled, the
//     past and the ones whose offering is not approved.
//   · `pets[].canBook` — the rule behind it is ONE confirmed appointment per
//     (pet, offering), re-checked inside the booking transaction and backed by a
//     partial unique index. It is invisible in a slot grid, and a screen that
//     derived eligibility from the slots alone would draw a button the write
//     throws away. The animal is drawn DISABLED with its reason rather than
//     hidden: "Lola ya tiene un turno en este servicio" is information, and a
//     silently missing animal reads as a bug.
//
// AFTER A FAILED WRITE THIS SCREEN RE-READS AND NEVER RE-SENDS. `bookSlotWriter`
// takes no idempotency key: it holds a `pg_advisory_xact_lock` on the slot and two
// partial unique indexes, and those REFUSE a replay rather than absorbing one. So
// a refusal after a timeout is indistinguishable from somebody else taking the
// last place, and the only honest move is to look again.

import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { BookableOfferingDetailV1, BookablePetV1, BookableSlotV1 } from "@dim/contract/api";

import type { ApiResult } from "../api/client";
import { fetchBookableOffering, sendAppointmentCommand } from "../api/endpoints";
import { apiErrorMessage } from "../api/error-copy";
import { sessionPort } from "../auth/session-store";
import { Body, EmptyState, Loading } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { hapticSuccess } from "../ui/haptics";
import { Callout, Eyebrow, PrimaryButton, Screen, SecondaryButton, Title } from "../ui/kit";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TYPE } from "../ui/theme";

import {
  buildBookSlot,
  groupSlotsByDay,
  noBookablePetsLabel,
  offeringAvailabilityLabel,
  offeringKindLabel,
  offeringMetaLabel,
  offeringTitle,
  petChoiceLabel,
  slotPlacesLabel,
  slotTimeLabel,
} from "./buscar-view-model";
import { appointmentProviderLabel } from "./turnos-view-model";

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
      return "No pudimos leer este servicio.";
  }
}

type ScreenState =
  | { phase: "loading" }
  | { phase: "ready"; view: BookableOfferingDetailV1 }
  | { phase: "failed"; message: string };

export function ReservarTurnoScreen({
  offeringToken,
  onBooked,
}: {
  offeringToken: string;
  onBooked: (appointmentToken: string) => void;
}) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [slotId, setSlotId] = useState<string | null>(null);
  const [petToken, setPetToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    // THE SELECTION IS DROPPED ON EVERY RE-READ. A slot id that survived a reload
    // is a slot the new grid may no longer contain, and a "Reservar" button over a
    // stale id is the write's refusal made to look like the person's fault.
    setSlotId(null);
    setPetToken(null);
    const result = await fetchBookableOffering(sessionPort, offeringToken);
    if (result.outcome === "ok") {
      setState({ phase: "ready", view: result.payload });
      return;
    }
    setState({ phase: "failed", message: failureMessage(result) });
  }, [offeringToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(async () => {
    if (slotId === null || petToken === null) return;
    setProblem(null);

    const command = buildBookSlot({ slotId, petPublicToken: petToken });
    if (!command.ok) {
      setProblem(command.message);
      return;
    }

    setSubmitting(true);
    const result = await sendAppointmentCommand(sessionPort, command.input);
    setSubmitting(false);

    if (result.outcome === "ok" && result.payload.command === "book") {
      hapticSuccess();
      onBooked(result.payload.appointmentToken);
      return;
    }
    if (result.outcome === "ok") {
      // An ack for a command this screen did not send. The server answered
      // something coherent about the wrong thing, which is a defect rather than a
      // refusal, and a silent no-op would leave a dead button.
      setProblem("La respuesta del servidor no correspondía a esta reserva.");
      return;
    }

    // RE-READ, NEVER RE-SEND — see the header. The grid is what says whether the
    // place is still there, and the copy for every refusal on this write ends in
    // an instruction to look again.
    setProblem(failureMessage(result));
    void load();
  }, [load, onBooked, petToken, slotId]);

  if (state.phase === "loading") return <Loading label="Cargando horarios…" />;

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Reservar turno</Title>
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load()} />
      </Screen>
    );
  }

  const { offering, slots, pets, windowDays } = state.view;
  const days = groupSlotsByDay(slots);
  const bookablePets = pets.filter((pet) => pet.canBook);
  const kind = offeringKindLabel(offering);

  return (
    <Screen>
      <Title>{offeringTitle(offering)}</Title>
      <Body>{appointmentProviderLabel(offering.provider)}</Body>
      <Body>{offeringMetaLabel(offering)}</Body>
      {kind === null ? null : <Body>{kind}</Body>}
      {offering.description === null ? null : <Body>{offering.description}</Body>}

      {days.length === 0 ? (
        <View style={styles.section}>
          <EmptyState
            headline={`No hay horarios disponibles en los próximos ${windowDays} días.`}
            body="Los cupos se publican a medida que el prestador los abre. Probá más adelante."
          />
        </View>
      ) : (
        <View style={styles.section}>
          <Eyebrow>{offeringAvailabilityLabel(offering, windowDays)}</Eyebrow>
          {days.map((day) => (
            <View key={day.key} style={styles.day}>
              <Text style={styles.dayHeading}>{day.heading}</Text>
              <View style={styles.slotRow}>
                {day.slots.map((slot) => (
                  <SlotChip
                    key={slot.slotId}
                    slot={slot}
                    selected={slot.slotId === slotId}
                    onSelect={setSlotId}
                  />
                ))}
              </View>
            </View>
          ))}
        </View>
      )}

      {/* THE PET PICKER IS DRAWN WHENEVER THERE ARE SLOTS, not only after a time
          is chosen. Somebody with no bookable animal must learn it before they
          pick an hour, not after — and a person whose only animal is blocked has
          to be able to read WHY without tapping anything. */}
      {days.length === 0 ? null : (
        <View style={styles.section}>
          <Eyebrow>Para qué mascota</Eyebrow>
          {pets.length === 0 ? (
            <EmptyState
              headline={noBookablePetsLabel()}
              body="Registrá tu mascota desde Mis mascotas y volvé a este servicio."
            />
          ) : (
            pets.map((pet) => (
              <PetChoice
                key={pet.publicToken}
                pet={pet}
                selected={pet.publicToken === petToken}
                onSelect={setPetToken}
              />
            ))
          )}
        </View>
      )}

      {problem === null ? null : (
        <Callout tone="err">
          <Body>{problem}</Body>
        </Callout>
      )}

      {/* THE BUTTON IS DRAWN ONLY WHEN THE WRITE COULD SUCCEED. `disabled` on a
          visible control is a promise that tapping it would do something; here
          the two preconditions are a chosen time and a choosable animal, and the
          screen has already said which one is missing. */}
      {days.length > 0 && bookablePets.length > 0 && (
        <PrimaryButton
          label={submitting ? "Reservando…" : "Reservar"}
          disabled={submitting || slotId === null || petToken === null}
          onPress={() => void submit()}
        />
      )}

      <SecondaryButton label="Actualizar horarios" onPress={() => void load()} />
    </Screen>
  );
}

/** One slot, as a chip. The time is the label; the places are a second line. */
function SlotChip({
  slot,
  selected,
  onSelect,
}: {
  slot: BookableSlotV1;
  selected: boolean;
  onSelect: (slotId: string) => void;
}) {
  const time = slotTimeLabel(slot);
  const places = slotPlacesLabel(slot);

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={places === null ? time : `${time}, ${places}`}
      onPress={() => onSelect(slot.slotId)}
      style={[styles.chip, selected ? styles.chipSelected : null]}
    >
      <Text style={selected ? styles.chipLabelSelected : styles.chipLabel}>{time}</Text>
      {places === null ? null : <Text style={styles.chipMeta}>{places}</Text>}
    </Pressable>
  );
}

/**
 * One animal, as a row.
 *
 * A BLOCKED ANIMAL IS DRAWN AND DISABLED, never hidden — see the header. Its
 * `accessibilityState` carries `disabled` so a screen reader announces the state
 * rather than reading a row that silently does nothing when tapped.
 */
function PetChoice({
  pet,
  selected,
  onSelect,
}: {
  pet: BookablePetV1;
  selected: boolean;
  onSelect: (publicToken: string) => void;
}) {
  const label = petChoiceLabel(pet);

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled: !pet.canBook }}
      accessibilityLabel={label}
      disabled={!pet.canBook}
      onPress={() => onSelect(pet.publicToken)}
      style={[
        styles.petRow,
        selected ? styles.petRowSelected : null,
        pet.canBook ? null : styles.petRowBlocked,
      ]}
    >
      <Text style={pet.canBook ? styles.petLabel : styles.petLabelBlocked}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { gap: SPACE.sm, marginTop: SPACE.lg },
  day: { gap: SPACE.xs, marginTop: SPACE.sm },
  dayHeading: {
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.sm,
    color: COLORS.inkMuted,
  },
  slotRow: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.xs },
  chip: {
    minHeight: TOUCH_TARGET,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.xs,
    borderRadius: RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  chipSelected: { borderColor: COLORS.accent, backgroundColor: COLORS.focusRing },
  chipLabel: {
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.md,
    color: COLORS.ink,
  },
  chipLabelSelected: {
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.md,
    color: COLORS.accent,
  },
  chipMeta: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.xs,
    color: COLORS.inkMuted,
  },
  petRow: {
    minHeight: TOUCH_TARGET,
    justifyContent: "center",
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm,
    borderRadius: RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  petRowSelected: { borderColor: COLORS.accent, backgroundColor: COLORS.focusRing },
  petRowBlocked: { backgroundColor: COLORS.canvas },
  petLabel: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.ink,
  },
  petLabelBlocked: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.inkMuted,
  },
});
