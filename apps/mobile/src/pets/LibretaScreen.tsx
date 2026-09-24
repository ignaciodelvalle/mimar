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

import type { LibretaEntryV1, PetLibretaV1 } from "@dim/contract/api";
import type { ApiResult } from "../api/client";
import { fetchPetLibreta } from "../api/endpoints";
import { apiErrorMessage } from "../api/error-copy";
import { sessionPort } from "../auth/session-store";
import { Body, Card, Loading, Row, StaleNotice, Unavailable } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { PrimaryButton } from "../ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../ui/reload-state";
import { libretaEventRoute, recordEventRoute } from "../ui/routes";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TRACKING, TYPE } from "../ui/theme";
import {
  LEDGER_EMPTY_LABEL,
  LIBRETA_EMPTY_LABEL,
  LIBRETA_IMMUTABILITY_NOTE,
  LIBRETA_TRUNCATED_NOTE,
  type LibretaView,
  UPCOMING_EMPTY_LABEL,
  amendedLabel,
  buildLibretaView,
  ledgerCountLabel,
  otherVaccinesNote,
  speciesLine,
  upcomingDueLabel,
  upcomingKindLabel,
  vaccinationHeadline,
  vaccineStatusLabel,
} from "./libreta-view-model";
import type { SectionView } from "./owner-face-view-model";

type ScreenState =
  | { phase: "loading" }
  | ReadyState<LibretaView>
  | { phase: "failed"; message: string };

/** One sentence per failure arm. No arm may fall through to a generic shrug. */
function failureMessage(result: ApiResult<PetLibretaV1>): string {
  switch (result.outcome) {
    case "api-error":
      return apiErrorMessage(result.code);
    case "unsupported-version":
      return "Esta versión de la app no puede leer la libreta de esta mascota. Actualizá la app.";
    case "malformed":
      return "La respuesta del servidor no se pudo leer.";
    case "unreachable":
      return "No pudimos conectarnos. Revisá tu conexión.";
    default:
      return "No pudimos leer esta libreta.";
  }
}

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
  const router = useRouter();
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
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
      // to show. `PrimaryButton`'s "Asentar" keys off this phase too, so
      // resetting it on a pull also disabled the one control this face offers.
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
      setState((current) => reloadFailed(current, result, failureMessage(result)));
    },
    [publicToken],
  );

  // ON FOCUS, NOT ONLY ON MOUNT, and that changed the day this screen grew a
  // write. "Asentar" pushes a route on top of this one; coming back does not
  // remount, so a plain mount effect would leave the owner staring at the
  // libreta they just added to, unchanged, wondering whether it saved. The
  // generation counter already makes a redundant load harmless.
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
  return (
    <View style={styles.faceBody}>
      {/* THE WRITE, offered from the face it writes into, and now the ONLY
          control here. It is the reason a person opens the libreta on a phone,
          so it keeps its primary weight. Offered even while the read failed —
          a section this app could not load says nothing about whether the
          animal was vaccinated this morning, and the server is the one that
          decides whether the write is allowed.
          "Actualizar" used to sit under it and is gone (2026-09-03). The two
          were never the same kind of thing: this is an act, that was
          maintenance dressed as one, and the platform already has a gesture
          for maintenance. The read still has a way to happen —
          `PetDocumentScreen` hands this face a refresh nonce, and a pull
          re-runs the read underneath the ledger instead of replacing it.

          ABOVE THE LEDGER, NOT UNDER IT (native QA batch 1, D2). It used to be
          the LAST child of this face, which is fine on the pet the fixtures use
          and wrong on a real one: an animal with 26 asientos puts its whole
          history between the reader and the only thing they came here to do,
          and this face lives inside `PetDocumentScreen`'s single scroll view,
          so there is no per-face scroll for it to sit at the bottom of. The
          ledger has no fixed height and the action does, so the action is the
          one that can be placed. Kept as the same PrimaryButton in the same
          flow rather than pinned: the kit has no sticky-footer primitive, and
          inventing one for a control that now needs no scrolling would be a new
          pattern bought for nothing. */}
      <PrimaryButton
        label="Asentar"
        onPress={() => router.push(recordEventRoute(publicToken))}
        disabled={state.phase === "loading"}
      />
      {state.phase === "loading" ? <Loading label="Leyendo la libreta…" /> : null}
      {state.phase === "failed" ? (
        <Card title="No disponible">
          <Body>{state.message}</Body>
        </Card>
      ) : null}
      {state.phase === "ready" && state.staleFailure !== null ? (
        <StaleNotice message={state.staleFailure} onRetry={() => void load("refresh")} />
      ) : null}
      {state.phase === "ready" ? <LibretaBody view={state.view} deceased={deceased} /> : null}
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

function LibretaBody({ view, deceased }: { view: LibretaView; deceased: boolean }) {
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
      {/* THE MASTHEAD ---------------------------------------------------- */}
      <Section view={view.identity} title="Libreta sanitaria">
        {(identity) => (
          <>
            <Text style={styles.petName}>{identity.name}</Text>
            <Text style={styles.token}>{identity.publicToken}</Text>
            {speciesLine(identity) ? <Body>{speciesLine(identity)}</Body> : null}
          </>
        )}
      </Section>

      {/* VACUNAS ---------------------------------------------------------- */}
      <Section view={view.vaccination} title="Vacunación">
        {(vaccination) => (
          <>
            <Text style={styles.stamp}>{vaccinationHeadline(vaccination)}</Text>
            {vaccination.perVaccine.length === 0 ? (
              <Body>No hay vacunas del catálogo registradas.</Body>
            ) : (
              vaccination.perVaccine.map((vaccine) => (
                <Row
                  key={vaccine.vaccineName}
                  label={vaccine.vaccineName}
                  value={vaccineStatusLabel(vaccine.status)}
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
          longer anybody's to act on. */}
      {deceased ? null : (
        <Section view={view.upcoming} title="Próximo">
          {(upcoming) =>
            upcoming.items.length === 0 ? (
              <Body>{UPCOMING_EMPTY_LABEL}</Body>
            ) : (
              <>
                {upcoming.items.map((item) => (
                  <Row
                    key={item.id}
                    label={`${upcomingKindLabel(item.kind)} · ${item.label}`}
                    value={upcomingDueLabel(item.dueAt, now)}
                  />
                ))}
              </>
            )
          }
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
              {timeline.entries.map((entry) => (
                <EntryCard
                  key={entry.eventId}
                  entry={entry}
                  onOpen={() => router.push(libretaEventRoute(view.publicToken, entry.eventId))}
                />
              ))}
              {/* A ledger that shows some of what exists must SAY so. */}
              {timeline.truncated ? <Body>{LIBRETA_TRUNCATED_NOTE}</Body> : null}
            </View>
          )
        }
      </Section>

      <Text style={styles.immutability}>{LIBRETA_IMMUTABILITY_NOTE}</Text>
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
function EntryCard({ entry, onOpen }: { entry: LibretaEntryV1; onOpen: () => void }) {
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${entry.title}, ${entry.whenAbsolute}. Ver detalle`}
      style={styles.entry}
    >
      <Text style={styles.entryKind}>{entry.kind}</Text>
      <Text style={styles.entryTitle}>{entry.title}</Text>
      <Text style={styles.entryWhen}>
        {entry.whenRelative} · {entry.whenAbsolute}
      </Text>

      {entry.facts.map((fact) => (
        <FactRow key={fact.key} fact={fact} />
      ))}

      {entry.note ? <Body>{entry.note}</Body> : null}

      <Text style={styles.provenance}>{entry.provenance.label}</Text>
      {entry.warning ? <Text style={styles.warning}>{entry.warning}</Text> : null}
      {/* The values above are ALREADY corrected; this says a correction
          happened, which is the half a corrected value cannot say alone. */}
      {entry.amendedAt ? <Text style={styles.amended}>{amendedLabel(entry.amendedAt)}</Text> : null}
      {entry.hasAttachment ? <Text style={styles.attachment}>Tiene un archivo adjunto</Text> : null}
    </Pressable>
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
  petName: {
    fontFamily: FONTS.serif,
    fontSize: TYPE.xl2,
    lineHeight: TYPE.xl2 * LEADING.xl2,
    color: COLORS.ink,
  },
  token: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.sm,
    letterSpacing: TYPE.sm * TRACKING.wide,
    color: COLORS.inkMuted,
  },
  stamp: {
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.lg,
    letterSpacing: TYPE.lg * TRACKING.wide,
    color: COLORS.ink,
  },
  divider: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.sm,
    color: COLORS.inkFaint,
    textAlign: "center",
    paddingVertical: SPACE.xs,
  },
  entries: { gap: SPACE.sm },
  ledgerCount: { fontFamily: FONTS.mono, fontSize: TYPE.sm, color: COLORS.inkMuted },
  factRow: { flexDirection: "row", justifyContent: "space-between", gap: SPACE.md },
  factLabel: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.inkMuted },
  factValue: {
    fontFamily: FONTS.sansSemibold,
    fontSize: TYPE.sm,
    color: COLORS.ink,
    flexShrink: 1,
    textAlign: "right",
  },
  factMissing: { fontFamily: FONTS.sans, color: COLORS.inkFaint },
  factMono: { fontFamily: FONTS.mono },
  entry: {
    minHeight: TOUCH_TARGET,
    borderRadius: RADIUS.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
    backgroundColor: COLORS.canvas2,
    padding: SPACE.md,
    gap: SPACE.xs,
  },
  entryKind: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * TRACKING.wider,
    textTransform: "uppercase",
    color: COLORS.inkMuted,
  },
  entryTitle: {
    fontFamily: FONTS.serif,
    fontSize: TYPE.lg,
    lineHeight: TYPE.lg * LEADING.lg,
    color: COLORS.ink,
  },
  entryWhen: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.inkMuted },
  provenance: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.inkSoft },
  warning: { fontFamily: FONTS.sansSemibold, fontSize: TYPE.sm, color: COLORS.warnInk },
  amended: { fontFamily: FONTS.sansSemibold, fontSize: TYPE.sm, color: COLORS.accent },
  attachment: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.inkMuted },
  immutability: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.sm,
    color: COLORS.inkMuted,
    paddingHorizontal: SPACE.xs,
  },
});
