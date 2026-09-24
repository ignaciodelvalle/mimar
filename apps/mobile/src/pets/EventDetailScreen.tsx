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
// A PDF OPENS IN THE BROWSER, and the screen says that before the tap. This app
// has no PDF viewer; a tap that silently did nothing, or a blank viewer, would
// be worse than an honest handoff.

import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import type { EventAttachmentV1, PetEventDetailV1 } from "@dim/contract/api";
import type { ApiResult } from "../api/client";
import { amendPetEvent, fetchPetEventDetail } from "../api/endpoints";
import { apiErrorMessage } from "../api/error-copy";
import { sessionPort } from "../auth/session-store";
import { Body, Card, ErrorNotice, Loading, Row, Unavailable } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { Callout, PrimaryButton, Screen, SecondaryButton, TextField } from "../ui/kit";
import { recordEventRoute } from "../ui/routes";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TRACKING, TYPE } from "../ui/theme";
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
  canEndMedication,
  canReplaceMicrochip,
  clearedRequiredFact,
  initialAmendEdits,
  readOnlyFacts,
} from "./event-detail-view-model";
import { createAttemptSession } from "./idempotency";
import { formatArDate } from "./libreta-view-model";
import type { SectionView } from "./owner-face-view-model";

type ScreenState =
  | { phase: "loading" }
  | { phase: "ready"; view: EventDetailView }
  | { phase: "failed"; message: string };

function failureMessage(result: ApiResult<PetEventDetailV1>): string {
  switch (result.outcome) {
    case "api-error":
      return apiErrorMessage(result.code);
    case "unsupported-version":
      return "Esta versión de la app no puede leer este registro. Actualizá la app.";
    case "malformed":
      return "La respuesta del servidor no se pudo leer.";
    case "unreachable":
      return "No pudimos conectarnos. Revisá tu conexión.";
    default:
      return "No pudimos leer este registro.";
  }
}

export function EventDetailScreen({
  publicToken,
  eventId,
}: {
  publicToken: string;
  eventId: string;
}) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setState({ phase: "loading" });
    const result = await fetchPetEventDetail(sessionPort, publicToken, eventId);
    if (mine !== generation.current) return;
    if (result.outcome === "ok") {
      setState({ phase: "ready", view: buildEventDetailView(result.payload) });
      return;
    }
    setState({ phase: "failed", message: failureMessage(result) });
  }, [publicToken, eventId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Screen>
      {state.phase === "loading" ? <Loading label="Leyendo el registro…" /> : null}
      {state.phase === "failed" ? (
        <ErrorNotice message={state.message} onRetry={() => void load()} />
      ) : null}
      {state.phase === "ready" ? (
        <EventDetailBody
          view={state.view}
          publicToken={publicToken}
          onAmended={() => void load()}
        />
      ) : null}
      {state.phase === "ready" ? (
        <PrimaryButton label="Actualizar" onPress={() => void load()} />
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
  onAmended,
}: {
  view: EventDetailView;
  publicToken: string;
  onAmended: () => void;
}) {
  // Frozen at mount: an expiry countdown that recomputed on every keystroke in
  // the correction form would flicker between "vence a las 15:42" and the
  // expired sentence at the boundary.
  const [now] = useState(() => new Date());

  return (
    <>
      <View style={styles.masthead}>
        <Text style={styles.kind}>{view.kind}</Text>
        <Text style={styles.title}>{view.title}</Text>
        {view.subtitle ? <Body>{view.subtitle}</Body> : null}
        <Text style={styles.author}>{view.authorLine}</Text>
      </View>

      {/* FECHAS ----------------------------------------------------------- */}
      {/* Two dates and they are DIFFERENT questions: when it happened, and when
          somebody wrote it down. They can be years apart on an imported record,
          and collapsing them would hide exactly that. */}
      <Card title="Fechas">
        <Row label="Ocurrió" value={formatArDate(view.occurredAt)} />
        <Row label="Registrado" value={formatArDate(view.recordedAt)} />
      </Card>

      {/* DETALLE ---------------------------------------------------------- */}
      <Card title="Detalle">
        {view.facts.length === 0 ? (
          <Body>Sin campos adicionales.</Body>
        ) : (
          view.facts.map((fact) => <Row key={fact.field} label={fact.label} value={fact.value} />)
        )}
      </Card>

      {view.notes ? (
        <Card title="Notas">
          <Body>{view.notes}</Body>
        </Card>
      ) : null}

      {view.location ? (
        <Card title="Ubicación">
          {/* No map: this app ships no map library. The coordinate is the fact
              the record carries, and printing it beats implying a map that is
              not there. */}
          <Row
            label="Coordenadas"
            value={`${view.location.lat.toFixed(5)}, ${view.location.lng.toFixed(5)}`}
          />
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
      <Section view={view.amendments} title="Correcciones">
        {(amendments) =>
          amendments.items.length === 0 ? (
            <Body>{AMENDMENTS_EMPTY_LABEL}</Body>
          ) : (
            <View style={styles.amendments}>
              {amendments.items.map((step) => (
                <View key={step.amendmentId} style={styles.amendStep}>
                  <Text style={styles.amendHeadline}>{amendmentHeadline(step)}</Text>
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

      <EndMedicationBlock view={view} publicToken={publicToken} />

      <ReplaceMicrochipBlock view={view} publicToken={publicToken} />

      <AmendBlock view={view} publicToken={publicToken} onAmended={onAmended} />
    </>
  );
}

/**
 * "Terminar medicación", offered only on the asiento that STARTED one.
 *
 * IT LIVES HERE AND NOT IN THE "ASENTAR" PICKER because ending a treatment
 * needs the identifier of the event it ends, and this screen is the only place
 * a person already holds it. A picker would have to build a list of open
 * treatments from a second read — a second source for something the ledger
 * already says, and one more thing to keep in agreement.
 *
 * ENDING IS AN APPEND, like everything else: it writes a `medication_stopped`
 * event that references this one and cancels the dose reminders still ahead.
 * The original treatment stays in the libreta forever.
 */
function EndMedicationBlock({
  view,
  publicToken,
}: {
  view: EventDetailView;
  publicToken: string;
}) {
  const router = useRouter();
  if (!canEndMedication(view)) return null;

  return (
    <Card title="Fin del tratamiento">
      <Body>
        Registrá el fin de este tratamiento. Se cancelan los recordatorios de las dosis que
        faltaban; el asiento del inicio queda igual.
      </Body>
      <SecondaryButton
        label="Terminar medicación"
        onPress={() =>
          router.push(
            recordEventRoute(publicToken, { kind: "medication_end", sourceEventId: view.eventId }),
          )
        }
      />
    </Card>
  );
}

/**
 * "Reemplazar el microchip", offered only on the asiento that recorded one.
 *
 * THE SAME DOOR SHAPE AS `EndMedicationBlock` ABOVE, and deliberately: both are
 * acts reached from the asiento that originated them rather than from the
 * "Asentar" picker. `WRITABLE_KINDS` (record-event-view-model.ts) names this
 * home itself — "`microchip_replace` — from the microchip the animal already
 * has. There is nothing to replace otherwise, and the server refuses with 409."
 * The chip number is on THIS screen, as the `Número` fact, and nowhere else in
 * the app. See `canReplaceMicrochip` for why the implant asiento and not the
 * replacement one.
 *
 * NO `sourceEventId`, unlike "Terminar medicación". The contract's
 * `microchipReplace` carries no reference to the event it supersedes and no
 * `previousChipNumber` — the endpoint reads the animal's canonical chip
 * server-side. Passing this event's id would be the client asserting a fact the
 * server already holds, and a mismatch would have to be adjudicated by
 * somebody. The route therefore carries the kind alone.
 *
 * REPLACEMENT AND REVOCATION ARE ONE FORM, which is why the copy names both:
 * the kind's own `reason` chips decide which of the two this is, and a person
 * whose chip was removed rather than swapped must recognise this as their door.
 */
function ReplaceMicrochipBlock({
  view,
  publicToken,
}: {
  view: EventDetailView;
  publicToken: string;
}) {
  const router = useRouter();
  if (!canReplaceMicrochip(view)) return null;

  return (
    <Card title="Reemplazo del microchip">
      <Body>
        Si este chip dejó de leerse, se salió o quedó anulado, registrá el reemplazo. Este asiento
        queda igual: el chip nuevo se anota aparte y pasa a ser el de la credencial.
      </Body>
      <SecondaryButton
        label="Reemplazar el microchip"
        accessibilityHint="Registrar que este microchip se reemplazó por otro, o que quedó anulado."
        onPress={() => router.push(recordEventRoute(publicToken, { kind: "microchip_replace" }))}
      />
    </Card>
  );
}

/**
 * One file.
 *
 * An image renders inline; anything else is a labelled handoff to the browser.
 * A link past its expiry renders neither: it says the link is gone and points at
 * the refresh, because a broken thumbnail teaches people the app does not work.
 */
function AttachmentRow({ attachment, now }: { attachment: EventAttachmentV1; now: Date }) {
  const expired = attachmentExpired(attachment, now);
  const expiry = attachmentExpiryLabel(attachment.expiresAt, now);

  if (expired || attachment.url === null) {
    return (
      <View style={styles.attachment}>
        <Text style={styles.attachmentLabel}>{ATTACHMENT_UNAVAILABLE_LABEL}</Text>
        <Text style={styles.attachmentMeta}>{expiry}</Text>
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
        <Text style={styles.attachmentMeta}>{expiry}</Text>
      </View>
    );
  }

  const url = attachment.url;
  return (
    <Pressable
      onPress={() => void Linking.openURL(url)}
      accessibilityRole="button"
      accessibilityLabel={`Abrir el archivo adjunto. ${ATTACHMENT_EXTERNAL_HINT}`}
      style={styles.attachmentButton}
    >
      <Text style={styles.attachmentLabel}>Ver adjunto ({attachment.mimeType})</Text>
      <Text style={styles.attachmentMeta}>{ATTACHMENT_EXTERNAL_HINT}</Text>
      <Text style={styles.attachmentMeta}>{expiry}</Text>
    </Pressable>
  );
}

/**
 * The correction affordance, and the form behind it.
 *
 * WHEN THE VIEWER MAY NOT CORRECT, THE REASON IS SHOWN. `amend.refusal` carries
 * an es-AR sentence for every case the server refuses — a deceased animal, a
 * type that has its own reversal path, a viewer who only holds the pet through
 * an organization. A disabled control with no explanation reads as a bug; no
 * control at all reads as a missing feature.
 *
 * AND WHEN THE SERVER ALLOWS IT BUT NO ROW IS EDITABLE FROM HERE
 * (A2-alta-asentar-02), the form is not offered either — for the same reason,
 * one step further in. A peso's only curated row is the FORMATTED weight, so the
 * form would open with zero boxes and its submit could only ever answer "no
 * modificaste ningún campo": the contract requires at least one change. A dead
 * end with a button is worse than a sentence naming where the correction lives.
 */
function AmendBlock({
  view,
  publicToken,
  onAmended,
}: {
  view: EventDetailView;
  publicToken: string;
  onAmended: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (!view.canAmend) {
    return view.amendRefusal ? (
      <Callout tone="neutral">
        <Text style={styles.calloutBody}>{view.amendRefusal}</Text>
      </Callout>
    ) : null;
  }

  if (amendableFacts(view.eventType, view.facts).length === 0) {
    return (
      <Card title="Corregir">
        {/* TWO SENTENCES, because the reason differs. An asiento whose rows are
            all formatted is told exactly that; one with NO curated rows —
            `medication_started` and `clinical_info_logged` render none — is not,
            because the screen just said "Sin campos adicionales" and "los que
            tiene se muestran con formato" would be a false statement about a
            record that has none. The destination is the same either way. */}
        <Body>{amendNoEditableFactsNote(view.facts)}</Body>
      </Card>
    );
  }

  if (!open) {
    return (
      <Card title="Corregir">
        <Body>{AMEND_IMMUTABILITY_NOTE}</Body>
        <SecondaryButton label="Corregir registro" onPress={() => setOpen(true)} />
      </Card>
    );
  }

  return (
    <AmendForm
      view={view}
      publicToken={publicToken}
      onCancel={() => setOpen(false)}
      onDone={() => {
        setOpen(false);
        onAmended();
      }}
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
    setError(
      result.outcome === "api-error"
        ? apiErrorMessage(result.code)
        : "No pudimos guardar la corrección. Volvé a intentar.",
    );
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
          <Text style={styles.readOnlyTitle}>{AMEND_READ_ONLY_TITLE}</Text>
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
          <Text style={styles.calloutBody}>{error}</Text>
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
  kind: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * TRACKING.wider,
    textTransform: "uppercase",
    color: COLORS.inkMuted,
  },
  title: {
    fontFamily: FONTS.serif,
    fontSize: TYPE.xl2,
    lineHeight: TYPE.xl2 * LEADING.xl2,
    color: COLORS.ink,
  },
  author: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.inkSoft },
  attachments: { gap: SPACE.sm },
  attachment: { gap: SPACE.xs },
  attachmentButton: {
    minHeight: TOUCH_TARGET,
    borderRadius: RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    backgroundColor: COLORS.canvas2,
    padding: SPACE.md,
    gap: SPACE.xs,
  },
  attachmentLabel: { fontFamily: FONTS.sansSemibold, fontSize: TYPE.md, color: COLORS.accent },
  attachmentMeta: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.inkMuted },
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
  amendHeadline: { fontFamily: FONTS.monoSemibold, fontSize: TYPE.sm, color: COLORS.inkSoft },
  // Set apart from the editable boxes above it by a rule and a ground, so the
  // boundary between "you can change this" and "you cannot" is visible without
  // reading a word.
  readOnlyBlock: {
    gap: SPACE.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    paddingTop: SPACE.md,
  },
  readOnlyTitle: {
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * TRACKING.wider,
    textTransform: "uppercase",
    color: COLORS.inkMuted,
  },
  calloutBody: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.ink,
  },
});
