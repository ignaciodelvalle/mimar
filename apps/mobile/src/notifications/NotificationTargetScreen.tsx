// AVISO — where one notification leads, asked of the server at tap time
// (notificaciones-destinos, 2026-10).
//
// THE ONE DOOR. A push tap that carries `notificationId` and every inbox CTA open
// this screen. It asks `GET /api/v1/me/notifications/{id}/target` and:
//
//   · REPLACES itself with the resolved screen — the case, the pet, a section the
//     app has — so the back gesture returns to wherever the tap came from;
//   · OPENS an outside link (an official information page the writer linked)
//     in the browser, and stays, so coming back lands on the explanation;
//   · or STAYS and explains: the case or the pet is gone for this reader (the
//     transfer was accepted, the membership ended, the custody episode closed),
//     or the destination exists only on the web. It says why, who has to act
//     when something is pending, and offers the browser for a web-only one.
//
// What it never does is what the app used to: push a stored web path onto a
// screen that then answered "No disponible", or draw the CTA as grey text that
// said "abrilo desde la web".
//
// OPENED FROM THE INBOX, IT IS THE NOTIFICATION'S DETAIL (pulido-avisos,
// 2026-10). The inbox rows stopped carrying buttons: a row reads, and this
// screen acts. With `inbox` set it never replaces itself and never opens a link
// on its own — it shows the whole notification, ONE primary action (the CTA the
// row used to carry, resolved by the same server answer), "Ver {nombre}" and
// "Archivar" as rows, and archiving asks once more because nothing undoes it.
// Without `inbox` (a push tap, an old link) everything above still holds.
//
// ONE READ PER NOTIFICATION (code review R10). The callbacks arrive as fresh
// closures on every parent render; holding them in refs keeps the effect keyed
// on `notificationId` alone, so a re-render never fetches — or replaces — twice.

import type { NotificationTargetV1 } from "@dim/contract/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { apiFailureMessage } from "../api/client";
import { fetchNotificationTarget, sendNotificationCommand } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body, ErrorNotice, Loading } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { Callout, ListRow, PrimaryButton, Screen, SecondaryButton, Title } from "../ui/kit";
import { credentialRoute } from "../ui/routes";
import { COLORS, LEADING, SPACE, TYPE } from "../ui/theme";

import {
  type InboxDetail,
  type TargetStep,
  targetFailure,
  targetStep,
} from "./notification-target-view-model";
import { buildArchive } from "./notifications-view-model";

type State =
  | { phase: "loading" }
  | { phase: "explain"; target: NotificationTargetV1; externalUrl: string | null }
  | { phase: "detail"; target: NotificationTargetV1; step: TargetStep }
  | { phase: "failed"; message: string; retry: boolean };

export function NotificationTargetScreen({
  notificationId,
  onReplace,
  onOpenWeb,
  onOpenExternal,
  onOpenInbox,
  inbox = null,
  onOpenRoute,
}: {
  notificationId: string;
  /** Set when the inbox opened this screen: show the detail, never jump past it. */
  inbox?: InboxDetail | null;
  /** Push an in-app route ON TOP of the detail, so back returns to it. */
  onOpenRoute?: (route: string) => void;
  /** Replace THIS screen with the resolved in-app route. */
  onReplace: (route: string) => void;
  /** Open a web path in the browser (a destination the app has no screen for). */
  onOpenWeb: (target: NotificationTargetV1) => void;
  /** Open an outside address (validated http(s)) in the browser. */
  onOpenExternal: (url: string) => void;
  /** The way back to the inbox. */
  onOpenInbox: () => void;
}) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const generation = useRef(0);
  const onReplaceRef = useRef(onReplace);
  const onOpenExternalRef = useRef(onOpenExternal);
  onReplaceRef.current = onReplace;
  onOpenExternalRef.current = onOpenExternal;
  // Read at load time like the callbacks: whether this is the inbox's detail is
  // decided by the route the screen was opened on, which does not change.
  const fromInbox = useRef(inbox !== null);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    setState({ phase: "loading" });
    const result = await fetchNotificationTarget(sessionPort, notificationId);
    if (mine !== generation.current) return;
    if (result.outcome !== "ok") {
      const failure = targetFailure(result);
      setState({
        phase: "failed",
        message:
          failure?.message ?? apiFailureMessage(result) ?? "No pudimos abrir esta notificación.",
        retry: failure?.retry ?? true,
      });
      return;
    }
    const step = targetStep(result.payload);
    if (fromInbox.current) {
      setState({ phase: "detail", target: result.payload, step });
      return;
    }
    if (step.kind === "go") {
      onReplaceRef.current(step.route);
      return;
    }
    if (step.kind === "external") {
      onOpenExternalRef.current(step.url);
      setState({ phase: "explain", target: step.target, externalUrl: step.url });
      return;
    }
    setState({ phase: "explain", target: step.target, externalUrl: null });
  }, [notificationId]);

  useEffect(() => {
    void load();
    return () => {
      // A late answer must not replace a screen the person already left.
      generation.current++;
    };
  }, [load]);

  if (state.phase === "loading") {
    return (
      <Screen>
        <Loading label="Abriendo la notificación…" />
      </Screen>
    );
  }

  if (state.phase === "failed") {
    return (
      <Screen>
        <ErrorNotice
          message={state.message}
          onRetry={state.retry ? () => void load() : undefined}
        />
        {/* OPENED FROM THE INBOX, THE ROW'S OWN ACTS SURVIVE A FAILED READ. They
            used to sit on the row itself; a notification whose destination
            cannot be resolved must still be archivable, or it stays in the
            inbox forever. Both need only the id and what the row handed over. */}
        {inbox !== null && (
          <InboxRows
            notificationId={notificationId}
            pet={inbox.pet}
            onOpenRoute={onOpenRoute ?? onReplace}
            onArchived={onOpenInbox}
          />
        )}
        <SecondaryButton label="Ir a notificaciones" onPress={onOpenInbox} />
      </Screen>
    );
  }

  if (state.phase === "detail") {
    return (
      <InboxDetailView
        notificationId={notificationId}
        target={state.target}
        step={state.step}
        inbox={inbox ?? { actionLabel: null, pet: null }}
        onOpenRoute={onOpenRoute ?? onReplace}
        onOpenWeb={onOpenWeb}
        onOpenExternal={onOpenExternal}
        onArchived={onOpenInbox}
      />
    );
  }

  const { target, externalUrl } = state;
  return (
    <Screen>
      <View style={styles.head}>
        <Title>{target.title}</Title>
        {target.body !== null && <Body>{target.body}</Body>}
      </View>

      {target.reasonCopy !== null && (
        <Callout tone={target.webOnly || externalUrl !== null ? "neutral" : "warn"}>
          <Body>{target.reasonCopy}</Body>
        </Callout>
      )}

      {target.actorCopy !== null && (
        <Text style={styles.actor} accessibilityRole="text">
          {target.actorCopy}
        </Text>
      )}

      {externalUrl !== null && (
        <PrimaryButton
          label={target.externalLabel ?? "Abrir enlace"}
          onPress={() => onOpenExternal(externalUrl)}
        />
      )}
      {target.webOnly && (
        <PrimaryButton label="Abrir en el navegador" onPress={() => onOpenWeb(target)} />
      )}
      <SecondaryButton label="Ir a notificaciones" onPress={onOpenInbox} />
    </Screen>
  );
}

/**
 * The inbox's detail: the whole notification, then what can be done with it.
 *
 * ONE PRIMARY, CHOSEN FROM THE SERVER'S ANSWER. A resolved screen gets the
 * row's own CTA label; an outside link gets the writer's label; a web-only
 * destination gets the browser; an explanation gets none — the explanation is
 * the answer. "Ver {nombre}" and "Archivar" are rows under it.
 *
 * ARCHIVING ASKS ONCE MORE. It is how a notification leaves the inbox for good
 * and nothing in this product undoes it (`buildArchive`), so the row opens a
 * confirmation instead of firing — the two-step every other irreversible act in
 * this app already takes.
 */
function InboxDetailView({
  notificationId,
  target,
  step,
  inbox,
  onOpenRoute,
  onOpenWeb,
  onOpenExternal,
  onArchived,
}: {
  notificationId: string;
  target: NotificationTargetV1;
  step: TargetStep;
  inbox: InboxDetail;
  onOpenRoute: (route: string) => void;
  onOpenWeb: (target: NotificationTargetV1) => void;
  onOpenExternal: (url: string) => void;
  onArchived: () => void;
}) {
  const primary = detailPrimary(step, target, inbox);

  return (
    <Screen>
      <View style={styles.head}>
        <Title>{target.title}</Title>
        {target.body !== null && <Body selectable>{target.body}</Body>}
      </View>

      {target.reasonCopy !== null && (
        <Callout tone={target.webOnly || step.kind === "external" ? "neutral" : "warn"}>
          <Body>{target.reasonCopy}</Body>
        </Callout>
      )}

      {target.actorCopy !== null && (
        <Text style={styles.actor} accessibilityRole="text">
          {target.actorCopy}
        </Text>
      )}

      {primary === "web" && (
        <PrimaryButton label="Abrir en el navegador" onPress={() => onOpenWeb(target)} />
      )}
      {primary !== null && primary !== "web" && (
        <PrimaryButton
          label={primary.label}
          onPress={() =>
            primary.kind === "route" ? onOpenRoute(primary.to) : onOpenExternal(primary.to)
          }
        />
      )}

      <InboxRows
        notificationId={notificationId}
        pet={inbox.pet}
        onOpenRoute={onOpenRoute}
        onArchived={onArchived}
      />
    </Screen>
  );
}

/** "Ver {nombre}" and "Archivar" (with its confirmation): the rows under the detail. */
function InboxRows({
  notificationId,
  pet,
  onOpenRoute,
  onArchived,
}: {
  notificationId: string;
  pet: InboxDetail["pet"];
  onOpenRoute: (route: string) => void;
  onArchived: () => void;
}) {
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const archive = useCallback(async () => {
    const command = buildArchive(notificationId);
    if (!command.ok) {
      setArchiveError(command.message);
      return;
    }
    setArchiveError(null);
    setArchiving(true);
    const result = await sendNotificationCommand(sessionPort, command.input);
    setArchiving(false);
    if (result.outcome !== "ok") {
      setArchiveError(apiFailureMessage(result) ?? "No pudimos archivar esta notificación.");
      return;
    }
    onArchived();
  }, [notificationId, onArchived]);

  return (
    <>
      <View style={styles.rows}>
        {pet !== null && (
          // THROUGH `credentialRoute`, never a template literal — see the
          // header of `ui/routes.ts`.
          <ListRow
            label={`Ver ${pet.name}`}
            onPress={() => onOpenRoute(credentialRoute(pet.publicToken))}
          />
        )}
        {!confirmingArchive && (
          <ListRow
            label="Archivar"
            caption="La saca de tu bandeja. No se puede deshacer."
            onPress={() => setConfirmingArchive(true)}
          />
        )}
      </View>

      {confirmingArchive && (
        <Callout tone="warn" title="¿Archivar esta notificación?">
          <Body>Sale de tu bandeja y no vas a poder recuperarla desde la app.</Body>
          <PrimaryButton
            tone="seal"
            label={archiving ? "Archivando…" : "Archivar notificación"}
            disabled={archiving}
            onPress={() => void archive()}
          />
          <SecondaryButton
            label="Volver"
            disabled={archiving}
            onPress={() => {
              setConfirmingArchive(false);
              setArchiveError(null);
            }}
          />
        </Callout>
      )}

      {archiveError !== null && (
        <Callout tone="err">
          <Body>{archiveError}</Body>
        </Callout>
      )}
    </>
  );
}

type DetailPrimary = { kind: "route" | "external"; label: string; to: string } | "web" | null;

function detailPrimary(
  step: TargetStep,
  target: NotificationTargetV1,
  inbox: InboxDetail,
): DetailPrimary {
  if (step.kind === "external") {
    return { kind: "external", label: target.externalLabel ?? "Abrir enlace", to: step.url };
  }
  if (step.kind === "explain") return target.webOnly ? "web" : null;
  return inbox.actionLabel === null
    ? null
    : { kind: "route", label: inbox.actionLabel, to: step.route };
}

const styles = StyleSheet.create({
  rows: { gap: SPACE.xs },
  head: { gap: SPACE.xs },
  actor: {
    fontFamily: FONTS.sansMedium,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.ink,
  },
});
