// NOTIFICACIONES — la bandeja.
//
// THE SECOND SCREEN IN THIS APP THAT IS NOT ABOUT A PET IT HOLDS, and the reason
// is plainer than the transfer hub's: a notification is addressed to a PERSON.
// Some are about an animal, several are about an animal this person no longer
// holds — that is what `pet_transfer_accepted` IS — and some are about no animal
// at all. There is no token that would name the read.
//
// IT MIRRORS THE WEB'S `/notificaciones` IN WHAT IT LETS SOMEBODY DO, which is
// how parity is measured on this programme: the tabs, "marcar todas como
// leídas", the notification's own CTA, "Ver {nombre}", "marcar como leída",
// "archivar", the group expander, and the empty state's way out. What it does NOT
// bring across is stated where it matters rather than left as a silence — see
// `truncationNote` for the missing pagination.
//
// THE ORDER IS NOT THIS SCREEN'S. `notificationsForDisplay` calls the SAME two
// functions the web page calls, out of `@dim/contract/notifications`. A list that
// sorted itself here would be the failure this whole unit exists to prevent:
// not a crash, but the phone showing the same eight notifications in a different
// order from the browser.
//
// EVERY AFFORDANCE COMES FROM THE SERVER. `petLinkAvailable` folds in a denylist
// of notification types whose recipient no longer holds the animal, and
// `cta.route` is a stored WEB path matched back through the deep-link table to a
// screen this app actually has. A screen that derived either from what is on the
// row would offer a link to "No encontramos esta página".
//
// OPTIMISM IS DELIBERATELY ABSENT. A tap on "marcar como leída" waits for the
// server and then re-reads. The alternative — flipping the row locally and
// reconciling later — makes the unread badge and the row disagree whenever the
// write fails, on the one screen whose entire job is to tell somebody the truth
// about what happened while they were not looking.

import type {
  MyNotificationV1,
  MyNotificationsV1,
  NotificationCategoryV1,
} from "@dim/contract/api";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";

import { type ApiResult, apiFailureMessage } from "../api/client";
import { fetchMyNotifications, sendNotificationCommand } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body, Card, EmptyState, StaleNotice } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { Callout, Screen, SecondaryButton, Title } from "../ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../ui/reload-state";
import { credentialRoute } from "../ui/routes";
import { ListSkeleton } from "../ui/skeleton";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TRACKING, TYPE } from "../ui/theme";
import { useReconnect } from "../ui/use-reconnect";

import {
  ALL_CATEGORIES_LABEL,
  type NotificationEntry,
  buildArchive,
  buildMarkAllRead,
  buildMarkRead,
  categoryLabel,
  emptyBody,
  emptyTitle,
  inboxSummary,
  notificationDateLabel,
  notificationsForDisplay,
  rowsOf,
  severityLabel,
  truncationNote,
} from "./notifications-view-model";

/**
 * The ready arm CARRIES THE CATEGORY IT WAS LOADED FOR, and that field is the
 * whole of the S-2b/F4 fix (lote 1b review).
 *
 * S-2 says a failed re-read keeps the last good payload; S-2b says a tab switch
 * keeps the chrome. Together, offline, they said something neither of them
 * meant: tapping "Custodia" left the Custodia chip reading active, put the
 * "lo último que pudimos leer" banner up, and rendered THE ENTIRE INBOX under
 * it — the previous query's rows, labelled as this query's answer. `staleFailure`
 * can honestly say "this may be old"; it cannot say "this may be about something
 * else". So the state records which list it holds, and a failure under a
 * DIFFERENT tab falls through to the full error rather than mislabelling rows.
 */
type ReadyInbox = ReadyState<MyNotificationsV1> & {
  category: NotificationCategoryV1 | null;
};

type ScreenState = { phase: "loading" } | ReadyInbox | { phase: "failed"; message: string };

export function NotificationsScreen({
  onOpenRoute,
  onOpenPets,
}: {
  /** Push an in-app path — a CTA's resolved route, or a pet's credential. */
  onOpenRoute: (route: string) => void;
  /** The empty state's way out. A dead end is still a dead end. */
  onOpenPets: () => void;
}) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [category, setCategory] = useState<NotificationCategoryV1 | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // A category change is a different LIST under the same chrome — see `load`.
  const [listReloading, setListReloading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // A read started before the screen unmounted must not write into a dead
  // component; and two overlapping reads must not race to be last.
  const generation = useRef(0);

  const load = useCallback(
    async (cat: NotificationCategoryV1 | null, mode: "initial" | "refresh") => {
      const mine = ++generation.current;
      if (mode === "initial") {
        // THE HEADER AND THE TABS STAY (S-2b). `initial` used to blank the whole
        // screen to a skeleton, and it runs on every TAB SWITCH — so tapping
        // "Custodia" removed the title, the tab bar you had just tapped and the
        // "marcar todas" button, then put them back a moment later. Only the
        // LIST is unknown while a category loads; everything above it is the
        // same chrome, and it is what the person is aiming at.
        setListReloading(true);
        setState((current) => (current.phase === "ready" ? current : { phase: "loading" }));
      } else setRefreshing(true);

      const result = await fetchMyNotifications(sessionPort, cat);
      if (mine !== generation.current) return;
      setRefreshing(false);
      setListReloading(false);
      if (result.outcome === "ok") {
        setState({ ...loaded(result.payload), category: cat });
        return;
      }
      // NOT an empty inbox. A read that failed and a person with nothing waiting
      // are different facts, and "tu bandeja está vacía" over a server outage
      // tells somebody that nobody reported seeing their dog.
      //
      // AND NOT AN EMPTY SCREEN EITHER (S-2). With rows already drawn, a failed
      // re-read keeps them and says so in a banner — see `reload-state.ts`.
      //
      // UNLESS THE ROWS ANSWER A DIFFERENT QUESTION (F4). The banner's sentence
      // is "lo último que pudimos leer", and holding the whole inbox under a
      // Custodia tab makes that sentence say something false about WHICH rows
      // these are. There is nothing to keep for a tab that has never loaded.
      setState((current) =>
        current.phase === "ready" && current.category !== cat
          ? { phase: "failed", message: failureMessage(result) }
          : reloadFailed(current, result, failureMessage(result)),
      );
    },
    [],
  );

  // ON FOCUS, NOT ON MOUNT (NAV-3, the fix `TransfersScreen` and `TurnosScreen`
  // already carry). Every row here leads somewhere that CHANGES the row: opening
  // a transfer proposal, accepting a caretaker invitation. Coming back does not
  // remount this screen, so the inbox kept showing the state from before the
  // decision — an unread badge on something already read.
  //
  // THE MODE IS THE WHOLE DIFFERENCE between a fix and an annoyance. `initial`
  // blanks the list to a skeleton, which is right the first time and wrong every
  // time somebody returns from a detail screen; `refresh` keeps the rows and
  // spins the pull-to-refresh control instead. The ref remembers WHICH category
  // was loaded, so switching tabs still takes the skeleton (it is a different
  // list) while returning to the same tab does not.
  const loadedCategory = useRef<NotificationCategoryV1 | null | undefined>(undefined);
  useFocusEffect(
    useCallback(() => {
      const mode = loadedCategory.current === category ? "refresh" : "initial";
      loadedCategory.current = category;
      void load(category, mode);
    }, [load, category]),
  );

  // WHEN THE NETWORK COMES BACK, TRY AGAIN (B-05, the other half of S-2). It
  // re-reads THE TAB THAT IS OPEN — `category` is in the closure and the hook
  // holds the callback in a ref, so it does not re-subscribe per render. A
  // `refresh`, so the rows stay put while it happens.
  useReconnect(() => void load(category, "refresh"));

  /**
   * Run one command, then re-read.
   *
   * THE RE-READ IS THE WHOLE POINT and not a belt-and-braces extra: archiving
   * removes a row, marking read changes a badge AND may change which rows the
   * tab counts show. The ack carries `unreadCount` so a client COULD patch its
   * badge, and this screen deliberately does not — a partially-patched list is
   * how two numbers on one screen end up disagreeing.
   */
  const run = useCallback(
    async (command: ReturnType<typeof buildMarkAllRead>) => {
      if (!command.ok) {
        setActionError(command.message);
        return;
      }
      setActionError(null);
      setBusy(true);
      const result = await sendNotificationCommand(sessionPort, command.input);
      setBusy(false);
      if (result.outcome !== "ok") {
        setActionError(failureMessage(result));
        return;
      }
      await load(category, "refresh");
    },
    [category, load],
  );

  if (state.phase === "loading")
    return (
      <Screen>
        <ListSkeleton rows={4} label="Cargando notificaciones…" />
      </Screen>
    );

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Notificaciones</Title>
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load(category, "initial")} />
      </Screen>
    );
  }

  const view = state.view;
  const entries = notificationsForDisplay(view);
  const truncation = truncationNote(view);

  return (
    <Screen
      refreshControl={
        <RefreshControl
          colors={[COLORS.accent]}
          onRefresh={() => void load(category, "refresh")}
          refreshing={refreshing}
          tintColor={COLORS.accent}
        />
      }
    >
      <View style={styles.header}>
        <Title>Notificaciones</Title>
        <Body>{inboxSummary(view)}</Body>
      </View>

      {/* The tabs. Only categories that HAVE rows are drawn — an empty tab is
          furniture, and the web hides it too. The counts are the whole inbox's,
          so the bar does not move when a filter is on. */}
      {view.categories.length > 0 && (
        <View style={styles.tabs} accessibilityRole="radiogroup">
          <CategoryChip
            label={ALL_CATEGORIES_LABEL}
            count={null}
            active={category === null}
            onPress={() => setCategory(null)}
          />
          {view.categories.map(({ category: value, count }) => (
            <CategoryChip
              key={value}
              label={categoryLabel(value)}
              count={count}
              active={category === value}
              onPress={() => setCategory(value)}
            />
          ))}
        </View>
      )}

      {view.unreadCount > 0 && (
        <SecondaryButton
          label="Marcar todas como leídas"
          accessibilityHint="Marca como leída toda la bandeja, no solo la pestaña que estás viendo."
          disabled={busy}
          onPress={() => void run(buildMarkAllRead())}
        />
      )}

      {actionError !== null && (
        <Callout tone="err">
          <Body>{actionError}</Body>
        </Callout>
      )}

      {/* The failed RE-read, over the rows it could not replace (S-2). */}
      {state.staleFailure !== null && (
        <StaleNotice message={state.staleFailure} onRetry={() => void load(category, "refresh")} />
      )}

      {listReloading ? (
        <ListSkeleton rows={4} label="Cargando notificaciones…" />
      ) : entries.length === 0 ? (
        <EmptyState
          headline={emptyTitle(category)}
          body={emptyBody(category)}
          // Passive surface — nothing to "create" here, but a dead end is still a
          // dead end. Point the owner back at their animals.
          actionLabel="Ver mis mascotas"
          onAction={onOpenPets}
        />
      ) : (
        entries.map((entry) => (
          <NotificationEntryCard
            key={rowsOf(entry)[0]?.id}
            entry={entry}
            busy={busy}
            onOpenRoute={onOpenRoute}
            onMarkRead={(ids) => void run(buildMarkRead(ids))}
            onArchive={(id) => void run(buildArchive(id))}
          />
        ))
      )}

      {truncation !== null && (
        <Card title="La lista está incompleta">
          <Body>{truncation}</Body>
        </Card>
      )}
    </Screen>
  );
}

/** One sentence per failure arm. No arm falls through to a generic shrug. */
function failureMessage(result: ApiResult<unknown>): string {
  return apiFailureMessage(result) ?? "No pudimos leer tus notificaciones.";
}

function CategoryChip({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count: number | null;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: active }}
      accessibilityLabel={count === null ? label : `${label}, ${count}`}
      onPress={onPress}
      style={[styles.chip, active ? styles.chipActive : null]}
    >
      <Text style={active ? styles.chipLabelActive : styles.chipLabel}>
        {count === null ? label : `${label} · ${count}`}
      </Text>
    </Pressable>
  );
}

/**
 * One entry: a single notification, or a collapsed run of the same kind about the
 * same animal.
 *
 * THE GROUP IS COLLAPSED BY DEFAULT, like the web's `<details>`. Five "avistaje
 * de Pampa" cards in a row is the state the grouping rule exists to prevent, and
 * a phone has less room to spend on it than a browser does.
 */
function NotificationEntryCard({
  entry,
  busy,
  onOpenRoute,
  onMarkRead,
  onArchive,
}: {
  entry: NotificationEntry;
  busy: boolean;
  onOpenRoute: (route: string) => void;
  onMarkRead: (ids: string[]) => void;
  onArchive: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (entry.kind === "single") {
    return (
      <NotificationRow
        notification={entry.row}
        busy={busy}
        onOpenRoute={onOpenRoute}
        onMarkRead={onMarkRead}
        onArchive={onArchive}
      />
    );
  }

  return (
    <View style={styles.group}>
      <NotificationRow
        notification={entry.leader}
        busy={busy}
        onOpenRoute={onOpenRoute}
        onMarkRead={onMarkRead}
        onArchive={onArchive}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((open) => !open)}
        style={styles.groupToggle}
      >
        <Text style={styles.groupToggleLabel}>
          {expanded ? "Ocultar" : `+ ${entry.rest.length} más del mismo tipo`}
        </Text>
      </Pressable>
      {expanded && (
        <View style={styles.groupRest}>
          {entry.rest.map((notification) => (
            <NotificationRow
              key={notification.id}
              notification={notification}
              busy={busy}
              onOpenRoute={onOpenRoute}
              onMarkRead={onMarkRead}
              onArchive={onArchive}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function NotificationRow({
  notification,
  busy,
  onOpenRoute,
  onMarkRead,
  onArchive,
}: {
  notification: MyNotificationV1;
  busy: boolean;
  onOpenRoute: (route: string) => void;
  onMarkRead: (ids: string[]) => void;
  onArchive: (id: string) => void;
}) {
  const unread = !notification.read;
  const tone = severityTone(notification.severity);

  return (
    <View style={[styles.row, unread ? tone.unread : styles.rowRead]}>
      <View style={[styles.severityBar, tone.bar]} accessibilityElementsHidden />
      <View style={styles.rowMain}>
        <View style={styles.rowHead}>
          <Text style={[styles.rowTitle, unread ? styles.rowTitleUnread : null]}>
            {notification.title}
          </Text>
          <Text style={styles.rowDate}>{notificationDateLabel(notification.createdAt)}</Text>
        </View>
        <Text style={styles.rowMeta}>{severityLabel(notification.severity)}</Text>
        {notification.body !== null && <Text style={styles.rowBody}>{notification.body}</Text>}

        <View style={styles.actions}>
          {/* The notification's own CTA, only when the app HAS the screen it
              names. A label with no route is rendered as inert text below —
              pushing a web path would open the app onto a blank stack. */}
          {notification.cta !== null &&
            (notification.cta.route !== null ? (
              <RowAction
                label={notification.cta.label}
                emphasis
                disabled={busy}
                onPress={() => onOpenRoute(notification.cta?.route ?? "")}
              />
            ) : (
              // AN INERT CTA SAYS SO NOW (A5-ciudadanas-03). It used to be a bare
              // greyed label: sighted people read it as a broken button, and a
              // screen reader announced nothing at all, because plain `<Text>` is
              // not a control and carries no state. Three of these were the app's
              // own destinations missing from `DEEP_LINK_MAP` — fixed at the
              // contract — and what is left is the genuinely un-openable case, an
              // absolute `https://` CTA the inbox cannot route. The hint names
              // the only thing that does work.
              <Text accessibilityRole="text" style={styles.inertCta}>
                {`${notification.cta.label} · abrilo desde la web`}
              </Text>
            ))}

          {notification.petLinkAvailable && notification.pet !== null && (
            <RowAction
              label={`Ver ${notification.pet.name}`}
              disabled={busy}
              // THROUGH `credentialRoute`, never a template literal. A rename of
              // the pet screen has to be a compile error at every call site, and
              // this is one of them — see the header of `ui/routes.ts`.
              onPress={() => onOpenRoute(credentialRoute(notification.pet?.publicToken ?? ""))}
            />
          )}

          {unread && (
            <RowAction
              label="Marcar como leída"
              disabled={busy}
              onPress={() => onMarkRead([notification.id])}
            />
          )}

          <RowAction label="Archivar" disabled={busy} onPress={() => onArchive(notification.id)} />
        </View>
      </View>
    </View>
  );
}

/** A row's own affordance. A full-height touch target, not a text link. */
function RowAction({
  label,
  emphasis = false,
  disabled,
  onPress,
}: {
  label: string;
  emphasis?: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.action, emphasis ? styles.actionEmphasis : null]}
    >
      <Text style={emphasis ? styles.actionLabelEmphasis : styles.actionLabel}>{label}</Text>
    </Pressable>
  );
}

/**
 * The severity bar, in the web card's four tones.
 *
 * "Urgente" is not decorated like the rest and that is not styling: an urgent
 * notification is a lost animal, and a list where it reads like every other row
 * buries the one row that matters.
 */
function severityTone(severity: string) {
  switch (severity) {
    case "urgent":
      return { bar: styles.barDanger, unread: styles.rowUnreadDanger };
    case "warning":
      return { bar: styles.barWarn, unread: styles.rowUnreadWarn };
    case "success":
      return { bar: styles.barOk, unread: styles.rowUnreadOk };
    default:
      return { bar: styles.barInfo, unread: styles.rowUnreadInfo };
  }
}

const styles = StyleSheet.create({
  header: { gap: SPACE.xs },
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.xs },
  chip: {
    minHeight: TOUCH_TARGET,
    justifyContent: "center",
    borderRadius: RADIUS.chip,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.stripe,
    paddingHorizontal: SPACE.md,
  },
  chipActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  chipLabel: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.inkMuted },
  chipLabelActive: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.surface },

  group: { gap: SPACE.xs },
  groupToggle: {
    minHeight: TOUCH_TARGET,
    justifyContent: "center",
    paddingLeft: SPACE.md,
  },
  groupToggleLabel: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.sm,
    color: COLORS.accent,
  },
  groupRest: { gap: SPACE.xs, paddingLeft: SPACE.md },

  row: {
    flexDirection: "row",
    gap: SPACE.sm,
    borderRadius: RADIUS.control,
    borderWidth: 1,
    padding: SPACE.md,
  },
  rowRead: { backgroundColor: COLORS.surface, borderColor: COLORS.border },
  rowUnreadDanger: { backgroundColor: COLORS.dangerSurface, borderColor: COLORS.dangerBorder },
  rowUnreadWarn: { backgroundColor: COLORS.warnSurface, borderColor: COLORS.warnBorder },
  rowUnreadOk: { backgroundColor: COLORS.okSurface, borderColor: COLORS.okBorder },
  rowUnreadInfo: { backgroundColor: COLORS.stripe, borderColor: COLORS.celeste },

  severityBar: { width: 3, borderRadius: 999, alignSelf: "stretch" },
  barDanger: { backgroundColor: COLORS.danger },
  barWarn: { backgroundColor: COLORS.warnInk },
  barOk: { backgroundColor: COLORS.okInk },
  barInfo: { backgroundColor: COLORS.celeste },

  rowMain: { flex: 1, gap: SPACE.xs },
  rowHead: { flexDirection: "row", alignItems: "flex-start", gap: SPACE.sm },
  rowTitle: {
    flex: 1,
    fontFamily: FONTS.sans,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.ink,
  },
  rowTitleUnread: { fontFamily: FONTS.serif },
  rowDate: { fontFamily: FONTS.mono, fontSize: TYPE.xs, color: COLORS.inkMuted },
  rowMeta: {
    fontFamily: FONTS.monoSemibold,
    fontSize: TYPE.xs,
    letterSpacing: TYPE.xs * TRACKING.wider,
    textTransform: "uppercase",
    color: COLORS.inkMuted,
  },
  rowBody: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.md,
    color: COLORS.inkSoft,
  },

  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: SPACE.xs },
  action: {
    minHeight: TOUCH_TARGET,
    justifyContent: "center",
    paddingHorizontal: SPACE.sm,
  },
  actionEmphasis: {
    borderRadius: RADIUS.chip,
    backgroundColor: COLORS.accent,
    paddingHorizontal: SPACE.md,
  },
  actionLabel: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.inkSoft },
  actionLabelEmphasis: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.surface },
  inertCta: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    color: COLORS.inkFaint,
    paddingVertical: SPACE.sm,
  },
});
