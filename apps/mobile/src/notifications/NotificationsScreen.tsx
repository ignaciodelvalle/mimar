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
// "archivar", the group expander, and the empty state's way out. Since
// pulido-avisos (2026-10) the per-notification ones live on the DETAIL
// (`aviso/{id}?origen=bandeja`): the row is one compact target that opens it and
// marks it read, and the CTA, "Ver {nombre}" and "archivar" are a tap away.
//
// D5 — REAL PAGINATION, NOT A SENTENCE POINTING AT THE WEB. The list used to
// cap at one page and say so under a card ("Todavía no hay paginado en la
// app…"); it is now a `FlatList` (the same move `app/mascotas/index.tsx`
// made for the same reason — a `ScrollView` cannot grow past what fits, a
// `FlatList` can), and `onEndReached` asks for the next page whenever
// `view.nextCursor` says there is one.
//
// THE ORDER IS NOT THIS SCREEN'S. `notificationsForDisplay` calls the SAME two
// functions the web page calls, out of `@dim/contract/notifications`. A list that
// sorted itself here would be the failure this whole unit exists to prevent:
// not a crash, but the phone showing the same eight notifications in a different
// order from the browser.
//
// EVERY AFFORDANCE COMES FROM THE SERVER. `petLinkAvailable` folds in a denylist
// of notification types whose recipient no longer holds the animal, and the CTA
// opens `aviso/{id}`, whose destination the server resolves at tap time
// (notificaciones-destinos). A screen that derived either from what is on the
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
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { apiFailureMessage } from "../api/client";
import { fetchMyNotifications, sendNotificationCommand } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body, EmptyState, Loading, StaleNotice } from "../ui/components";
import { FONTS } from "../ui/fonts";
import {
  Callout,
  RIPPLE,
  Screen,
  SecondaryButton,
  pressedOpacityUnlessAndroidRipple,
} from "../ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../ui/reload-state";
import { ListSkeleton } from "../ui/skeleton";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TYPE } from "../ui/theme";
import { useReconnect } from "../ui/use-reconnect";

import {
  ALL_CATEGORIES_LABEL,
  type NotificationEntry,
  appendNotificationsPage,
  buildMarkAllRead,
  buildMarkRead,
  categoryLabel,
  emptyBody,
  emptyTitle,
  inboxSummary,
  notificationDateLabel,
  notificationDetailRoute,
  notificationRelativeDateLabel,
  notificationsForDisplay,
  rowsOf,
  severityLabel,
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
  /** Push an in-app path — a row's detail, `aviso/{id}?origen=bandeja`. */
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
      setState((current) => {
        const message = apiFailureMessage(result) ?? "No pudimos leer tus notificaciones.";
        return current.phase === "ready" && current.category !== cat
          ? { phase: "failed", message }
          : reloadFailed(current, result, message);
      });
    },
    [],
  );

  // D5 — one page beyond the first, appended. `loadingMoreRef` (not state)
  // guards against `onEndReached` firing more than once for the same page —
  // FlatList can call it repeatedly while the list settles. `generation` is
  // the SAME race guard `load` already uses, and `current.category === cat`
  // is a second belt: a tab switch already bumps `generation`, but checking
  // the category too is what keeps a slow "more" request from ever merging
  // into a DIFFERENT tab's rows even in a reordering `generation` alone would
  // not catch.
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const loadMore = useCallback(() => {
    if (state.phase !== "ready") return;
    const cursor = state.view.nextCursor;
    if (!cursor || loadingMoreRef.current) return;
    const cat = state.category;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const mine = generation.current;
    void (async () => {
      const result = await fetchMyNotifications(sessionPort, cat, cursor);
      loadingMoreRef.current = false;
      setLoadingMore(false);
      if (mine !== generation.current) return;
      if (result.outcome !== "ok") return;
      setState((current) =>
        current.phase === "ready" && current.category === cat
          ? { ...loaded(appendNotificationsPage(current.view, result.payload)), category: cat }
          : current,
      );
    })();
  }, [state]);

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
        setActionError(apiFailureMessage(result) ?? "No pudimos leer tus notificaciones.");
        return;
      }
      await load(category, "refresh");
    },
    [category, load],
  );

  /**
   * A row tap: open the detail, and mark the row read on the way.
   *
   * OPENING IS READING, so the tap does both (pulido-avisos, 2026-10) — the
   * separate "Marcar como leída" button went with the rest of the row's
   * buttons. The navigation does not wait for the write: the detail resolves
   * on its own, and this screen re-reads when it regains focus (NAV-3), which
   * is when the row's dot and the summary have to agree with the server. The
   * write re-reads too, so a return that beats the write still converges. The
   * home bell re-reads on ITS focus (`useUnreadCount`), so the badge drops when
   * the person gets back there.
   *
   * A REFUSED WRITE IS SAID, as every write here is: the row stays unread on
   * the re-read and the banner says why.
   */
  const open = useCallback(
    (notification: MyNotificationV1) => {
      // A banner from an earlier tap must not outlive the next one.
      setActionError(null);
      if (!notification.read) {
        const command = buildMarkRead([notification.id]);
        if (command.ok) {
          void (async () => {
            const result = await sendNotificationCommand(sessionPort, command.input);
            if (result.outcome !== "ok") {
              setActionError(
                apiFailureMessage(result) ?? "No pudimos marcar la notificación como leída.",
              );
              return;
            }
            await load(category, "refresh");
          })();
        }
      }
      onOpenRoute(notificationDetailRoute(notification));
    },
    [category, load, onOpenRoute],
  );

  if (state.phase === "loading")
    return (
      <Screen>
        <ListSkeleton rows={4} label="Cargando notificaciones…" />
      </Screen>
    );

  if (state.phase === "failed") {
    return (
      // NO <Title>: the stack header already says "Notificaciones" right above.
      <Screen>
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load(category, "initial")} />
      </Screen>
    );
  }

  const view = state.view;
  // D5 — nothing while a NEW category is loading: the skeleton is drawn from
  // `ListEmptyComponent` below, and rendering the PREVIOUS tab's rows behind
  // it (FlatList's `data`) would be exactly the F4 mislabelling this screen's
  // own header already argues against.
  const entries = listReloading ? [] : notificationsForDisplay(view);
  // One instant for every row's "hace 3 h", taken per render — and every
  // re-read renders, so the labels move forward each time the inbox is read.
  const now = new Date();

  return (
    <SafeAreaView style={styles.screen} edges={["bottom"]}>
      <FlatList
        data={entries}
        keyExtractor={(entry) => rowsOf(entry)[0]?.id ?? "sin-id"}
        renderItem={({ item }) => <NotificationEntryRow entry={item} now={now} onOpen={open} />}
        contentContainerStyle={styles.listContent}
        // Native-feel audit (M10) — this list does not go through `Screen`
        // (a `FlatList` cannot nest inside its `ScrollView`), so the same two
        // props `Screen` sets are set here directly instead of this being the
        // one scroll container in the app without them.
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            colors={[COLORS.accent]}
            onRefresh={() => void load(category, "refresh")}
            refreshing={refreshing}
            tintColor={COLORS.accent}
          />
        }
        // D5 — a no-op once `view.nextCursor` is `null`; see `loadMore`.
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={
          <View style={styles.headerGap}>
            {/* NO <Title> HERE: the stack header right above already reads
                "Notificaciones", and the second copy cost a line of every
                screenful (pulido-avisos). The summary is what it added. */}
            <Body>{inboxSummary(view)}</Body>

            {/* The tabs. Only categories that HAVE rows are drawn — an empty tab
                is furniture, and the web hides it too. The counts are the whole
                inbox's, so the bar does not move when a filter is on. */}
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
              <StaleNotice
                message={state.staleFailure}
                onRetry={() => void load(category, "refresh")}
              />
            )}
          </View>
        }
        ListEmptyComponent={
          listReloading ? (
            <ListSkeleton rows={4} label="Cargando notificaciones…" />
          ) : (
            <EmptyState
              headline={emptyTitle(category)}
              body={emptyBody(category)}
              // Passive surface — nothing to "create" here, but a dead end is
              // still a dead end. Point the owner back at their animals.
              actionLabel="Ver mis mascotas"
              onAction={onOpenPets}
            />
          )
        }
        ListFooterComponent={loadingMore ? <Loading label="Cargando más notificaciones…" /> : null}
      />
    </SafeAreaView>
  );
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
 * de Pampa" rows in a row is the state the grouping rule exists to prevent, and
 * a phone has less room to spend on it than a browser does.
 */
function NotificationEntryRow({
  entry,
  now,
  onOpen,
}: {
  entry: NotificationEntry;
  now: Date;
  onOpen: (notification: MyNotificationV1) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (entry.kind === "single") {
    return <NotificationRow notification={entry.row} now={now} onOpen={onOpen} />;
  }

  return (
    <View style={styles.group}>
      <NotificationRow notification={entry.leader} now={now} onOpen={onOpen} />
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
              now={now}
              onOpen={onOpen}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * One notification as a COMPACT ROW (pulido-avisos, 2026-10): the unread dot,
 * the title, the body clamped to two lines, and when it arrived. Nothing else.
 *
 * THE BUTTONS LEFT THE ROW. A card used to carry the full body plus the CTA,
 * "Ver {nombre}", "Marcar como leída" and "Archivar": one and a half
 * notifications per screen, and at font scale 1.3 the first card's buttons sat
 * below the fold. The whole row is now one target, and it opens the detail
 * (`aviso/{id}?origen=bandeja`), where the CTA, the pet link and "Archivar"
 * live. Opening it is what reading it means, so the tap also marks it read.
 *
 * THE DOT CARRIES THE SEVERITY'S COLOUR, and an unread URGENT row keeps its red
 * ground: an urgent notification is a lost animal, and a list where it reads
 * like every other row buries the one row that matters.
 */
function NotificationRow({
  notification,
  now,
  onOpen,
}: {
  notification: MyNotificationV1;
  now: Date;
  onOpen: (notification: MyNotificationV1) => void;
}) {
  const unread = !notification.read;
  const urgentUnread = unread && notification.severity === "urgent";
  const spoken = [
    unread ? "Sin leer" : null,
    severityLabel(notification.severity),
    notification.title,
    notification.body,
    notificationDateLabel(notification.createdAt),
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    // A body that already ends in a full stop must not be read as "..".
    .map((part) => part.replace(/[.\s]+$/, ""))
    .join(". ");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint={
        unread ? "Abre la notificación y la marca como leída." : "Abre la notificación."
      }
      android_ripple={RIPPLE}
      onPress={() => onOpen(notification)}
      style={(state) => [
        styles.row,
        urgentUnread ? styles.rowUrgent : null,
        pressedOpacityUnlessAndroidRipple(state),
      ]}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.dot, unread ? severityDot(notification.severity) : null]}
      />
      <View style={styles.rowMain}>
        <View style={styles.rowHead}>
          <Text style={[styles.rowTitle, unread ? styles.rowTitleUnread : null]}>
            {notification.title}
          </Text>
          <Text style={styles.rowDate}>
            {notificationRelativeDateLabel(notification.createdAt, now)}
          </Text>
        </View>
        {notification.body !== null && (
          <Text numberOfLines={2} style={styles.rowBody}>
            {notification.body}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

/** The unread dot, in the web card's four severity tones. */
function severityDot(severity: string) {
  switch (severity) {
    case "urgent":
      return styles.dotDanger;
    case "warning":
      return styles.dotWarn;
    case "success":
      return styles.dotOk;
    default:
      return styles.dotInfo;
  }
}

const styles = StyleSheet.create({
  // D5 — mirrors `Screen`'s own ground colour and scroll padding/gap
  // (`app/mascotas/index.tsx`'s `styles.screen`/`listContent`), so this list
  // reads identically to the `Screen`-based loading/failed arms above it.
  screen: { flex: 1, backgroundColor: COLORS.canvas },
  listContent: { padding: SPACE.xl2, gap: SPACE.lg },
  headerGap: { gap: SPACE.lg },
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
    minHeight: TOUCH_TARGET,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: SPACE.sm,
    borderRadius: RADIUS.control,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm,
  },
  rowUrgent: { backgroundColor: COLORS.dangerSurface, borderColor: COLORS.dangerBorder },

  // Drawn on every row, transparent when read, so titles align down the list.
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: (TYPE.md * LEADING.md - 8) / 2,
    backgroundColor: "transparent",
  },
  dotDanger: { backgroundColor: COLORS.danger },
  dotWarn: { backgroundColor: COLORS.warnInk },
  dotOk: { backgroundColor: COLORS.okInk },
  dotInfo: { backgroundColor: COLORS.accent },

  rowMain: { flex: 1, gap: 2 },
  rowHead: { flexDirection: "row", alignItems: "flex-start", gap: SPACE.sm },
  rowTitle: {
    flex: 1,
    fontFamily: FONTS.sans,
    fontSize: TYPE.md,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.ink,
  },
  rowTitleUnread: { fontFamily: FONTS.sansSemibold },
  rowDate: {
    flexShrink: 0,
    fontFamily: FONTS.mono,
    fontSize: TYPE.xs,
    lineHeight: TYPE.md * LEADING.md,
    color: COLORS.inkMuted,
  },
  rowBody: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    lineHeight: TYPE.sm * LEADING.md,
    color: COLORS.inkSoft,
  },
});
