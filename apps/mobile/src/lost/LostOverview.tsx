// The lost screen's overview pane — what is happening, and the one thing to do
// about it now.
//
// ONE PRIMARY PER STATE, THE REST AS ROWS (custody polish, 2026-10-07). The
// 09-24 overview stacked every affordance as a full-width button — six primary
// and ten secondary across the panes — so in "perdida" the two acts that matter
// at 2 a.m., spreading the alert and saying she is home, sat under a card and
// among their peers. Now:
//
//   · not lost      → "Marcar como perdida" is the primary;
//   · lost, stale   → "Reactivar búsqueda" is (the case closed for inactivity);
//   · lost, active  → "Compartir la búsqueda" is, and "Marcar como encontrada"
//                     is the first row right under it.
//
// THE ORDER IS THE REQUIREMENT. In perdida mode the share and the found row come
// straight after the one-line situation, before the case detail, the feed, the
// poster and the privacy rows — so they are on screen without scrolling at font
// scale 1.3. `LostScreen.test.tsx` holds that order.
//
// NOTHING ELSE MOVED. Every affordance still comes from `capabilities` (the
// screen's header says why), marcar encontrada keeps its two steps, and every
// command is built and sent exactly as before.

import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Pressable, Share, StyleSheet, Text, View } from "react-native";

import type { LostFeedItemV1, PetLostV1 } from "@dim/contract/api";

import { sessionPort } from "../auth/session-store";
import { publicCredentialPageUrl } from "../config/api";
import { Body, ContactRow, Row } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { hapticConfirm } from "../ui/haptics";
import {
  Callout,
  CollapsibleModule,
  Eyebrow,
  ListRow,
  PrimaryButton,
  SecondaryButton,
} from "../ui/kit";
import { COLORS, LABEL_TRACKING_EM, LEADING, RADIUS, SPACE, TOUCH_TARGET, TYPE } from "../ui/theme";

import {
  DisclosureRow,
  MetaLine,
  type RunFn,
  formatIsoDate,
  formatIsoDateTime,
  lostStyles,
  unwrap,
} from "./lost-ui";
import {
  FEED_EMPTY_LABEL,
  NO_CONTACT_TITLE,
  NO_CONTACT_TITLE_READ_ONLY,
  POSTER_BUTTON_LABEL,
  POSTER_CARD_BODY,
  POSTER_NO_PHOTO_WARNING,
  POSTER_SHEET_CLOSED,
  REPORT_ACTION_LABEL,
  buildMarkFound,
  buildReactivateSearch,
  buildSetDisclosure,
  canOpenFinderChannel,
  disclosureRows,
  feedItemContact,
  feedItemDetail,
  feedItemReportable,
  feedItemTitle,
  feedTruncationNote,
  foundAdjective,
  lostAdjective,
  noContactWarning,
  noWayToReachYou,
  posterNotLost,
  shareSearchMessage,
  situationHeadline,
} from "./lost-view-model";
import { sharePoster } from "./poster-share";

/**
 * Hand the search to the OS share sheet — the 2 a.m. action this screen exists
 * for, since "share to the neighbourhood WhatsApp group" is how a search
 * actually spreads. BEST-EFFORT: the sheet belongs to the OS, sends nothing to
 * our server, and a device with no share targets throwing here is not a failure
 * the person can act on — so no error surface, no busy state.
 */
async function shareSearch(view: PetLostV1): Promise<void> {
  try {
    await Share.share({
      message: shareSearchMessage(view, publicCredentialPageUrl(view.publicToken)),
    });
  } catch {
    // Nothing to say: the person is looking at the sheet's own failure, or at
    // its silent refusal to open, and a second banner would explain neither.
  }
}

/** Which act leads, per state. See the header; `null` when none applies. */
type PrimaryAct = "mark-lost" | "reactivate" | "share" | null;

function primaryAct(view: PetLostV1): PrimaryAct {
  if (view.capabilities.canMarkLost) return "mark-lost";
  if (view.capabilities.canReactivateSearch) return "reactivate";
  // ON `status === "lost"`, INCLUDING a search closed for inactivity: the public
  // page's sighting writer refuses on the pet's status alone
  // (report-pet-sighting.ts:172), not on an open episode, so the link the
  // message invites people to use keeps working in both lost states.
  if (view.status === "lost") return "share";
  return null;
}

export function LostOverview({
  banners,
  view,
  busy,
  onMarkLost,
  onReport,
  onReportItem,
  onRun,
  onReload,
}: {
  /** The screen's stale/notice/error callouts, when they belong UNDER the acts. */
  banners: ReactNode;
  view: PetLostV1;
  busy: boolean;
  onMarkLost: () => void;
  onReport: () => void;
  onReportItem: (item: LostFeedItemV1) => void;
  onRun: RunFn;
  onReload: () => void;
}) {
  const [confirmingFound, setConfirmingFound] = useState(false);
  // A landed "Sí, la encontré" re-reads WITHOUT remounting this pane, and the
  // re-read takes `canMarkFound` away. The confirmation must close with it, or
  // it would keep hiding the act the new state leads with ("Marcar como
  // perdida") — the review finding this line exists for.
  const canMarkFound = view.capabilities.canMarkFound;
  useEffect(() => {
    if (!canMarkFound) setConfirmingFound(false);
  }, [canMarkFound]);
  const lost = view.status === "lost";

  return (
    <>
      {/* The situation in one line, ABOVE the act, so the act is never more
          than a sentence down. The case detail waits under the actions. */}
      <Callout tone={lost ? "warn" : "neutral"}>
        <Body>{situationHeadline(view)}</Body>
      </Callout>

      <LostActions
        view={view}
        busy={busy}
        confirmingFound={confirmingFound}
        onConfirmingFound={setConfirmingFound}
        onMarkLost={onMarkLost}
        onReport={onReport}
        onRun={onRun}
      />

      {banners}

      <CaseDetail view={view} />

      <FeedModule view={view} busy={busy} onReportItem={onReportItem} />

      {/* GATED ON `status`, WHICH THE HEADER FORBIDS FOR COMMANDS — and this is
          not one. It is a READ the server re-checks (`available: false` when the
          animal is not lost), so a stale status here costs one honest sentence,
          not a 403. The web's cartel page draws the poster on the same fact. */}
      {lost ? (
        <PosterModule publicToken={view.publicToken} petSex={view.petSex} disabled={busy} />
      ) : null}

      <DisclosureModule view={view} busy={busy} onRun={onRun} />

      <ListRow
        label="Actualizar"
        caption="Volver a leer la búsqueda y sus avistajes."
        onPress={busy ? undefined : onReload}
      />
    </>
  );
}

/**
 * The primary and the rows under it. A row is inert (no `onPress`) while a
 * command is in flight, which is how `ListRow` draws and announces a disabled
 * row — except sharing, which runs no command and touches no state.
 */
function LostActions({
  view,
  busy,
  confirmingFound,
  onConfirmingFound,
  onMarkLost,
  onReport,
  onRun,
}: {
  view: PetLostV1;
  busy: boolean;
  confirmingFound: boolean;
  onConfirmingFound: (confirming: boolean) => void;
  onMarkLost: () => void;
  onReport: () => void;
  onRun: RunFn;
}) {
  const can = view.capabilities;
  const primary = primaryAct(view);
  const unlessBusy = (press: () => void) => (busy ? undefined : press);
  const reactivate = () => void onRun(unwrap(buildReactivateSearch()), null);
  const share = () => void shareSearch(view);

  return (
    <>
      {/* While the found confirmation is open it is the only primary on
          screen; "Cancelar" brings the lead act back. */}
      {can.canMarkFound && confirmingFound ? null : (
        <>
          {primary === "mark-lost" ? (
            <PrimaryButton
              label={`Marcar como ${lostAdjective(view.petSex)}`}
              disabled={busy}
              onPress={onMarkLost}
            />
          ) : null}
          {primary === "reactivate" ? (
            <PrimaryButton label="Reactivar búsqueda" disabled={busy} onPress={reactivate} />
          ) : null}
          {primary === "share" ? (
            <PrimaryButton label="Compartir la búsqueda" onPress={share} />
          ) : null}
        </>
      )}

      {/* MARCAR ENCONTRADA IS A TWO-STEP, and the one affordance here that is.
          It closes the search and tells everyone who was asked to look; a
          mis-tap on a list of rows should not do that. */}
      {can.canMarkFound ? (
        confirmingFound ? (
          <Callout tone="warn" title="¿Confirmás?">
            <Body>
              Se cierra la búsqueda, la credencial pública deja de mostrar el aviso y avisamos a
              quienes la estaban buscando.
            </Body>
            <PrimaryButton
              label="Sí, la encontré"
              disabled={busy}
              onPress={() => void onRun(unwrap(buildMarkFound()), null)}
            />
            <SecondaryButton label="Cancelar" onPress={() => onConfirmingFound(false)} />
          </Callout>
        ) : (
          <ListRow
            // Gender-agreed with the pet's own sex (U-6/gender review), same
            // as "Marcar como {lostAdjective}": this label used to be a fixed
            // feminine "encontrada" regardless of the animal.
            label={`Marcar como ${foundAdjective(view.petSex)}`}
            caption={`Cierra la búsqueda de ${view.petName}. Te pedimos confirmación.`}
            onPress={unlessBusy(() => {
              // The confirm haptic marks the WEIGHT of what just armed, not an
              // outcome — closing a search notifies everyone who was looking.
              hapticConfirm();
              onConfirmingFound(true);
            })}
          />
        )
      ) : null}

      {/* Sharing as a ROW when another act leads (a stale search, where
          reactivating does). Same condition as the primary: `status`. */}
      {view.status === "lost" && primary !== "share" ? (
        <ListRow
          label="Compartir la búsqueda"
          caption="Por WhatsApp o donde quieras, con el enlace a su credencial."
          onPress={share}
        />
      ) : null}

      {can.canReportLastSeen ? (
        <ListRow
          label="Actualizar dónde se vio"
          caption="Suma un avistaje a la búsqueda."
          onPress={unlessBusy(onReport)}
        />
      ) : null}

      {can.canReactivateSearch && primary !== "reactivate" ? (
        <ListRow
          label="Reactivar búsqueda"
          caption="Vuelve a abrir la búsqueda."
          onPress={unlessBusy(reactivate)}
        />
      ) : null}

      {can.canMarkLost && primary !== "mark-lost" ? (
        <ListRow
          label={`Marcar como ${lostAdjective(view.petSex)}`}
          onPress={unlessBusy(onMarkLost)}
        />
      ) : null}
    </>
  );
}

/** The open case — read, not acted on, so it sits under the actions. */
function CaseDetail({ view }: { view: PetLostV1 }) {
  const { episode } = view;
  if (episode === null) return null;
  return (
    <View style={lostStyles.section}>
      <Eyebrow>El caso</Eyebrow>
      <Row label="Caso" value={episode.publicCode} />
      <Row label="Perdida desde" value={formatIsoDate(episode.openedAt)} />
      {episode.placeName ? <Row label="Última vez" value={episode.placeName} /> : null}
      {episode.ownerNote ? <Body>{episode.ownerNote}</Body> : null}
    </View>
  );
}

/**
 * The feed, as a module that starts OPEN when there is something in it — a
 * finder's "la tengo en casa" may not wait behind a tap — and as a plain line
 * when there is nothing to fold.
 */
function FeedModule({
  view,
  busy,
  onReportItem,
}: {
  view: PetLostV1;
  busy: boolean;
  onReportItem: (item: LostFeedItemV1) => void;
}) {
  const { items, truncated } = view.feed;
  const [open, setOpen] = useState(items.length > 0);
  // A refresh that brings the FIRST item in opens the module: the read that
  // finds a finder's message is the one that must not fold it.
  const hasItems = items.length > 0;
  useEffect(() => {
    if (hasItems) setOpen(true);
  }, [hasItems]);

  if (items.length === 0) {
    return (
      <View style={lostStyles.section}>
        <Eyebrow>Avistajes y escaneos</Eyebrow>
        <Body>{FEED_EMPTY_LABEL}</Body>
      </View>
    );
  }

  return (
    <CollapsibleModule
      title="Avistajes y escaneos"
      summary={feedTruncationNote(truncated) ?? null}
      badge={String(items.length)}
      open={open}
      onToggle={() => setOpen((current) => !current)}
    >
      <View style={lostStyles.moduleBody}>
        {items.map((item) => (
          <FeedRow
            key={item.id}
            item={item}
            busy={busy}
            canReport={view.capabilities.canReportContent}
            onReport={() => onReportItem(item)}
          />
        ))}
      </View>
    </CollapsibleModule>
  );
}

/**
 * The privacy rows. Folded during a search — the acts lead there — and open
 * otherwise, where they are most of what the screen has to say.
 *
 * THE WARNING SITS OUTSIDE THE FOLD. It is a fact about the public page right
 * now, and a fact nobody sees is not a warning.
 */
function DisclosureModule({
  view,
  busy,
  onRun,
}: {
  view: PetLostV1;
  busy: boolean;
  onRun: RunFn;
}) {
  const lost = view.status === "lost";
  const [open, setOpen] = useState(!lost);
  // The fold follows the state when the state changes under a mounted pane
  // (marked found, reactivated): folded during a search, open otherwise.
  useEffect(() => {
    setOpen(!lost);
  }, [lost]);
  const rows = disclosureRows(view.disclosure, view.capabilities.editableDisclosureKeys);
  const shown = rows.filter((row) => row.value).length;

  return (
    <>
      {/* THE SEARCH IS ALREADY RUNNING HERE, which is why this belongs on the
          overview too and not only on the form (A4-custodia-09): a toggle
          turned off weeks into a search leaves the credential with a notice
          and no way to answer it.

          AND THE SENTENCE DEPENDS ON WHO IS READING IT (finding F11, review
          2026-09-07). The rows draw a switch only for the keys in
          `editableDisclosureKeys`, and for a caretaker or a co-owner none of the
          three finder channels is among them — so "Te recomendamos habilitar al
          menos el formulario" was an instruction printed over rows with no
          controls on them, addressed in the second person to somebody the
          finder would not be contacting anyway. The FACT still reaches them,
          because it is the fact that matters and they may be the one standing
          next to the titular; the instruction does not. */}
      {noWayToReachYou(view.disclosure) &&
        (canOpenFinderChannel(view.capabilities.editableDisclosureKeys) ? (
          <Callout tone="warn" title={NO_CONTACT_TITLE}>
            <Body>{noContactWarning(view.petName)}</Body>
          </Callout>
        ) : (
          <Callout tone="warn" title={NO_CONTACT_TITLE_READ_ONLY}>
            <Body>{noContactWarning(view.petName, false)}</Body>
          </Callout>
        ))}
      <CollapsibleModule
        title="Qué se muestra en la credencial pública"
        summary="Lo que ve quien escanea su QR mientras la búsqueda esté activa."
        badge={`${shown} de ${rows.length}`}
        open={open}
        onToggle={() => setOpen((current) => !current)}
      >
        <View style={lostStyles.moduleBody}>
          {rows.map((row) => (
            <DisclosureRow
              key={row.key}
              row={row}
              busy={busy}
              onToggle={() => void onRun(unwrap(buildSetDisclosure(row.key, !row.value)), null)}
            />
          ))}
        </View>
      </CollapsibleModule>
    </>
  );
}

type PosterState =
  | { phase: "idle" }
  | { phase: "working" }
  | { phase: "closed"; hasPhoto: boolean }
  | { phase: "failed"; message: string };

/**
 * "Cartel para imprimir" — the poster as a PDF, into the share sheet (M13).
 *
 * Shown only while the animal is lost, as the web's cartel page is. What the
 * poster says is decided by the server (see `poster-share.ts`); this module only
 * reports how the attempt went, in words that do not over-claim: the share
 * sheet cannot tell a sent PDF from a dismissed one, so "closed" never says
 * "enviado".
 *
 * A MODULE, folded: the poster is the second way to spread a search, and the
 * first one (the primary) is already on screen. What it is stays readable on
 * the folded header.
 */
function PosterModule({
  publicToken,
  petSex,
  disabled,
}: {
  publicToken: string;
  petSex: string | null;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PosterState>({ phase: "idle" });
  const onShare = useCallback(async () => {
    setState({ phase: "working" });
    const result = await sharePoster(sessionPort, publicToken);
    if (result.kind === "closed") setState({ phase: "closed", hasPhoto: result.hasPhoto });
    else if (result.kind === "not_lost")
      setState({ phase: "failed", message: posterNotLost(petSex) });
    else setState({ phase: "failed", message: result.message });
  }, [petSex, publicToken]);

  return (
    <CollapsibleModule
      title="Cartel para imprimir"
      summary={POSTER_CARD_BODY}
      open={open}
      onToggle={() => setOpen((current) => !current)}
    >
      <View style={[lostStyles.moduleBody, styles.posterBody]}>
        {state.phase === "failed" ? (
          <Callout tone="err">
            <Body>{state.message}</Body>
          </Callout>
        ) : null}
        {state.phase === "closed" && !state.hasPhoto ? (
          <Callout tone="warn">
            <Body>{POSTER_NO_PHOTO_WARNING}</Body>
          </Callout>
        ) : null}
        {state.phase === "closed" ? <Body>{POSTER_SHEET_CLOSED}</Body> : null}
        <SecondaryButton
          label={state.phase === "working" ? "Armando el cartel…" : POSTER_BUTTON_LABEL}
          disabled={disabled || state.phase === "working"}
          onPress={() => void onShare()}
        />
      </View>
    </CollapsibleModule>
  );
}

function FeedRow({
  item,
  busy,
  canReport,
  onReport,
}: {
  item: LostFeedItemV1;
  busy: boolean;
  /**
   * `capabilities.canReportContent` — whether this CALLER may report at all
   * (A4-custodia-13). The row's own half of the answer is `feedItemReportable`;
   * both have to be true, and only the server knows this one.
   */
  canReport: boolean;
  onReport: () => void;
}) {
  const detail = feedItemDetail(item);
  const contact = feedItemContact(item);
  return (
    <View style={styles.feedRow}>
      <Text style={styles.feedTitle}>{feedItemTitle(item)}</Text>
      <MetaLine>{formatIsoDateTime(item.at)}</MetaLine>
      {detail ? <Body>{detail}</Body> : null}
      {contact ? <ContactRow label="Contacto" value={contact} /> : null}
      {item.kind !== "scan" && item.hasPhoto ? (
        // The file is not on this payload — see the contract header. Saying it
        // exists is honest; a broken image would not be.
        <Body>Dejó una foto. Se ve desde la web.</Body>
      ) : null}

      {/* TWO CONDITIONS, AND THEY ARE DIFFERENT QUESTIONS.
          · THE ROW — on the two authored kinds only. A `scan` is a machine
            reading a QR: no author, no text, nothing anybody could have written
            wrongly, so there is no control rather than a disabled one.
            `feedItemReportable`, and the server refuses a scan target anyway.
          · THE CALLER — `canReportContent` (A4-custodia-13). The route refuses
            `report_content` on the ORG path, in the same condition that refuses
            `reactivate_search`, and nothing on the payload's feed says which
            path the reader came through. Without it an org-path reader was drawn
            a "Reportar" the server answers with titular-only copy. */}
      {canReport && feedItemReportable(item) ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${REPORT_ACTION_LABEL} este mensaje`}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={onReport}
          style={styles.reportControl}
        >
          <Text style={styles.reportLabel}>{REPORT_ACTION_LABEL}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  posterBody: { paddingVertical: SPACE.md },
  feedRow: {
    alignSelf: "stretch",
    gap: SPACE.xs,
    paddingVertical: SPACE.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.borderSoft,
  },
  feedTitle: {
    fontFamily: FONTS.sansSemibold,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.ink,
  },
  // A full touch target, on a control that is deliberately quiet. Reporting a
  // message must be REACHABLE and must not compete with "marcá que la
  // encontraste" for attention on the same screen.
  reportControl: {
    alignSelf: "flex-start",
    minHeight: TOUCH_TARGET,
    justifyContent: "center",
    paddingHorizontal: SPACE.sm,
    borderRadius: RADIUS.chip,
  },
  reportLabel: {
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * LABEL_TRACKING_EM,
    textTransform: "uppercase",
    color: COLORS.inkMuted,
  },
});
