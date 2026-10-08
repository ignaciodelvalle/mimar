// The LIBRETA face of one pet — the ledger of asientos.
//
// THE BACK FACE, AND THE ONE THE PRODUCT IS NAMED AFTER. Since the two-face
// rewrite (PO decision, 2026-08-28) this renders INSIDE the document chrome as
// "Libreta · dorso" — the back of the same physical card whose front is the
// credential — rather than as a standalone tab. The content is what it always
// was: what is coming due, and every asiento the animal has, newest first.
// (`PetDocumentScreen` owns the scroll view and the chrome; this face brings
// its own read, its own failure copy and its own write.)
//
// EVERY SECTION FAILS ON ITS OWN, with the same contract the other two faces
// use: `unavailable` means the server could not read it — NOT that it is empty.
// "Todavía no hay asientos en esta libreta" is a fact about the animal; "No se
// pudo leer esta sección" is a fact about the read; and a section rendered as an
// empty View would be telling the owner the first while the server meant the
// second.
//
// NOTHING IS RE-DERIVED HERE. The order of the ledger, the content of each
// asiento, its provenance stamp and its date words all arrive composed — they
// are Argentine-calendar and whitelist decisions the server owns, and a phone
// travelling with its owner must not renumber an animal's dates. What this
// screen owns is the copy AROUND them and the honest empty states.
//
// NOT CACHED, the same v1 decision `PetDocumentScreen` records: this payload is a
// different privacy class from the public credential, and `credential-cache.ts`'s
// justification does not carry over. A failed read says so and offers a retry.

import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { LibretaEntryV1, LibretaVaccinationSection } from "@dim/contract/api";
import { apiFailureMessage } from "../api/client";
import { fetchPetLibreta } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body, Card, LABEL_VALUE_FLEX, Row, StaleNotice, Unavailable } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { LinkText } from "../ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../ui/reload-state";
import { ROUTES, libretaEventRoute } from "../ui/routes";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TRACKING, TYPE } from "../ui/theme";
import { LibretaFaceSkeleton } from "./DocumentSkeletons";
import {
  LEDGER_EMPTY_LABEL,
  LIBRETA_EMPTY_LABEL,
  LIBRETA_TRUNCATED_NOTE,
  type LibretaView,
  REQUEST_VERIFICATION_LABEL,
  amendedLabel,
  buildLibretaView,
  groupLedgerEntries,
  ledgerCountLabel,
  offersVerificationRequest,
  otherVaccinesNote,
  tripPapersTickLabel,
  upcomingDueLabel,
  upcomingRemainingLabel,
  upcomingRowLabel,
  vaccineCounts,
  vaccineRowLabel,
} from "./libreta-view-model";
import type { SectionView } from "./owner-face-view-model";

type ScreenState =
  | { phase: "loading" }
  | ReadyState<LibretaView>
  | { phase: "failed"; message: string };

/** One sentence per failure arm. No arm may fall through to a generic shrug. */
export function LibretaScreen({
  publicToken,
  deceased = false,
  refreshNonce = 0,
  onRefreshSettled,
}: {
  publicToken: string;
  /**
   * The animal's lifecycle status, from the document that owns this face.
   *
   * A PROP AND NOT A SECOND READ: `PetDocumentScreen` already holds
   * `status.petStatus` and re-reading it here would be a second place the two
   * could disagree — on the one question where disagreeing is unbearable. The
   * libreta's own payload carries no lifecycle status at all (its `status` field
   * is a VACCINE's), which is why nothing here could tell before (S-3).
   */
  deceased?: boolean;
  /**
   * Bumped by `PetDocumentScreen`'s pull-to-refresh. A PROP and not a `key`:
   * keying this face by the counter remounted it, so a pull threw the ledger
   * away and drew "Leyendo la libreta…" over the face it was refreshing.
   */
  refreshNonce?: number;
  /** Called when the refresh this face owns has landed, so the document's
   *  platform spinner stops on the read the reader is actually looking at. */
  onRefreshSettled?: () => void;
}) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  // Which "Ver cada cambio" lists are open, by group key. HELD HERE, not in the
  // group: every focus re-reads the libreta and a first read unmounts the
  // ledger, so a group's own state came back collapsed after opening one change
  // (QA v14 P2b). This component stays mounted under the pushed detail screen.
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  // Guards against a stale response overwriting a newer one when a focus and a
  // pull overlap — the same generation counter its sibling screens use, for
  // the same reason. (It guarded a double-tapped "Actualizar" until
  // 2026-09-03; the button is gone, the race is not.)
  const generation = useRef(0);
  // The settle callback must not re-run the refresh effect when the parent
  // hands down a new closure; a ref keeps the effect keyed on the nonce alone.
  const settled = useRef(onRefreshSettled);
  settled.current = onRefreshSettled;

  const load = useCallback(
    async (mode: "initial" | "refresh" = "initial") => {
      const mine = ++generation.current;
      // A refresh leaves the ledger on screen; only a first read has nothing
      // to show.
      if (mode === "initial") setState({ phase: "loading" });
      const result = await fetchPetLibreta(sessionPort, publicToken);
      if (mine !== generation.current) return;
      if (mode === "refresh") settled.current?.();
      if (result.outcome === "ok") {
        setState(loaded(buildLibretaView(result.payload)));
        return;
      }
      // KEEPING THE LEDGER (S-2). A vet with one bar reading a vaccination
      // history must not lose it because the re-read on focus failed: the
      // asientos are already on the phone and every one of them is still true.
      setState((current) =>
        reloadFailed(current, result, apiFailureMessage(result) ?? "No pudimos leer esta libreta."),
      );
    },
    [publicToken],
  );

  // ON FOCUS, NOT ONLY ON MOUNT: writing an asiento pushes a route on top of
  // this face (from the credential's Anotar); coming back does not remount, so
  // a plain mount effect would leave the owner staring at the libreta they
  // just added to, unchanged. The generation counter already makes a
  // redundant load harmless.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // The pull the document owns. The ref is what makes a MOUNT with a nonce
  // already set inert: `useFocusEffect` above already reads on every mount, so
  // a face that mounts after a pull fired anywhere (the nonce is shared with
  // the front face) would otherwise fire that focus read AND this effect —
  // two calls, the first discarded by the generation guard, the second's
  // settle callback clearing a spinner for a pull that already finished. Only
  // a nonce CHANGE while this face stays mounted is a pull to honour.
  const handledNonce = useRef(refreshNonce);
  useEffect(() => {
    if (refreshNonce === handledNonce.current) return;
    handledNonce.current = refreshNonce;
    void load("refresh");
  }, [refreshNonce, load]);

  // No <Screen> of its own since the two-face rewrite: PetDocumentScreen owns
  // the one scroll view, and this face renders inside the card's body.
  //
  // NO WRITE BUTTON HERE (PO annotate 2026-10-05). Anotar lives on the
  // credential face's primary row below the card — one door, one verb. The
  // dorso is the ledger.
  return (
    <View style={styles.faceBody}>
      {state.phase === "loading" ? <LibretaFaceSkeleton /> : null}
      {state.phase === "failed" ? (
        <Card title="No disponible">
          <Body>{state.message}</Body>
        </Card>
      ) : null}
      {state.phase === "ready" && state.staleFailure !== null ? (
        <StaleNotice message={state.staleFailure} onRetry={() => void load("refresh")} />
      ) : null}
      {state.phase === "ready" ? (
        <LibretaBody
          view={state.view}
          deceased={deceased}
          expandedGroups={expandedGroups}
          onToggleGroup={toggleGroup}
        />
      ) : null}
    </View>
  );
}

/** Renders a section, or its refusal. The two are never the same view. */
function Section<T>({
  view,
  title,
  children,
}: {
  view: SectionView<T>;
  title: string;
  children: (data: T) => React.ReactNode;
}) {
  if (view.state === "unavailable") {
    return <Unavailable title={title} message={view.message} />;
  }
  return <Card title={title}>{children(view.data)}</Card>;
}

function LibretaBody({
  view,
  deceased,
  expandedGroups,
  onToggleGroup,
}: {
  view: LibretaView;
  deceased: boolean;
  expandedGroups: ReadonlySet<string>;
  onToggleGroup: (key: string) => void;
}) {
  const router = useRouter();
  // Frozen at mount and threaded into every relative label, so a screen sitting
  // on a day boundary cannot flip "Mañana" to "Hoy" between re-renders. The web
  // libreta face freezes its own `now` for exactly this.
  const [now] = useState(() => new Date());

  const upcomingItems = !deceased && view.upcoming.state === "ok" ? view.upcoming.data.items : [];
  const entries = view.timeline.state === "ok" ? view.timeline.data.entries : [];
  const bothSectionsRead = view.upcoming.state === "ok" && view.timeline.state === "ok";
  const isEmpty = bothSectionsRead && upcomingItems.length === 0 && entries.length === 0;

  return (
    <>
      {/* THE MASTHEAD — name only. The band already says "Libreta · dorso";
          repeating "Libreta sanitaria" + the DIM token here was noise
          (PO annotate 2026-10-05). */}
      {view.identity.state === "unavailable" ? (
        <Unavailable title="Identidad" message={view.identity.message} />
      ) : (
        <View style={styles.masthead}>
          <Text style={styles.petName}>{view.identity.data.name}</Text>
        </View>
      )}

      {/* VACUNAS ---------------------------------------------------------- */}
      <Section view={view.vaccination} title="Estado de vacunación">
        {(vaccination) => (
          <>
            <VaccineCounts vaccination={vaccination} />
            {vaccination.missing > 0 ? (
              <Body>
                {vaccination.missing === 1
                  ? "1 vacuna del calendario recomendado sin aplicar"
                  : `${vaccination.missing} vacunas del calendario recomendado sin aplicar`}
              </Body>
            ) : null}
            {/* No calendar for this species in our reference data: list only
                what was recorded and say so, never an invented schedule. */}
            {vaccination.calendarNote ? <Body>{vaccination.calendarNote}</Body> : null}
            {vaccination.perVaccine.length === 0 ? (
              <Body>No hay vacunas del catálogo registradas.</Body>
            ) : (
              vaccination.perVaccine.map((vaccine) => (
                <Row
                  key={vaccine.vaccineName}
                  label={vaccine.vaccineName}
                  value={vaccineRowLabel(vaccine)}
                />
              ))
            )}
            {/* A dose the catalog could not identify does not move the verdict
                above and must not disappear either. */}
            {otherVaccinesNote(vaccination) ? <Body>{otherVaccinesNote(vaccination)}</Body> : null}
          </>
        )}
      </Section>

      {isEmpty ? (
        <Card>
          <Body>{LIBRETA_EMPTY_LABEL}</Body>
        </Card>
      ) : null}

      {/* PRÓXIMO ----------------------------------------------------------
          NOT DRAWN FOR A DEAD ANIMAL (S-3). The server keeps computing the next
          due date — the schedule is a property of the vaccine, not of the
          patient — and the libreta printed "Vacuna antirrábica · Vence en 43
          días" under the name of an animal whose memorial is on the other face.
          The history STAYS: the asientos below are the record, and the record
          does not end when the animal does. It is only the FUTURE that is no
          longer anybody's to act on.

          EMPTY → NOTHING (PO annotate 2026-10-05). "No hay nada programado."
          was a titled box announcing an absence; hide the section until there
          is something due. A FAILED read still surfaces its refusal. */}
      {deceased ? null : view.upcoming.state === "ok" && upcomingItems.length === 0 ? null : (
        <Section view={view.upcoming} title="Próximo">
          {(upcoming) => (
            <View style={styles.upcoming}>
              {upcoming.items.map((item) => {
                // One row per medication course; the rest of it is a count.
                const remaining = upcomingRemainingLabel(item);
                return (
                  <View key={item.id}>
                    <Row label={upcomingRowLabel(item)} value={upcomingDueLabel(item.dueAt, now)} />
                    {remaining === null ? null : (
                      <Text style={styles.upcomingNote}>{remaining}</Text>
                    )}
                  </View>
                );
              })}
            </View>
          )}
        </Section>
      )}

      {/* The directional divider the web prints between the two halves. A bare
          "hoy" read as a date tag for the row above it. */}
      {upcomingItems.length > 0 && entries.length > 0 ? (
        <Text style={styles.divider}>próximo ↑ · hoy · historia ↓</Text>
      ) : null}

      {/* ASIENTOS --------------------------------------------------------- */}
      {/* The COUNT is inside the ok branch on purpose: a section that could not
          be read must not be titled "Asientos · 0 registros", which is a claim
          about the animal made by a failed read. */}
      <Section view={view.timeline} title="Asientos">
        {(timeline) =>
          timeline.entries.length === 0 ? (
            <Body>{LEDGER_EMPTY_LABEL}</Body>
          ) : (
            <View style={styles.entries}>
              <Text style={styles.ledgerCount}>{ledgerCountLabel(timeline.entries.length)}</Text>
              {/* DRAWN, not stored: consecutive "Lo tengo" ticks of one trip
                  on one day are one row ("… · 3 cambios · Chile") that opens
                  the newest of them. The count above stays the log's. */}
              {groupLedgerEntries(timeline.entries).map((item) => {
                const entry = item.kind === "entry" ? item.entry : item.entries[0];
                if (entry === undefined) return null;
                const open = (eventId: string) =>
                  router.push(libretaEventRoute(view.publicToken, eventId));
                const onRequestVerification = view.onOwnerPath
                  ? () => router.push(ROUTES.buscarTurnos)
                  : null;
                if (item.kind === "papers") {
                  return (
                    <PapersGroup
                      key={entry.eventId}
                      label={item.label}
                      entries={item.entries}
                      onOpen={open}
                      expanded={expandedGroups.has(item.key)}
                      onToggle={() => onToggleGroup(item.key)}
                    />
                  );
                }
                return (
                  <EntryCard
                    key={entry.eventId}
                    entry={entry}
                    onOpen={() => open(entry.eventId)}
                    onRequestVerification={onRequestVerification}
                  />
                );
              })}
              {/* A ledger that shows some of what exists must SAY so. */}
              {timeline.truncated ? <Body>{LIBRETA_TRUNCATED_NOTE}</Body> : null}
            </View>
          )
        }
      </Section>
    </>
  );
}

/**
 * One asiento.
 *
 * THE WHOLE CARD IS THE CONTROL, so the tap target is the record rather than a
 * link at its foot — and it announces itself as a button with the record's own
 * name, because "Ver detalle" repeated eleven times tells a screen reader
 * nothing.
 */
function VaccineCounts({ vaccination }: { vaccination: LibretaVaccinationSection }) {
  const counts = vaccineCounts(vaccination);
  const cells: Array<{
    label: string;
    count: number;
    ink: string;
    surface: string;
    border: string;
  }> = [
    {
      label: "Vigente",
      count: counts.vigente,
      ink: COLORS.okInk,
      surface: COLORS.okSurface,
      border: COLORS.okBorder,
    },
    {
      label: "Por vencer",
      count: counts.porVencer,
      ink: COLORS.warnInk,
      surface: COLORS.warnSurface,
      border: COLORS.warnBorder,
    },
    {
      label: "Vencida",
      count: counts.vencida,
      ink: COLORS.danger,
      surface: COLORS.dangerSurface,
      border: COLORS.dangerBorder,
    },
    {
      label: "Sin confirmar",
      count: counts.sinConfirmar,
      ink: COLORS.inkSoft,
      surface: COLORS.canvas2,
      border: COLORS.border,
    },
  ];
  return (
    <View style={styles.vacGrid}>
      {cells.map((cell) => {
        const quiet = cell.count === 0;
        return (
          <View
            key={cell.label}
            style={[
              styles.vacCell,
              quiet
                ? { backgroundColor: COLORS.canvas2, borderColor: COLORS.border }
                : { backgroundColor: cell.surface, borderColor: cell.border },
            ]}
          >
            <Text style={[styles.vacCount, { color: quiet ? COLORS.inkMuted : cell.ink }]}>
              {cell.count}
            </Text>
            <Text style={[styles.vacLabel, { color: quiet ? COLORS.inkMuted : cell.ink }]}>
              {cell.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function EntryCard({
  entry,
  title = entry.title,
  onOpen,
  onRequestVerification,
}: {
  entry: LibretaEntryV1;
  /** Overrides the asiento's own title — only a collapsed run of ticks does. */
  title?: string;
  onOpen: () => void;
  /**
   * Where "Pedir verificación" goes, for the asientos that offer it; `null`
   * withholds it (an organization's reader — the web's WalkInHistory rule).
   */
  onRequestVerification: (() => void) | null;
}) {
  const showKind =
    entry.kind.trim().toLocaleLowerCase("es") !== title.trim().toLocaleLowerCase("es");
  const facts = entry.facts.filter(
    (fact) =>
      !((fact.key === "Fecha" || fact.key === "Aplicada") && fact.value === entry.whenAbsolute),
  );
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${entry.whenAbsolute}. Ver detalle`}
      style={styles.entry}
    >
      <View style={styles.entryHead}>
        <View style={styles.entryTitles}>
          {showKind ? <Text style={styles.entryKind}>{entry.kind}</Text> : null}
          <Text style={styles.entryTitle}>{title}</Text>
        </View>
        <Text style={styles.entryWhen}>
          {entry.whenRelative}
          {"\n"}
          {entry.whenAbsolute}
        </Text>
      </View>

      {facts.map((fact) => (
        <FactRow key={fact.key} fact={fact} />
      ))}

      {entry.note ? <Body>{entry.note}</Body> : null}

      <Text style={styles.provenance}>{entry.provenance.label}</Text>
      {entry.warning ? <Text style={styles.warning}>{entry.warning}</Text> : null}
      {/* THE WEB'S "Pedir verificación →" (AsientoCard): an unverified rabies
          dose links to finding a turno, where a professional can sign it.
          `/turnos/buscar` takes no service parameter yet, so it opens on the
          service picker rather than preselecting the antirrábica. */}
      {onRequestVerification !== null && offersVerificationRequest(entry) ? (
        <LinkText
          onPress={onRequestVerification}
          accessibilityHint="Abre la búsqueda de turnos para que un profesional la verifique"
        >
          {REQUEST_VERIFICATION_LABEL}
        </LinkText>
      ) : null}
      {/* The values above are ALREADY corrected; this says a correction
          happened, which is the half a corrected value cannot say alone. */}
      {entry.amendedAt ? <Text style={styles.amended}>{amendedLabel(entry.amendedAt)}</Text> : null}
      {entry.hasAttachment ? <Text style={styles.attachment}>Tiene un archivo adjunto</Text> : null}
    </Pressable>
  );
}

/**
 * A run of trip-papers ticks drawn as ONE row — and every tick still reachable.
 *
 * The card is the newest tick, retitled "… · N cambios · <país>". Under it,
 * "Ver cada cambio" unfolds one link per tick, so collapsing the drawing never
 * takes away a record's own detail page (the web's disclosure, same words).
 */
function PapersGroup({
  label,
  entries,
  onOpen,
  expanded,
  onToggle,
}: {
  label: string;
  entries: LibretaEntryV1[];
  onOpen: (eventId: string) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const head = entries[0];
  if (head === undefined) return null;
  return (
    <View>
      <EntryCard
        entry={head}
        title={label}
        onOpen={() => onOpen(head.eventId)}
        onRequestVerification={null}
      />
      <View style={styles.papersTicks}>
        <LinkText
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityHint={expanded ? "Oculta la lista" : "Muestra un enlace por cada cambio"}
        >
          {expanded ? "Ocultar los cambios" : "Ver cada cambio"}
        </LinkText>
        {expanded
          ? entries.map((entry, index) => (
              <LinkText key={entry.eventId} onPress={() => onOpen(entry.eventId)}>
                {tripPapersTickLabel(index, entries.length)}
              </LinkText>
            ))
          : null}
      </View>
    </View>
  );
}

/**
 * One key/value line of an asiento, HONOURING the two flags the payload sends.
 *
 * `missing` renders faint, because "Sin dato" set like every other value reads
 * as a value somebody entered — the web draws exactly this distinction, and the
 * flag exists on the wire so a client does not have to string-match the
 * placeholder to find it. `mono` is for codes: a batch number in a proportional
 * face is a batch number people misread.
 */
function FactRow({ fact }: { fact: LibretaEntryV1["facts"][number] }) {
  return (
    <View style={styles.factRow}>
      <Text style={styles.factLabel}>{fact.key}</Text>
      <Text
        style={[
          styles.factValue,
          fact.missing ? styles.factMissing : null,
          fact.mono ? styles.factMono : null,
        ]}
      >
        {fact.value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // The face's inner rhythm — the web's `.ln-sec` phone padding (20/18), with
  // the Screen's old inter-block gap kept between sections.
  faceBody: { paddingVertical: 20, paddingHorizontal: 18, gap: SPACE.lg },
  masthead: { gap: SPACE.xs },
  petName: {
    fontFamily: FONTS.serif,
    fontSize: TYPE.xl2,
    lineHeight: TYPE.xl2 * LEADING.xl2,
    color: COLORS.ink,
  },
  vacGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  vacCell: {
    flexBasis: "47%",
    flexGrow: 1,
    borderWidth: 1,
    borderRadius: RADIUS.control,
    paddingVertical: 10,
    paddingHorizontal: 8,
    alignItems: "center",
  },
  vacCount: { fontFamily: FONTS.monoSemibold, fontSize: TYPE.lg },
  vacLabel: { fontFamily: FONTS.sans, fontSize: TYPE.xs, textAlign: "center" },
  upcoming: {
    borderLeftWidth: 3,
    borderLeftColor: COLORS.accent,
    paddingLeft: 10,
    gap: SPACE.sm,
  },
  // "quedan N dosis" under a medication course's row: muted, and set under the
  // LABEL column it qualifies rather than under the date.
  upcomingNote: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.inkMuted },
  divider: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.sm,
    color: COLORS.inkFaint,
    textAlign: "center",
    paddingVertical: SPACE.xs,
  },
  entries: { gap: 0 },
  papersTicks: { gap: SPACE.sm, paddingVertical: SPACE.sm },
  ledgerCount: { fontFamily: FONTS.mono, fontSize: TYPE.sm, color: COLORS.inkMuted },
  // The `Row` primitive's label/value contract (see LABEL_VALUE_FLEX in
  // ui/components.tsx): the label gives way, the value keeps its words.
  factRow: { flexDirection: "row", justifyContent: "space-between", gap: SPACE.md },
  factLabel: {
    ...LABEL_VALUE_FLEX.label,
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    color: COLORS.inkMuted,
  },
  factValue: {
    ...LABEL_VALUE_FLEX.value,
    fontFamily: FONTS.sansSemibold,
    fontSize: TYPE.sm,
    color: COLORS.ink,
    textAlign: "right",
  },
  factMissing: { fontFamily: FONTS.sans, color: COLORS.inkFaint },
  factMono: { fontFamily: FONTS.mono },
  entry: {
    minHeight: TOUCH_TARGET,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
    paddingVertical: SPACE.sm,
    gap: SPACE.xs,
  },
  entryHead: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  entryTitles: { flex: 1, gap: 2 },
  entryKind: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * TRACKING.wider,
    textTransform: "uppercase",
    color: COLORS.inkMuted,
  },
  entryTitle: {
    fontFamily: FONTS.sansSemibold,
    fontSize: 15,
    lineHeight: 15 * 1.25,
    color: COLORS.ink,
  },
  entryWhen: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    color: COLORS.inkMuted,
    textAlign: "right",
  },
  provenance: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.inkSoft },
  warning: { fontFamily: FONTS.sansSemibold, fontSize: TYPE.sm, color: COLORS.warnInk },
  amended: { fontFamily: FONTS.sansSemibold, fontSize: TYPE.sm, color: COLORS.accent },
  attachment: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.inkMuted },
});
