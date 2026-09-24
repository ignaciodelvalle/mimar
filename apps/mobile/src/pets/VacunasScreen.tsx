// PRÓXIMAS VACUNAS — programar un recordatorio de vacuna, o eliminar uno.
//
// THE OTHER HALF OF A CAPABILITY THE FACE COULD ONLY READ. `OwnerExtraSections`
// has drawn this pet's reminders since the face was built; until this screen
// nothing in the app could schedule one or cancel one. Both operations reach
// the IDENTICAL use-cases the web's "Recordatorios" card reaches
// (`createVaccineReminder`, `deleteVaccineReminder`), through
// `POST /pets/{token}/reminders`.
//
// ONE SCREEN, TWO OPERATIONS, and the list between them. The web schedules on
// a page of its own and deletes inline on the card; a stack navigator has no
// inline form post and this app's face never writes, so the form and the rows
// with their "Eliminar" share this one route — see `vaccineRemindersRoute`.
//
// THE FORM DOES NOT DEPEND ON THE LIST, AND THE SCREEN SAYS SO. The read here is
// `/pets/{token}` (the list is on the face; the write endpoint has no GET), and
// that read can fail. When it does, the list says it could not be read — in
// those words, never "sin próximas vacunas" — and the form stays exactly where
// it is: scheduling needs no list, and hiding the form because a read failed
// would be a dead end the person cannot see.
//
// A REPLAYED CANCEL IS A SUCCESS. A second tap, or a retry after a lost
// response, finds the row already gone and the server answers 200 with
// `changed: false`. This screen renders that as done — the row leaves the list
// and the sentence says it was already gone — never as an error.
//
// THE SCREEN NEVER PRE-JUDGES WHO MAY DO THIS. The web's guard admits every
// current holder (`requireOwnedPetByToken`), the server applies the same rule
// on this door, and a refusal renders as its sentence rather than as a hidden
// button.

import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";

import type { OwnerPetReminderV1 } from "@dim/contract/api";

import type { ApiResult } from "../api/client";
import { fetchOwnerPetDetail, sendVaccineReminderCommand } from "../api/endpoints";
import { apiErrorMessage } from "../api/error-copy";
import { sessionPort } from "../auth/session-store";
import { Body, Card, Loading, Row, Unavailable } from "../ui/components";
import {
  Callout,
  DateField,
  PrimaryButton,
  Screen,
  SecondaryButton,
  TextField,
  Title,
} from "../ui/kit";
import { useDraftDiscardGuard } from "../ui/use-draft-discard-guard";
import { useScrollToError } from "../ui/use-scroll-to-error";

import {
  EMPTY_SCHEDULE_REMINDER_DRAFT,
  REMINDERS_EMPTY_HINT,
  REMINDERS_EMPTY_LINE,
  type ScheduleReminderDraft,
  buildCancelReminder,
  buildScheduleReminder,
  reminderCancelledMessage,
  reminderDueLabel,
  reminderScheduledMessage,
  truncationNote,
} from "./owner-face-view-model";

/**
 * One sentence per failure arm. No arm falls through to a generic shrug, and
 * none of them quotes anything the server sent.
 */
function failureMessage(result: ApiResult<unknown>): string {
  switch (result.outcome) {
    case "api-error":
      return apiErrorMessage(result.code);
    case "unsupported-version":
      return "Esta versión de la app no puede manejar recordatorios. Actualizá la app.";
    case "malformed":
      return "La respuesta del servidor no se pudo leer.";
    case "unreachable":
      return "No pudimos conectarnos. Revisá tu conexión.";
    default:
      return "No pudimos guardar el recordatorio.";
  }
}

/**
 * The list, as three distinct states plus its own loading.
 *
 * `unavailable` is NOT `none`, for the reason the header gives: the first is a
 * read that failed, the second is an animal with nothing scheduled, and only
 * one of them should be told "sin próximas vacunas".
 */
type ListState =
  | { kind: "loading" }
  | { kind: "known"; items: OwnerPetReminderV1[]; total: number }
  | { kind: "none" }
  | { kind: "unavailable"; message: string };

type Notice = { tone: "ok" | "err"; message: string } | null;

/** What is busy right now: the form, one row, or nothing. */
type Busy = { what: "schedule" } | { what: "cancel"; reminderId: string } | null;

export function VacunasScreen({ publicToken }: { publicToken: string }) {
  const [petName, setPetName] = useState<string | null>(null);
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [draft, setDraft] = useState<ScheduleReminderDraft>(EMPTY_SCHEDULE_REMINDER_DRAFT);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice>(null);
  // A REFUSAL moves the view; the "ok" notice does not.
  const { anchorRef: errorAnchor, scrollRef } = useScrollToError(
    notice !== null && notice.tone === "err" ? notice.message : null,
  );
  // THE BACK GESTURE MAY NOT DISCARD A TYPED REMINDER. The draft is reset to
  // the EMPTY constant after a landed schedule, so the guard lifts by itself.
  useDraftDiscardGuard(draft !== EMPTY_SCHEDULE_REMINDER_DRAFT);

  const load = useCallback(async () => {
    setList({ kind: "loading" });
    const result = await fetchOwnerPetDetail(sessionPort, publicToken);
    if (result.outcome !== "ok") {
      setList({ kind: "unavailable", message: failureMessage(result) });
      return;
    }
    const { identity, reminders } = result.payload;
    setPetName(identity.status === "ok" ? identity.data.name : null);
    if (reminders.status !== "ok") {
      setList({ kind: "unavailable", message: "No se pudo leer esta sección." });
      return;
    }
    setList(
      reminders.data.items.length === 0
        ? { kind: "none" }
        : { kind: "known", items: reminders.data.items, total: reminders.data.total },
    );
  }, [publicToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const schedule = useCallback(async () => {
    setNotice(null);
    // The CONTRACT's schema, run locally first, so a missing field gets its
    // sentence instead of a round trip that answers `invalid_request`.
    const built = buildScheduleReminder(draft);
    if (!built.ok) {
      setNotice({ tone: "err", message: built.message });
      return;
    }

    setBusy({ what: "schedule" });
    const result = await sendVaccineReminderCommand(sessionPort, publicToken, built.input);
    setBusy(null);
    if (result.outcome !== "ok") {
      setNotice({ tone: "err", message: failureMessage(result) });
      return;
    }
    setNotice({ tone: "ok", message: reminderScheduledMessage(draft.vaccineName) });
    setDraft(EMPTY_SCHEDULE_REMINDER_DRAFT);
    // THE LIST IS RE-READ, NOT PATCHED. Unlike `MudanzaScreen`, whose ack
    // carries everything its card shows, this ack carries only the id — the
    // due label and the variant are the server's to compute. If the re-read
    // fails the list says so and the "Listo" above it stands: the write landed.
    void load();
  }, [draft, publicToken, load]);

  const cancel = useCallback(
    async (reminder: OwnerPetReminderV1) => {
      setNotice(null);
      setBusy({ what: "cancel", reminderId: reminder.reminderId });
      const result = await sendVaccineReminderCommand(
        sessionPort,
        publicToken,
        buildCancelReminder(reminder.reminderId),
      );
      setBusy(null);
      if (result.outcome !== "ok") {
        setNotice({ tone: "err", message: failureMessage(result) });
        return;
      }
      const ack = result.payload;
      if (ack.command !== "cancel_vaccine_reminder") {
        setNotice({ tone: "err", message: "La respuesta del servidor no se pudo leer." });
        return;
      }
      // BOTH ARMS OF `changed` ARE A SUCCESS — see the header. The row leaves
      // the list either way, because either way it is gone.
      setNotice({ tone: "ok", message: reminderCancelledMessage(ack) });
      setList((current) => {
        if (current.kind !== "known") return current;
        const items = current.items.filter((r) => r.reminderId !== reminder.reminderId);
        return items.length === 0
          ? { kind: "none" }
          : { kind: "known", items, total: Math.max(items.length, current.total - 1) };
      });
    },
    [publicToken],
  );

  const subject = petName ?? "esta mascota";
  const scheduling = busy?.what === "schedule";

  return (
    <Screen keyboardAvoiding scrollRef={scrollRef}>
      <Title>Recordatorios de {subject}</Title>
      <Body>
        Programá un recordatorio y te avisamos cuando se acerque la fecha. Un recordatorio no es un
        asiento: la vacuna aplicada se anota en la libreta.
      </Body>

      {notice !== null && (
        <View ref={errorAnchor}>
          <Callout tone={notice.tone}>
            <Body>{notice.message}</Body>
          </Callout>
        </View>
      )}

      <Card title="Nuevo recordatorio">
        <View style={{ gap: 12 }}>
          <TextField
            label="Vacuna"
            required
            value={draft.vaccineName}
            onChangeText={(vaccineName) => setDraft({ ...draft, vaccineName })}
            placeholder="Antirrábica, sextuple…"
          />
          <DateField
            label="Fecha estimada"
            required
            value={draft.dueAt}
            onChangeText={(dueAt) => setDraft({ ...draft, dueAt })}
          />
          <TextField
            label="Notas"
            multiline
            value={draft.description}
            onChangeText={(description) => setDraft({ ...draft, description })}
            placeholder="Cualquier detalle (clínica habitual, dosis, etc.)"
          />
          <PrimaryButton
            label={scheduling ? "Guardando…" : "Programar vacuna"}
            // `buildScheduleReminder` is what refuses; the button's `disabled`
            // is an affordance while a write is in flight, not the gate.
            disabled={busy !== null}
            onPress={() => void schedule()}
          />
        </View>
      </Card>

      <RemindersList list={list} busy={busy} onCancel={cancel} onRetry={() => void load()} />
    </Screen>
  );
}

/** The list in its four states, with "Eliminar" on every row it knows. */
function RemindersList({
  list,
  busy,
  onCancel,
  onRetry,
}: {
  list: ListState;
  busy: Busy;
  onCancel: (reminder: OwnerPetReminderV1) => void;
  onRetry: () => void;
}) {
  switch (list.kind) {
    case "loading":
      return <Loading label="Leyendo los recordatorios…" />;
    case "unavailable":
      // NOT "sin próximas vacunas". The read failed, and the form above this
      // still works — which is the sentence a person standing here needs.
      return (
        <View style={{ gap: 12 }}>
          <Unavailable title="Recordatorios" message={list.message} />
          <Body>No pudimos leer qué hay programado. Programar una vacuna igual funciona.</Body>
          <SecondaryButton label="Volver a intentar" onPress={onRetry} />
        </View>
      );
    case "none":
      return (
        <Card title="Recordatorios">
          <Body>{REMINDERS_EMPTY_LINE}</Body>
          <Body>{REMINDERS_EMPTY_HINT}</Body>
        </Card>
      );
    case "known": {
      const note = truncationNote(list.items.length, list.total, "recordatorios");
      return (
        <Card title="Recordatorios">
          <View style={{ gap: 12 }}>
            {list.items.map((reminder) => {
              const deleting = busy?.what === "cancel" && busy.reminderId === reminder.reminderId;
              return (
                <View key={reminder.reminderId} style={{ gap: 8 }}>
                  <Row label={reminder.title} value={reminderDueLabel(reminder.daysUntilDue)} />
                  <SecondaryButton
                    label={deleting ? "Eliminando…" : "Eliminar"}
                    accessibilityHint={`Eliminar el recordatorio de ${reminder.title}.`}
                    disabled={busy !== null}
                    onPress={() => onCancel(reminder)}
                  />
                </View>
              );
            })}
            {note ? <Body>{note}</Body> : null}
          </View>
        </Card>
      );
    }
  }
}
