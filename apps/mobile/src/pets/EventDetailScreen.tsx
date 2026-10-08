// ONE asiento, opened from the libreta.
//
// The curated field set, when it happened and when it was written, who signed
// it, every correction it has received, its files — and, when this viewer may,
// the way to correct it.
//
// A CORRECTION DOES NOT EDIT ANYTHING, and this screen says so twice: once in
// the note above the button, and once in the history below, where the original
// values stay legible. That is not belt and braces — an owner who taps
// "Corregir" and then sees the old value still on screen would read it as a
// failed save unless the screen has already told them that is the design.
//
// THE ATTACHMENT LINKS EXPIRE, AND THE SCREEN SAYS WHEN. They are short-lived
// capabilities over private files: whoever holds the string holds the file until
// it stops working. So they live in this screen's state, they are never written
// anywhere, and the moment one is past its stated expiry the screen stops
// offering it and says to refresh instead of showing a thumbnail that 400s.
//
// ONE PRIMARY ACTION, THE REST AS ROWS (pulido-avisos, the Viaje treatment).
// The screen used to end in up to three cards of their own — "Fin del
// tratamiento", "Reemplazo del microchip", "Corregir" — plus a full-width
// primary that said "Actualizar". Now `eventDetailActions` picks ONE primary
// for what this asiento is opened for and lists the rest as rows under "Más
// acciones"; reloading is the pull gesture (and a row). What the viewer may not
// do is said in a Callout, never left as a missing control.
//
// A PDF OPENS IN THE BROWSER, and the screen says that before the tap. This app
// has no PDF viewer; a tap that silently did nothing, or a blank viewer, would
// be worse than an honest handoff.

import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image, StyleSheet, View } from "react-native";

import type { EventAttachmentV1 } from "@dim/contract/api";
import { apiFailureMessage } from "../api/client";
import { amendPetEvent, fetchPetEventDetail } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body, Card, ErrorNotice, Loading, Row, StaleNotice, Unavailable } from "../ui/components";
import {
  Callout,
  Eyebrow,
  ListRow,
  PrimaryButton,
  Screen,
  SecondaryButton,
  TextField,
  Title,
  pullToRefresh,
} from "../ui/kit";
import { recordEventRoute } from "../ui/routes";
import { COLORS, RADIUS, SPACE } from "../ui/theme";
import {
  AMENDMENTS_EMPTY_LABEL,
  AMENDMENT_NO_VISIBLE_CHANGE,
  AMEND_CONFIRM_LABEL,
  AMEND_IMMUTABILITY_NOTE,
  AMEND_READ_ONLY_NOTE,
  AMEND_READ_ONLY_TITLE,
  ATTACHMENTS_EMPTY_LABEL,
  ATTACHMENT_EXTERNAL_HINT,
  ATTACHMENT_UNAVAILABLE_LABEL,
  type EventDetailAction,
  type EventDetailView,
  amendNoEditableFactsNote,
  amendRequiredFactMessage,
  amendableFacts,
  amendmentChangeLine,
  amendmentHeadline,
  attachmentExpired,
  attachmentExpiryLabel,
  buildAmendChanges,
  buildAmendEventCommand,
  buildEventDetailView,
  clearedRequiredFact,
  eventDetailActions,
  initialAmendEdits,
  readOnlyFacts,
  showsCorrectionHistory,
} from "./event-detail-view-model";
import { createAttemptSession } from "./idempotency";
import { formatArDate } from "./libreta-view-model";
import type { SectionView } from "./owner-face-view-model";

type ScreenState =
  | { phase: "loading" }
  | { phase: "ready"; view: EventDetailView; staleFailure: string | null }
  | { phase: "failed"; message: string };

export function EventDetailScreen({
  publicToken,
  eventId,
}: {
  publicToken: string;
  eventId: string;
}) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0);

  // `refresh` keeps the record on screen and spins the pull control instead of
  // blanking to the loading line — the same split every list screen makes.
  const load = useCallback(
    async (mode: "initial" | "refresh" = "initial") => {
      const mine = ++generation.current;
      if (mode === "initial") setState({ phase: "loading" });
      else setRefreshing(true);
      const result = await fetchPetEventDetail(sessionPort, publicToken, eventId);
      if (mine !== generation.current) return;
      setRefreshing(false);
      if (result.outcome === "ok") {
        setState({
          phase: "ready",
          view: buildEventDetailView(result.payload),
          staleFailure: null,
        });
        return;
      }
      const message = apiFailureMessage(result) ?? "No pudimos leer este registro.";
      // A FAILED REFRESH KEEPS THE RECORD (S-2, `reload-state.ts`). The pull
      // gesture used to wipe the asiento off the screen and put a full-screen
      // error in its place: the record the phone was still holding, deleted
      // because the network went away. It stays, under a banner that says so.
      setState((current) =>
        current.phase === "ready"
          ? { ...current, staleFailure: message }
          : { phase: "failed", message },
      );
    },
    [publicToken, eventId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Screen
      refreshControl={
        state.phase === "ready" ? pullToRefresh(() => void load("refresh"), refreshing) : undefined
      }
    >
      {state.phase === "loading" ? <Loading label="Leyendo el registro…" /> : null}
      {state.phase === "failed" ? (
        <ErrorNotice message={state.message} onRetry={() => void load()} />
      ) : null}
      {state.phase === "ready" && state.staleFailure !== null ? (
        <StaleNotice message={state.staleFailure} onRetry={() => void load("refresh")} />
      ) : null}
      {state.phase === "ready" ? (
        <EventDetailBody
          view={state.view}
          publicToken={publicToken}
          onRefresh={() => void load("refresh")}
          onAmended={() => void load()}
        />
      ) : null}
    </Screen>
  );
}

function Section<T>({
  view,
  title,
  children,
}: {
  view: SectionView<T>;
  title: string;
  children: (data: T) => React.ReactNode;
}) {
  if (view.state === "unavailable") return <Unavailable title={title} message={view.message} />;
  return <Card title={title}>{children(view.data)}</Card>;
}

function EventDetailBody({
  view,
  publicToken,
  onRefresh,
  onAmended,
}: {
  view: EventDetailView;
  publicToken: string;
  onRefresh: () => void;
  onAmended: () => void;
}) {
  // Frozen at mount: an expiry countdown that recomputed on every keystroke in
  // the correction form would flicker between "vence a las 15:42" and the
  // expired sentence at the boundary.
  const [now] = useState(() => new Date());

  return (
    <>
      <View style={styles.masthead}>
        <Eyebrow>{view.kind}</Eyebrow>
        <Title>{view.title}</Title>
        {view.subtitle ? <Body>{view.subtitle}</Body> : null}
        <Body>{view.authorLine}</Body>
      </View>

      {/* DETALLE ---------------------------------------------------------- */}
      {/* Two dates and they are DIFFERENT questions: when it happened, and when
          somebody wrote it down. They can be years apart on an imported record,
          and collapsing them would hide exactly that. One card with the fields
          under them, rather than a card per heading. */}
      <Card title="Detalle">
        <Row label="Ocurrió" value={formatArDate(view.occurredAt)} />
        <Row label="Registrado" value={formatArDate(view.recordedAt)} />
        {view.facts.map((fact) => (
          <Row key={fact.field} label={fact.label} value={fact.value} />
        ))}
        {view.location ? (
          // No map: this app ships no map library. The coordinate is the fact
          // the record carries, and printing it beats implying a map that is
          // not there.
          <Row
            label="Coordenadas"
            value={`${view.location.lat.toFixed(5)}, ${view.location.lng.toFixed(5)}`}
          />
        ) : null}
        {view.facts.length === 0 ? <Body>Sin campos adicionales.</Body> : null}
      </Card>

      {view.notes ? (
        <Card title="Notas">
          <Body>{view.notes}</Body>
        </Card>
      ) : null}

      {/* ADJUNTOS --------------------------------------------------------- */}
      <Section view={view.attachments} title="Adjuntos">
        {(attachments) =>
          attachments.items.length === 0 ? (
            <Body>{ATTACHMENTS_EMPTY_LABEL}</Body>
          ) : (
            <View style={styles.attachments}>
              {attachments.items.map((item) => (
                <AttachmentRow key={item.attachmentId} attachment={item} now={now} />
              ))}
            </View>
          )
        }
      </Section>

      {/* CORRECCIONES ----------------------------------------------------- */}
      {showsCorrectionHistory(view) ? (
        <Section view={view.amendments} title="Correcciones">
          {(amendments) =>
            amendments.items.length === 0 ? (
              <Body>{AMENDMENTS_EMPTY_LABEL}</Body>
            ) : (
              <View style={styles.amendments}>
                {amendments.items.map((step) => (
                  <View key={step.amendmentId} style={styles.amendStep}>
                    <Eyebrow>{amendmentHeadline(step)}</Eyebrow>
                    {step.changes.length === 0 ? (
                      <Body>{AMENDMENT_NO_VISIBLE_CHANGE}</Body>
                    ) : (
                      step.changes.map((change) => (
                        <Body key={change.label}>{amendmentChangeLine(change)}</Body>
                      ))
                    )}
                    {step.reason ? <Body>Motivo: {step.reason}</Body> : null}
                  </View>
                ))}
              </View>
            )
          }
        </Section>
      ) : null}

      <EventActions
        view={view}
        publicToken={publicToken}
        onRefresh={onRefresh}
        onAmended={onAmended}
      />
    </>
  );
}

/**
 * The acts on this asiento: ONE primary, then "Más acciones" as rows.
 *
 * "TERMINAR MEDICACIÓN" AND "REEMPLAZAR EL MICROCHIP" LIVE HERE AND NOT IN THE
 * "ASENTAR" PICKER because each needs the record it acts from, and this screen
 * is the only place a person already holds it: ending a treatment needs the
 * identifier of the event it ends, and the chip number appears in this app only
 * as the `Número` fact on the implant asiento (`canReplaceMicrochip`). Both are
 * appends, like everything else — the original asiento stays in the libreta.
 *
 * NO `sourceEventId` FOR THE MICROCHIP, unlike the medication end. The
 * contract's `microchipReplace` carries no reference to the event it supersedes
 * and no `previousChipNumber`; the endpoint reads the animal's canonical chip
 * server-side, so the route carries the kind alone.
 *
 * THE CORRECTION OPENS IN PLACE. While its form is open, the form's own
 * "Confirmar corrección" is the screen's one primary, so the primary slot steps
 * aside; the other rows stay where they were.
 *
 * WHEN THE VIEWER MAY NOT CORRECT, THE REASON IS SHOWN, in a Callout:
 * `amend.refusal` carries an es-AR sentence for every case the server refuses,
 * and when the server allows it but no row is editable from here
 * (A2-alta-asentar-02) the form is not offered either — a form with zero boxes
 * could only ever answer "no modificaste ningún campo". A disabled control with
 * no explanation reads as a bug; no control at all reads as a missing feature.
 */
function EventActions({
  view,
  publicToken,
  onRefresh,
  onAmended,
}: {
  view: EventDetailView;
  publicToken: string;
  onRefresh: () => void;
  onAmended: () => void;
}) {
  const router = useRouter();
  const [amending, setAmending] = useState(false);
  const { primary, more } = eventDetailActions(view);
  const rows = more.filter((action) => !(amending && action.id === "amend"));

  const run = (action: EventDetailAction) => {
    switch (action.id) {
      case "end_medication":
        router.push(
          recordEventRoute(publicToken, { kind: "medication_end", sourceEventId: view.eventId }),
        );
        return;
      case "replace_microchip":
        router.push(recordEventRoute(publicToken, { kind: "microchip_replace" }));
        return;
      case "amend":
        setAmending(true);
        return;
      case "refresh":
        onRefresh();
        return;
    }
  };

  // TWO SENTENCES for the no-editable-row case, because the reason differs: an
  // asiento whose rows are all formatted is told exactly that; one with NO
  // curated rows — `medication_started` and `clinical_info_logged` render none —
  // is not, because the card above just said "Sin campos adicionales".
  let amendNotice: string | null = null;
  if (!view.canAmend) amendNotice = view.amendRefusal;
  else if (amendableFacts(view.eventType, view.facts).length === 0) {
    amendNotice = amendNoEditableFactsNote(view.facts);
  }

  return (
    <>
      {amendNotice ? (
        <Callout tone="neutral">
          <Body>{amendNotice}</Body>
        </Callout>
      ) : null}

      {amending ? (
        <AmendForm
          view={view}
          publicToken={publicToken}
          onCancel={() => setAmending(false)}
          onDone={() => {
            setAmending(false);
            onAmended();
          }}
        />
      ) : primary !== null ? (
        <View style={styles.primary}>
          {primary.note ? <Body>{primary.note}</Body> : null}
          <PrimaryButton label={primary.label} onPress={() => run(primary)} />
        </View>
      ) : null}

      {/* NOT FOR THE RELOAD ALONE. Pull-to-refresh already covers it, and a
          section headed "Más acciones" whose only entry is "Actualizar" reads
          as a section with nothing in it. */}
      {rows.some((action) => action.id !== "refresh") ? (
        <View style={styles.more}>
          <Eyebrow>Más acciones</Eyebrow>
          {rows.map((action) => (
            <ListRow
              key={action.id}
              label={action.label}
              caption={action.caption}
              onPress={() => run(action)}
            />
          ))}
        </View>
      ) : null}
    </>
  );
}

/**
 * One file.
 *
 * An image renders inline; anything else is a labelled handoff to the browser,
 * drawn as a row that says so before the tap. A link past its expiry renders
 * neither: it says the link is gone and points at the refresh, because a broken
 * thumbnail teaches people the app does not work.
 */
function AttachmentRow({ attachment, now }: { attachment: EventAttachmentV1; now: Date }) {
  const expired = attachmentExpired(attachment, now);
  const expiry = attachmentExpiryLabel(attachment.expiresAt, now);

  if (expired || attachment.url === null) {
    return (
      <View style={styles.attachment}>
        <Body>{ATTACHMENT_UNAVAILABLE_LABEL}</Body>
        <Body>{expiry}</Body>
      </View>
    );
  }

  if (attachment.kind === "image") {
    const url = attachment.url;
    return (
      <View style={styles.attachment}>
        <Image
          source={{ uri: url }}
          style={styles.image}
          resizeMode="cover"
          accessibilityLabel="Archivo adjunto de este registro"
        />
        <Body>{expiry}</Body>
      </View>
    );
  }

  const url = attachment.url;
  return (
    <ListRow
      label={`Ver adjunto (${attachment.mimeType})`}
      caption={`${ATTACHMENT_EXTERNAL_HINT}. ${expiry}`}
      accessibilityHint={`Abre el archivo adjunto. ${ATTACHMENT_EXTERNAL_HINT}.`}
      onPress={() => void Linking.openURL(url)}
    />
  );
}

function AmendForm({
  view,
  publicToken,
  onCancel,
  onDone,
}: {
  view: EventDetailView;
  publicToken: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const editable = amendableFacts(view.eventType, view.facts);
  const readOnly = readOnlyFacts(view.eventType, view.facts);
  const [edits, setEdits] = useState<Record<string, string>>(() =>
    initialAmendEdits(view.eventType, view.facts),
  );
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // ONE key per correction ATTEMPT, reused across every retry of it — a fresh
  // key per HTTP attempt would opt out of the exact failure the header exists
  // for (a timeout whose first request already committed). `restart()` is never
  // called here: this form IS one attempt.
  //
  // THE COST, STATED HERE AND NOT ONLY AT THE ALTA. `idempotency.ts` argues this
  // tradeoff for pet registration; the correction form inherits it, and a reader
  // of THIS file should not have to go find that argument to learn what it
  // bought. The key survives an EDIT: if a submit times out after the server
  // committed, and the owner then changes "L-99" to "L-98" and submits again,
  // the second request carries the same key, the server replays the first
  // correction, and the edited body is discarded in silence. 201, `wasDuplicate`
  // — and a value the owner did not just type.
  //
  // ACCEPTED, for the alta's reason and with two things the alta does not have.
  // The alternative — a new key on edit-and-resubmit — puts TWO corrections on
  // an append-only spine for one mistake, and a ledger people read as history
  // cannot be tidied afterwards. Against that, the discarded edit costs one more
  // correction, and the two mitigations make it visible rather than silent:
  //
  //   · `onDone` REFETCHES the record. The screen redraws from what the server
  //     actually holds, so an owner whose edit was replayed away sees the old
  //     value on the page instead of assuming the new one landed.
  //   · The key is scoped to this form's MOUNT. Closing the correction form and
  //     opening it again is a new `AmendForm`, a new `createAttemptSession`, and
  //     a new key — so the second, deliberate correction goes through. The
  //     recovery is "open it again", which is what an owner does anyway after
  //     seeing the value they meant to change still sitting there.
  const attempt = useRef(createAttemptSession());

  async function submit() {
    // THE CONTRACT'S SCHEMA, RUN LOCALLY FIRST (A2-alta-asentar-07), like every
    // other form in this app. Without it a four-character motivo was a round
    // trip that came back `invalid_request` — rendered as "Actualizá la app",
    // which is both false and impossible to act on.
    //
    // THE EMPTIED REQUIRED BOX IS ANSWERED BEFORE THE SCHEMA RUNS, because the
    // contract's schema cannot see it: `changes` is `{field, value}` and a `null`
    // value is perfectly valid there — the field's own nullability lives in the
    // SPINE's schema, which this app cannot run. `buildAmendChanges` drops the
    // change either way; this is what makes the drop visible instead of a box
    // that quietly ignored what somebody deleted.
    const cleared = clearedRequiredFact(view.eventType, view.facts, edits);
    if (cleared) {
      setError(amendRequiredFactMessage(cleared.label));
      return;
    }
    const built = buildAmendEventCommand({
      reason,
      changes: buildAmendChanges(view.eventType, view.facts, edits),
    });
    if (!built.ok) {
      setError(built.message);
      return;
    }
    setError(null);
    setSubmitting(true);
    const result = await amendPetEvent(
      sessionPort,
      { publicToken, eventId: view.eventId },
      built.input,
      attempt.current.key(),
    );
    setSubmitting(false);
    if (result.outcome === "ok") {
      onDone();
      return;
    }
    setError(apiFailureMessage(result) ?? "No pudimos guardar la corrección. Volvé a intentar.");
  }

  return (
    <Card title="Corregir registro">
      <Body>{AMEND_IMMUTABILITY_NOTE}</Body>

      {editable.map((fact) => (
        <TextField
          key={fact.field}
          label={fact.label}
          value={edits[fact.field] ?? ""}
          onChangeText={(next) => setEdits((prev) => ({ ...prev, [fact.field]: next }))}
          editable={!submitting}
        />
      ))}

      {/* THE ROWS THIS APP WILL NOT EDIT, SHOWN RATHER THAN DROPPED
          (A2-alta-asentar-02). A person who came here to fix "Próxima dosis"
          must find out that it is not editable HERE and where it is — a row
          that silently vanished from the form would read as the app having
          forgotten a field, and they would keep looking for it. */}
      {readOnly.length > 0 ? (
        <View style={styles.readOnlyBlock}>
          <Eyebrow>{AMEND_READ_ONLY_TITLE}</Eyebrow>
          {readOnly.map((fact) => (
            <Row key={fact.field} label={fact.label} value={fact.value} />
          ))}
          <Body>{AMEND_READ_ONLY_NOTE}</Body>
        </View>
      ) : null}

      {/* Optional for an owner correcting their own record — the CHANGE is the
          record. The five-character floor is the SPINE's, and it applies only
          when a reason is present, so the placeholder states both halves rather
          than letting somebody discover the second from a refusal. */}
      <TextField
        label="Motivo de la corrección"
        placeholder="Opcional. Si lo escribís, mínimo 5 caracteres."
        value={reason}
        onChangeText={setReason}
        multiline
        editable={!submitting}
      />

      {error ? (
        <Callout tone="err">
          <Body>{error}</Body>
        </Callout>
      ) : null}

      <PrimaryButton
        label={submitting ? "Guardando…" : AMEND_CONFIRM_LABEL}
        onPress={() => void submit()}
        disabled={submitting}
      />
      <SecondaryButton label="Volver" onPress={onCancel} disabled={submitting} />
    </Card>
  );
}

const styles = StyleSheet.create({
  masthead: { gap: SPACE.xs },
  primary: { gap: SPACE.sm },
  more: { gap: SPACE.xs },
  attachments: { gap: SPACE.sm },
  attachment: { gap: SPACE.xs },
  image: {
    width: "100%",
    height: 192,
    borderRadius: RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
  },
  amendments: { gap: SPACE.md },
  amendStep: {
    gap: SPACE.xs,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.border,
    paddingLeft: SPACE.sm,
  },
  // Set apart from the editable boxes above it by a rule and a ground, so the
  // boundary between "you can change this" and "you cannot" is visible without
  // reading a word.
  readOnlyBlock: {
    gap: SPACE.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    paddingTop: SPACE.md,
  },
});
