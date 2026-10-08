// The lost screen's three forms — marcar perdida, el avistaje, reportar un
// mensaje — as PANES of `LostScreen`, never routes. Split out of the screen file
// (custody polish, 2026-10-07) without changing a field, a command or a key: the
// commands, their builders and the one idempotency key are exactly what they
// were; only the chrome around them moved from stacked Cards to callouts,
// section labels and one folded module.

import { useRef, useState } from "react";
import { View } from "react-native";

import type { LostFeedItemV1, PetLostV1 } from "@dim/contract/api";
import type { ContentReportCategory } from "@dim/contract/events";

import { LocalityPicker } from "../pets/LocalityPicker";
import { createAttemptSession } from "../pets/idempotency";
import { LocationPicker, type PickedLocation } from "../ui/LocationPicker";
import { Body } from "../ui/components";
import {
  Callout,
  Choice,
  CollapsibleModule,
  Eyebrow,
  PrimaryButton,
  SecondaryButton,
  TextField,
} from "../ui/kit";
import { useIsDirty } from "../ui/use-draft-dirty";
import { useDraftDiscardGuard } from "../ui/use-draft-discard-guard";

import { DisclosureRow, MetaLine, type RunFn, formatIsoDateTime, lostStyles } from "./lost-ui";
import {
  type LostDraft,
  NO_CONTACT_TITLE,
  REPORT_ACTION_LABEL,
  REPORT_CATEGORY_OPTIONS,
  REPORT_INTRO,
  buildMarkLost,
  buildReportContent,
  buildReportLastSeen,
  emptyLostDraft,
  feedItemTitle,
  lostAdjective,
  noContactWarning,
  noWayToReachYou,
  reportCategoryLabel,
} from "./lost-view-model";

export function MarkLostForm({
  view,
  busy,
  onCancel,
  onRun,
}: {
  view: PetLostV1;
  busy: boolean;
  onCancel: () => void;
  onRun: RunFn;
}) {
  const [draft, setDraft] = useState<LostDraft>(() => emptyLostDraft());
  const [message, setMessage] = useState<string | null>(null);
  // "Cómo reconocerla" starts folded: every field in it is optional, and the
  // fast path — mark lost now, describe later — should not scroll past six of
  // them to reach the button (custody polish).
  const [describeOpen, setDescribeOpen] = useState(false);

  // THE BACK GESTURE MAY NOT DISCARD A SEARCH IN PROGRESS (A2-alta-asentar-08).
  // Eight free-text fields and five decisions about what gets published, filled
  // in by somebody whose animal is missing — the worst moment in this app to
  // lose a form to a gesture the platform teaches.
  //
  // FLATTENED, because `useIsDirty` compares values and `disclosure` is a nested
  // object: without this the five toggles would be compared by reference and a
  // changed one would read as "nothing typed". The key names do not collide.
  //
  // "Cancelar" IS NOT GUARDED, deliberately, unlike the asiento form's "Elegir
  // otro tipo": that control does not say it discards anything, and this one is
  // the word for exactly that.
  const { disclosure, ...text } = draft;
  useDraftDiscardGuard(useIsDirty({ ...text, ...disclosure }));

  function set<K extends keyof LostDraft>(field: K, value: LostDraft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function toggle(key: keyof LostDraft["disclosure"]) {
    setDraft((current) => ({
      ...current,
      disclosure: { ...current.disclosure, [key]: !current.disclosure[key] },
    }));
  }

  async function submit() {
    const built = buildMarkLost(draft);
    if (!built.ok) {
      setMessage(built.message);
      revealDescription();
      return;
    }
    setMessage(null);
    // NO KEY. `mark_lost` is idempotent on the state — the server refuses an
    // animal already lost — so a header here would be a guarantee nobody has.
    const landed = await onRun(built.input, null);
    if (!landed) revealDescription();
  }

  // A REFUSAL NEVER POINTS AT A FOLDED FIELD (custody polish review). When the
  // check fails — here or on the server, which validates the microchip's
  // format — and anything was typed under "Cómo reconocerla", the fold opens so
  // "Revisá los datos" is read next to what it may be about.
  function revealDescription() {
    const described = [
      draft.color,
      draft.distinguishingFeatures,
      draft.accessoriesWhenLost,
      draft.behaviorNotes,
      draft.lastSeenContext,
      draft.microchipId,
    ].some((value) => value.trim() !== "");
    if (described) setDescribeOpen(true);
  }

  return (
    <>
      <Callout title={`Marcar a ${view.petName} como ${lostAdjective(view.petSex)}`}>
        <Body>
          Su credencial pública va a mostrar el aviso de búsqueda. Abajo elegís qué datos tuyos se
          publican mientras la búsqueda esté activa.
        </Body>
      </Callout>

      {/* UN PUNTO DE REFERENCIA, NO UNA DIRECCIÓN (decisión del PO 2026-09-16),
          y el argumento que la sostiene es del PO: para cuando alguien lea
          esto, el animal YA SE MOVIÓ. El campo no dice dónde está, dice por
          dónde empezar a buscar, así que la exactitud no compra nada y sí
          cuesta: es texto libre, sin validar, y si la persona activa la
          divulgación se publica en la credencial. Alguien que perdió el perro
          en su cuadra escribe la dirección de su casa sin pensarlo.
          EL EJEMPLO ES PARTE DE LA MITIGACIÓN. Decía "Plaza San Martín, Santa
          Rosa": nombraba una localidad, así que invitaba a repetir acá lo que
          el selector de abajo vuelve a pedir, y el PO leyó los dos campos como
          el mismo dato pedido dos veces. No lo son (ver el comentario del
          selector: uno es prosa que lee quien la encuentra, el otro es sobre lo
          que se rutea el caso), pero el ejemplo los hacía parecer uno.
          LA LÍNEA DE ABAJO DICE LAS DOS COSAS de una vez, porque separarlas
          deja a la persona decidiendo con la mitad: que alcanza con una
          referencia, y que esto puede volverse público. No promete que se
          publique: el interruptor está más abajo y arranca apagado
          (consentimiento afirmativo), así que la frase dice "si activás". */}
      <LostPointPicker
        label="Marcá dónde se vio por última vez"
        draft={draft}
        setDraft={setDraft}
        startQuery={view.episode?.jurisdictionLocality ?? null}
        fillJurisdiction
      />
      <TextField
        label="Dónde se vio por última vez"
        value={draft.locationDescription}
        onChangeText={(v) => set("locationDescription", v)}
        placeholder="La plaza, la esquina del kiosco, el portón de casa"
      />
      <Body>
        Con un punto de referencia alcanza: para cuando alguien lo lea, ya se movió. Si más abajo
        activás mostrarlo, este texto se publica en su credencial.
      </Body>

      {/* LA LOCALIDAD DEL HECHO, NO LA DEL ANIMAL. El campo de arriba es prosa
          que lee quien encuentra a la mascota; este es el par sobre el que se
          rutea el caso y sobre el que sale el aviso a las organizaciones. Hasta
          el 2026-09-11 los dos seguían la jurisdicción de la FICHA, así que un
          perro perdido en Córdoba abría un caso en CABA y avisaba a CABA.
          OPCIONAL a propósito: alguien marcando una mascota perdida está
          apurado y asustado, y "no sé exactamente dónde" es una respuesta real
          — el respaldo es una conducta definida, no un agujero. */}
      {/* `required={false}` EXPLÍCITO, y hace falta decirlo: `LocalityPicker`
          nace en `required = true`, así que no pasarlo dibujaba el asterisco
          rojo de obligatorio sobre el campo que el comentario de arriba declara
          opcional — con la línea de abajo explicando, al mismo tiempo, qué pasa
          si lo dejás vacío. La pantalla se contradecía a sí misma en tres
          renglones. Reportado por el PO el 2026-09-16 mirando la app en un
          teléfono. A quien está asustado y apurado, un asterisco lo manda a
          buscar el nombre de su localidad en vez de mandar el aviso. */}
      {/* EL CHIP DE LA LOCALIDAD DE LA FICHA (PO, 2026-09-26): un toque, nunca
          precargado. Viene del servidor ya resuelto por id, y sólo en el camino
          del dueño; tocarlo es exactamente elegir esa fila de la lista. */}
      <LocalityPicker
        required={false}
        provinceCode={draft.provinceCode}
        localityName={draft.localityName}
        suggestion={
          view.homeLocality === null ? null : { locality: view.homeLocality, petName: view.petName }
        }
        onSelect={(selection) => {
          set("provinceCode", selection.provinceCode);
          set("localityName", selection.localityName);
          // Cuál de los 68 homónimos. Sin esto el servidor resuelve por nombre
          // y cae en el primero alfabéticamente, así que el caso llega a una
          // autoridad que nadie eligió.
          set("localityIndecId", selection.localityIndecId);
          set("localityPicked", false);
        }}
      />
      <Body>Si la dejás vacía, la búsqueda cuenta donde vive tu mascota.</Body>

      <TextField
        label="Qué pasó"
        multiline
        value={draft.note}
        onChangeText={(v) => set("note", v)}
        placeholder="Se escapó por el portón"
      />

      <CollapsibleModule
        title="Cómo reconocerla"
        summary="Todo esto es opcional. Podés marcarla ahora y completar después."
        open={describeOpen}
        onToggle={() => setDescribeOpen((open) => !open)}
      >
        <View style={[lostStyles.moduleBody, lostStyles.fields]}>
          <TextField label="Color" value={draft.color} onChangeText={(v) => set("color", v)} />
          <TextField
            label="Señas particulares"
            value={draft.distinguishingFeatures}
            onChangeText={(v) => set("distinguishingFeatures", v)}
            placeholder="Mancha blanca en el pecho"
          />
          <TextField
            label="Qué llevaba puesto"
            value={draft.accessoriesWhenLost}
            onChangeText={(v) => set("accessoriesWhenLost", v)}
            placeholder="Collar rojo con chapita"
          />
          <TextField
            label="Cómo se comporta"
            multiline
            value={draft.behaviorNotes}
            onChangeText={(v) => set("behaviorNotes", v)}
            placeholder="Es miedosa, no se acerca a desconocidos"
          />
          <TextField
            label="Contexto del extravío"
            multiline
            value={draft.lastSeenContext}
            onChangeText={(v) => set("lastSeenContext", v)}
            placeholder="Había tormenta"
          />
          <TextField
            label="Número de microchip"
            mono
            value={draft.microchipId}
            onChangeText={(v) => set("microchipId", v)}
            placeholder="982000123456789"
            autoCapitalize="none"
            autoCorrect={false}
            // `inputMode`, not `keyboardType="numbers-and-punctuation"`: that
            // keyboard type is iOS-only and Android opened QWERTY (forms-F1).
            inputMode="numeric"
          />
        </View>
      </CollapsibleModule>

      {/* NOT FOLDED, unlike the description above: these are the decisions
          about what a stranger reads, and a decision nobody saw is a default
          nobody chose. */}
      <View style={lostStyles.section}>
        <Eyebrow>Qué se muestra en la credencial pública</Eyebrow>
        <Body>
          Nada de esto se publica por defecto. Lo que prendas acá lo ve cualquiera que escanee su QR
          mientras la búsqueda esté activa.
        </Body>
        {(Object.keys(draft.disclosure) as Array<keyof LostDraft["disclosure"]>).map((key) => (
          <DisclosureRow
            key={key}
            row={{ key, value: draft.disclosure[key], editable: true }}
            busy={busy}
            onToggle={() => toggle(key)}
          />
        ))}
      </View>
      {/* THE WEB'S CALLOUT, PORTED (A4-custodia-09). Phone and email start
          OFF, so a privacy-minded person only has to turn the finder form off
          to publish a search nobody can answer — and nothing said so. It is a
          WARNING and not a block: the choice is theirs, and the sentence names
          the option that costs them nothing. */}
      {noWayToReachYou(draft.disclosure) && (
        <Callout tone="warn" title={NO_CONTACT_TITLE}>
          <Body>{noContactWarning(view.petName)}</Body>
        </Callout>
      )}

      {message === null ? null : (
        <Callout tone="err" title="Revisá los datos">
          <Body>{message}</Body>
        </Callout>
      )}

      <PrimaryButton
        label={busy ? "Guardando…" : `Marcar como ${lostAdjective(view.petSex)}`}
        disabled={busy}
        onPress={() => void submit()}
      />
      <SecondaryButton label="Cancelar" disabled={busy} onPress={onCancel} />
    </>
  );
}

/**
 * The lost forms' map point (M17): where the animal was seen, placed by a
 * person on a map — never the phone's own position. Confirming fills the point,
 * the words (if still empty) and, on marcar perdida, the jurisdiction trio when
 * the INDEC catalogue recognises the point. All three stay editable below.
 */
function LostPointPicker({
  label,
  draft,
  setDraft,
  startQuery,
  fillJurisdiction,
}: {
  label: string;
  draft: LostDraft;
  setDraft: (update: (current: LostDraft) => LostDraft) => void;
  startQuery: string | null;
  fillJurisdiction: boolean;
}) {
  const lat = Number.parseFloat(draft.pointLat);
  const lng = Number.parseFloat(draft.pointLng);
  const value: PickedLocation | null =
    Number.isFinite(lat) && Number.isFinite(lng)
      ? {
          lat,
          lng,
          address: draft.locationDescription.trim() || null,
          source: "pin_manual",
          jurisdiction: null,
        }
      : null;
  return (
    <LocationPicker
      label={label}
      value={value}
      startQuery={startQuery}
      onChange={(picked) =>
        setDraft((current) => {
          const next = {
            ...current,
            pointLat: picked ? String(picked.lat) : "",
            pointLng: picked ? String(picked.lng) : "",
          };
          if (picked?.address && current.locationDescription.trim() === "") {
            next.locationDescription = picked.address;
          }
          const j = picked?.jurisdiction;
          if (fillJurisdiction && j?.localityIndecId) {
            next.provinceCode = j.provinceCode;
            next.localityName = j.localityName;
            next.localityIndecId = j.localityIndecId;
            next.localityPicked = picked?.localityPicked === true;
          }
          return next;
        })
      }
    />
  );
}

export function ReportForm({
  busy,
  onCancel,
  onRun,
  startQuery,
}: {
  busy: boolean;
  onCancel: () => void;
  onRun: RunFn;
  /** The case's locality, where the map opens (M17). */
  startQuery: string | null;
}) {
  const [draft, setDraft] = useState<LostDraft>(() => emptyLostDraft());
  const [message, setMessage] = useState<string | null>(null);
  // ONE key for this whole avistaje. `useRef` and not `useState` because a
  // re-render must not be able to produce a different key, and nothing renders
  // from it.
  const attempt = useRef(createAttemptSession());

  async function submit() {
    const built = buildReportLastSeen(draft);
    if (!built.ok) {
      setMessage(built.message);
      return;
    }
    setMessage(null);
    await onRun(built.input, attempt.current.key());
  }

  return (
    <>
      <Callout title="Actualizar dónde se vio">
        <Body>
          Se agrega como un avistaje más a la búsqueda. Los avistajes no se editan ni se borran.
        </Body>
      </Callout>

      <LostPointPicker
        label="Marcá dónde se vio"
        draft={draft}
        setDraft={setDraft}
        startQuery={startQuery}
        fillJurisdiction={false}
      />
      <TextField
        label="Dónde"
        value={draft.locationDescription}
        onChangeText={(v) => setDraft((c) => ({ ...c, locationDescription: v }))}
        placeholder="Cerca de la plaza"
      />
      <TextField
        label="Qué te contaron"
        multiline
        value={draft.note}
        onChangeText={(v) => setDraft((c) => ({ ...c, note: v }))}
        placeholder="Un vecino contó que cruzó la avenida"
      />

      {message === null ? null : (
        <Callout tone="err" title="Revisá los datos">
          <Body>{message}</Body>
        </Callout>
      )}

      <PrimaryButton
        label={busy ? "Guardando…" : "Guardar avistaje"}
        disabled={busy}
        onPress={() => void submit()}
      />
      <SecondaryButton label="Cancelar" disabled={busy} onPress={onCancel} />
    </>
  );
}

/**
 * REPORTAR UN MENSAJE — the moderation pane.
 *
 * ONE CATEGORY, OPTIONAL WORDS, ONE BUTTON. There is no "block" and no "stop
 * accepting messages": the two reportable kinds are written by ANONYMOUS people
 * who scanned a QR in the street, so there is no account to block — and a valve
 * that closed the channel would be a defence nobody uses at the moment they need
 * it, because an owner searching for their animal will not shut off the message
 * that might find it.
 *
 * NO CONFIRMATION STEP, unlike "marcar encontrada". That one is a two-step
 * because a mis-tap closes a search and notifies everybody who was looking; this
 * one removes a row from one person's own list and notifies nobody. Making a
 * safety affordance harder to reach than it needs to be is its own failure.
 *
 * NO IDEMPOTENCY KEY — the command is idempotent on the state, and a double tap
 * answers `changed: false` with its own sentence.
 *
 * THE MOTIVES ARE THE KIT'S `Choice` (custody polish), the radio group every
 * other form in the app uses, instead of a hand-rolled list of pressables.
 * Nothing is preselected: `Elegí un motivo.` still guards an empty send.
 */
export function ReportContentForm({
  item,
  petSex,
  busy,
  onCancel,
  onRun,
}: {
  item: LostFeedItemV1;
  /** The animal's sex, so the echoed row title agrees with it. */
  petSex: string | null;
  busy: boolean;
  onCancel: () => void;
  onRun: RunFn;
}) {
  const [category, setCategory] = useState<ContentReportCategory | null>(null);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function submit() {
    if (category === null) {
      setMessage("Elegí un motivo.");
      return;
    }
    const built = buildReportContent(item.id, category, reason);
    if (!built.ok) {
      setMessage(built.message);
      return;
    }
    setMessage(null);
    await onRun(built.input, null);
  }

  return (
    <>
      {/* The heading NAMES the pane and the button NAMES the act, and the two
          are deliberately different strings. Both reading "Reportar" put two
          identical labels on one screen — invisible to a sighted person and
          genuinely ambiguous to anybody navigating by label. */}
      <Callout title="Reportar un mensaje">
        {/* The row being reported, echoed — a list of five motives with no
            reminder of WHICH message they are about is how somebody reports the
            wrong one. */}
        <Body>{feedItemTitle(item, petSex)}</Body>
        <MetaLine>{formatIsoDateTime(item.at)}</MetaLine>
        <Body>{REPORT_INTRO}</Body>
      </Callout>

      <Choice
        label="¿Qué pasa con este mensaje?"
        options={REPORT_CATEGORY_OPTIONS}
        selected={category}
        optionLabel={reportCategoryLabel}
        onSelect={setCategory}
        disabled={busy}
      />

      <TextField
        label="Contanos más (opcional)"
        multiline
        value={reason}
        onChangeText={setReason}
        placeholder="Lo que quieras agregar"
      />

      {message === null ? null : (
        <Callout tone="err" title="Revisá los datos">
          <Body>{message}</Body>
        </Callout>
      )}

      <PrimaryButton
        label={busy ? "Enviando…" : REPORT_ACTION_LABEL}
        disabled={busy}
        onPress={() => void submit()}
      />
      <SecondaryButton label="Cancelar" disabled={busy} onPress={onCancel} />
    </>
  );
}
