// Mis mascotas — the list, and the four things it can honestly be.
//
//   loading   — a skeleton of the cards to come (`ListSkeleton`, the shape
//               Denuncias and Tránsito already use), read aloud as a sentence.
//   failed    — the server's own message plus a retry. NEVER an empty list:
//               "no tenés mascotas" is a claim, and a failed read has not earned
//               the right to make it. That confusion is the single most likely
//               way this screen could lie, because both states draw nothing.
//   empty     — an invitation, not a statement of absence — plus, since the
//               redesign, "¿Ya la registró un veterinario o un refugio?" with a
//               link to Reclamar: exactly the question of somebody arriving
//               with an animal another person already recorded.
//   loaded    — the pets, growing on its own as the list scrolls (D5).
//
// THE ORDER OF THE LOADED SCREEN (inicio-app-rediseno, PO 2026-10-07, see
// `dim-interno:docs/reviews/2026-10-home-app/rediseno-home.html`). First what
// somebody else is waiting on ("Esperan tu respuesta"), then what the person
// has to do ("Te toca a vos"), then "En curso" folded into one row, then the
// animals under "Tus mascotas · N", and the screen ENDS at "Registrar otra
// mascota". There is no footer of destinations in any of the three states any
// more: every other door is in the header — the bell, and the ☰
// (`src/ui/HeaderActions.tsx`) — which never scrolls. Anything that is empty
// is simply not drawn.
//
// `truncated`/`total` STILL RIDE THE PAYLOAD (D5 kept them, additive), but this
// screen no longer reads them to draw a "no hay paginado, entrá desde la web"
// notice — `nextCursor` is the authoritative signal now: non-null means
// `onEndReached` has somewhere to go, and the list simply keeps growing.
//
// ONE READ PER MOUNT, PLUS PULL-TO-REFRESH, PLUS ONE REFETCH ON FOCUS AFTER
// THE FIRST (see the `mounted` ref below — the first focus coincides with the
// mount's own read and must not double it). No timer: the endpoint runs a
// 120/min per-user limiter, and a list that re-reads on a fixed interval
// spends that budget on nothing anybody asked for.
//
// FLATLIST, NOT SCROLLVIEW (M3 / R-1). A real Samsung J7 2016 (Android 8,
// Exynos 7580, 2 GB RAM) measured this screen as janky well above the 25%
// target with many pets on the account. A `ScrollView` mounts every row up
// front — the whole list, its photos and all — no matter how many are
// off-screen; `FlatList` only mounts a window around what is visible. The
// `loaded` arm below is the one place that changed: `loading` and `failed`
// have nothing to virtualize and stay on the shared `Screen` (a `ScrollView`).
// A `FlatList` may not be nested inside that `ScrollView` — React Native warns
// about it for good reason, since a VirtualizedList measures against its own
// scroll container, not one two levels up — so the loaded arm renders its own
// `SafeAreaView` instead of reusing `Screen`.
//
// THE PER-ROW BITMAP CAUSE (see `PetRow.tsx` for the full evidence): no
// `elevation`/`shadow*` and no `Animated` loop touch this list while it is on
// screen, so the classic "shadow forces an offscreen layer redrawn every
// frame" path is not in play here. What the code DID show is every row's
// `<Image source={{uri: ...}}>` being rebuilt from a fresh object literal on
// every render of this screen — including the two `setRefreshing` calls a
// single pull-to-refresh makes — because neither the row component nor its
// `onPress` callback was memoized. `PetRow` is now `React.memo`, its photo
// `source` is `useMemo`'d, and `handleOpenPet` below is a stable
// `useCallback`, which is what makes that memoization worth anything: a
// memoized component with a fresh callback prop every render defeats itself.

import type { MyCasesV1, MyPetsV1 } from "@dim/contract/api";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { apiFailureMessage } from "../../src/api/client";
import { fetchMyPets } from "../../src/api/endpoints";
import { sessionPort } from "../../src/auth/session-store";
import { useGate } from "../../src/auth/useGate";
import { OpenCasesBlock } from "../../src/cases/OpenCasesBlock";
import { hasOpenCases } from "../../src/cases/cases-view-model";
import { useOpenCases } from "../../src/cases/use-open-cases";
import { BiteDraftBanner } from "../../src/pets/BiteDraftBanner";
import { MovedToMenuNotice, useHomeMenuNotice } from "../../src/pets/MovedToMenuNotice";
import { PetRow } from "../../src/pets/PetRow";
import {
  type BiteDraftBanner as BiteDraftInfo,
  useBiteDraftBanner,
} from "../../src/pets/use-bite-draft-banner";
import { PendingIncomingCard } from "../../src/transfers/PendingIncomingCard";
import type { PendingIncomingRow } from "../../src/transfers/pending-incoming-view-model";
import { usePendingIncoming } from "../../src/transfers/use-pending-incoming";
import { EmptyState, ErrorNotice, Loading, StaleNotice } from "../../src/ui/components";
import { FONTS } from "../../src/ui/fonts";
import { Eyebrow, PrimaryButton, Screen, pullToRefresh } from "../../src/ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../../src/ui/reload-state";
import { ROUTES, credentialRoute, recordEventRoute } from "../../src/ui/routes";
import { ListSkeleton } from "../../src/ui/skeleton";
import { COLORS, SPACE, TYPE } from "../../src/ui/theme";
import { useReconnect } from "../../src/ui/use-reconnect";

type ListState = { phase: "loading" } | ReadyState<MyPetsV1> | { phase: "failed"; message: string };

export default function MisMascotasScreen() {
  const gate = useGate();
  const router = useRouter();
  const [state, setState] = useState<ListState>({ phase: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  // A read started before the screen unmounted must not write into a dead
  // component; and two overlapping reads must not race to be last.
  const generation = useRef(0);

  const load = useCallback(async (mode: "initial" | "refresh") => {
    const mine = ++generation.current;
    if (mode === "initial") setState({ phase: "loading" });
    else setRefreshing(true);

    const result = await fetchMyPets(sessionPort);
    if (mine !== generation.current) return;
    if (result.outcome === "ok") setState(loaded(result.payload));
    // THE MEASURED ONE (S-2 / B-05, shots 137-140): with airplane mode on, a
    // pull-to-refresh replaced the two pets on screen AND the "Registrar otra
    // mascota" button with a full-screen error — and turning the network back on
    // cleared the offline banner while the list stayed broken until the person
    // found "Volver a intentar". The animals were still in the phone the whole
    // time. See `reload-state.ts`.
    else
      setState((current) =>
        reloadFailed(current, result, apiFailureMessage(result) ?? "No se pudo leer."),
      );
    setRefreshing(false);
  }, []);

  // D5 — one page beyond the first, appended rather than replacing what is on
  // screen. `loadingMoreRef` (not state) guards against `onEndReached` firing
  // more than once for the same page — FlatList can call it repeatedly while
  // the list settles near the bottom, before a state update has a chance to
  // disable it. `generation` is the SAME race guard `load` already uses: a
  // pull-to-refresh landing while a "more" request is in flight must win, and
  // checking it before applying the appended page is what makes that so.
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const loadMore = useCallback(() => {
    // `!cursor` rather than `=== null`: a fixture or an older cached payload
    // that never carried `nextCursor` at all reads as `undefined`, and that
    // must stop here exactly like an explicit `null` does — not fall through
    // and re-fetch page one under `onEndReached`.
    const cursor = state.phase === "ready" ? state.view.nextCursor : null;
    if (!cursor || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const mine = generation.current;
    void (async () => {
      const result = await fetchMyPets(sessionPort, cursor);
      loadingMoreRef.current = false;
      setLoadingMore(false);
      // A refresh or a fresh initial read superseded this request — its own
      // page already replaced whatever this one would have appended to.
      if (mine !== generation.current) return;
      if (result.outcome !== "ok") return;
      setState((current) =>
        current.phase === "ready"
          ? loaded({ ...result.payload, pets: [...current.view.pets, ...result.payload.pets] })
          : current,
      );
    })();
  }, [state]);

  useEffect(() => {
    void load("initial");
  }, [load]);

  // Reload after a registration: coming back to this screen with a pet that is
  // not in the list is the one moment where a stale cache is obviously wrong.
  // Guarded by a ref so the FIRST focus does not double-read on mount.
  const mounted = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!mounted.current) {
        mounted.current = true;
        return;
      }
      void load("refresh");
    }, [load]),
  );

  // THE BITE-DRAFT BANNER (M5 / Re-1). Its own read, on EVERY focus including
  // the first — unlike the pets list above, there is no double-read to guard
  // against: `listEventDrafts` is one cheap `getAllKeys` pass, and the banner
  // is exactly what must disappear the moment somebody comes back here having
  // sent or discarded the draft it pointed at.
  const { banner: biteDraft, refresh: refreshBiteDraft } = useBiteDraftBanner();
  useFocusEffect(useCallback(() => void refreshBiteDraft(), [refreshBiteDraft]));

  // CASOS ABIERTOS (M11). Its own read, on every focus including the first, for
  // the bite-draft banner's reason: a case closed elsewhere must leave this
  // screen the next time somebody comes back to it. A failure is quiet — see
  // `use-open-cases.ts` — because the pets are what this screen is for.
  const { cases: openCases, refresh: refreshCases } = useOpenCases();
  useFocusEffect(useCallback(() => void refreshCases(), [refreshCases]));

  // ESPERAN TU RESPUESTA (2026-10). Invitations to look after somebody's animal
  // and offers of its titularidad — the same two reads Transferencias makes. A
  // staging invitee never saw a pending invitation because it lived only in the
  // inbox and on that screen; this card puts it on top of the one people open
  // first. Its own read on every focus, quiet when it fails, like the casos.
  const { rows: pendingIncoming, refresh: refreshPendingIncoming } = usePendingIncoming();
  useFocusEffect(useCallback(() => void refreshPendingIncoming(), [refreshPendingIncoming]));

  // WHEN THE NETWORK COMES BACK, TRY AGAIN (B-05). The offline banner already
  // clears itself on this exact event; the list used to sit broken beside it
  // until somebody pressed a button. A refresh and not an initial read: whatever
  // is on screen stays there while it happens.
  useReconnect(() => {
    void load("refresh");
    void refreshCases();
    void refreshPendingIncoming();
  });

  // STABLE ACROSS RENDERS, ON PURPOSE (M3 / R-1). Every `PetRow` in the
  // visible window receives `handleOpenPet` as its `onPress`, and `PetRow` is
  // `React.memo`'d specifically so a re-render of THIS screen — pull-to-
  // refresh's `setRefreshing`, a focus re-read — does not force every row to
  // re-render. That only holds if `handleOpenPet` itself never changes
  // identity. `useCallback(..., [router])` is NOT enough: `expo-router`'s
  // `useRouter()` is not documented to return the same object every render,
  // and under test it measurably does not (`MisMascotasList.test.tsx` caught
  // this — depending on `[router]` made every pull-to-refresh recreate the
  // callback and re-render every row regardless of `React.memo`). `router` is
  // read through a ref instead, so the callback's identity depends on nothing
  // that changes per render.
  const routerRef = useRef(router);
  routerRef.current = router;
  const handleOpenPet = useCallback(
    (publicToken: string) => routerRef.current.push(credentialRoute(publicToken)),
    [],
  );
  const handleRegister = useCallback(() => routerRef.current.push(ROUTES.altaMascota), []);
  const handleOpenBiteDraft = useCallback((publicToken: string) => {
    routerRef.current.push(recordEventRoute(publicToken, { kind: "bite" }));
  }, []);
  // A case row's route is an IN-APP path the server resolved through the
  // deep-link table — the same kind of value the inbox pushes for a CTA.
  const handleOpenCaseRoute = useCallback((route: string) => {
    routerRef.current.push(route as Parameters<typeof router.push>[0]);
  }, []);
  const handleOpenCases = useCallback(() => routerRef.current.push(ROUTES.casos), []);
  const handleOpenPendingRoute = useCallback((route: PendingIncomingRow["route"]) => {
    routerRef.current.push(route);
  }, []);
  const handleOpenTransfers = useCallback(() => routerRef.current.push(ROUTES.transferencias), []);
  const handleOpenClaim = useCallback(() => routerRef.current.push(ROUTES.reclamar), []);

  // "LO QUE ESTABA ABAJO AHORA ESTÁ EN EL MENÚ ☰" — once, until closed
  // (PO 2026-10-07). See `MovedToMenuNotice.tsx`.
  const menuNotice = useHomeMenuNotice();

  if (!gate.allowed) return gate.element;

  if (state.phase !== "ready") {
    return (
      <Screen refreshControl={pullToRefresh(() => void load("refresh"), refreshing)}>
        {state.phase === "loading" ? (
          <ListSkeleton rows={3} label="Buscando tus mascotas…" />
        ) : (
          // NOT an empty list. See the header. Only the FIRST read reaches this:
          // once there are animals on screen they stay.
          <ErrorNotice message={state.message} onRetry={() => void load("initial")} />
        )}
        {/* NO FOOTER HERE ANY MORE, AND NO WAY OUT IS LOST. The destinations
            footer used to be repeated in this arm so a person offline on first
            open was not stuck with an `ErrorNotice` and the back button. The
            header's bell and ☰ (`HeaderActions`) are drawn over all three
            states of this screen, so that exit no longer depends on the body. */}
      </Screen>
    );
  }

  return (
    <PetListScreen
      view={state.view}
      staleFailure={state.staleFailure}
      biteDraft={biteDraft}
      openCases={openCases}
      pendingIncoming={pendingIncoming}
      refreshing={refreshing}
      loadingMore={loadingMore}
      onRefresh={() => {
        void load("refresh");
        void refreshCases();
        void refreshPendingIncoming();
      }}
      onEndReached={loadMore}
      onOpen={handleOpenPet}
      onRegister={handleRegister}
      onOpenBiteDraft={handleOpenBiteDraft}
      onOpenCaseRoute={handleOpenCaseRoute}
      onOpenCases={handleOpenCases}
      onOpenPendingRoute={handleOpenPendingRoute}
      onOpenTransfers={handleOpenTransfers}
      onOpenClaim={handleOpenClaim}
      showMenuNotice={menuNotice.visible}
      onDismissMenuNotice={menuNotice.dismiss}
    />
  );
}

/**
 * The `ready` arm, on its own `FlatList` — see the header for why it cannot
 * share `Screen`'s `ScrollView`.
 */
function PetListScreen({
  view,
  staleFailure,
  biteDraft,
  openCases,
  pendingIncoming,
  refreshing,
  loadingMore,
  onRefresh,
  onEndReached,
  onOpen,
  onRegister,
  onOpenBiteDraft,
  onOpenCaseRoute,
  onOpenCases,
  onOpenPendingRoute,
  onOpenTransfers,
  onOpenClaim,
  showMenuNotice,
  onDismissMenuNotice,
}: {
  view: MyPetsV1;
  staleFailure: string | null;
  biteDraft: BiteDraftInfo | null;
  openCases: MyCasesV1 | null;
  pendingIncoming: PendingIncomingRow[];
  refreshing: boolean;
  /** D5 — a "more" request is in flight; drives the footer spinner. */
  loadingMore: boolean;
  onRefresh: () => void;
  /** D5 — a no-op when `view.nextCursor` is already `null`. */
  onEndReached: () => void;
  onOpen: (publicToken: string) => void;
  onRegister: () => void;
  onOpenBiteDraft: (publicToken: string) => void;
  onOpenCaseRoute: (route: string) => void;
  onOpenCases: () => void;
  onOpenPendingRoute: (route: PendingIncomingRow["route"]) => void;
  onOpenTransfers: () => void;
  onOpenClaim: () => void;
  showMenuNotice: boolean;
  onDismissMenuNotice: () => void;
}) {
  const { pets } = view;

  return (
    <SafeAreaView style={styles.screen} edges={["bottom"]}>
      <FlatList
        data={pets}
        keyExtractor={(pet) => pet.publicToken}
        renderItem={({ item }) => <PetRow pet={item} onPress={onOpen} />}
        contentContainerStyle={styles.listContent}
        // Native-feel audit (M10, 2026-09-24): this screen has no text input of
        // its own, but a keyboard can still be open when it's reached — coming
        // back from a search-driven picker, or from a deep link that lands here
        // after a screen with a field. `Screen`'s own ScrollView already sets
        // both (this list intentionally does NOT use `Screen` — see the header
        // on FLATLIST vs SCROLLVIEW), so the two are set here too rather than
        // leaving this the one scroll container in the app without them.
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        refreshControl={pullToRefresh(onRefresh, refreshing)}
        // D5 — 0.5: fire while the list still has about half a screen of
        // unseen rows below, so the next page is usually in hand before
        // anyone reaches the bottom. `onEndReached` itself is idempotent
        // (`loadMore` no-ops without a `nextCursor` or while one is already
        // in flight), so a second call before the first settles costs nothing.
        onEndReached={onEndReached}
        onEndReachedThreshold={0.5}
        ListHeaderComponent={
          <ListHeader
            staleFailure={staleFailure}
            onRefresh={onRefresh}
            biteDraft={biteDraft}
            onOpenBiteDraft={onOpenBiteDraft}
            openCases={openCases}
            onOpenCaseRoute={onOpenCaseRoute}
            onOpenCases={onOpenCases}
            pendingIncoming={pendingIncoming}
            onOpenPendingRoute={onOpenPendingRoute}
            onOpenTransfers={onOpenTransfers}
            petCount={pets.length === 0 ? 0 : Math.max(view.total, pets.length)}
            showMenuNotice={showMenuNotice}
            onDismissMenuNotice={onDismissMenuNotice}
          />
        }
        ListEmptyComponent={
          <EmptyState
            headline="Todavía no registraste ninguna mascota"
            body="Registrala una vez y su credencial queda disponible para siempre: un QR que cualquiera puede escanear si se pierde."
            actionLabel="Registrar una mascota"
            onAction={onRegister}
            secondary={{
              prompt: "¿Ya la registró un veterinario o un refugio?",
              linkLabel: "Reclamala con su chip o tatuaje",
              onPress: onOpenClaim,
            }}
          />
        }
        ListFooterComponent={
          <ListFooter hasPets={pets.length > 0} onRegister={onRegister} loadingMore={loadingMore} />
        }
        // LOW-END ANDROID TUNING (M3 / R-1, aimed at the J7's 2 GB). A smaller
        // initial window means less work before the first frame; a smaller
        // `windowSize` bounds how much stays mounted while scrolling; cards are
        // NOT fixed-height (a long name can grow the row per `petText`'s
        // comment above), so `getItemLayout` is deliberately not supplied —
        // giving it a wrong estimate would misplace rows, which is worse than
        // the layout pass FlatList already does.
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={5}
      />
    </SafeAreaView>
  );
}

/**
 * Everything that sits ABOVE the pets themselves, now the `FlatList`'s
 * `ListHeaderComponent` so it renders once — same reasoning as `ListFooter`
 * below. Several facts can coexist here and none of them being true says
 * anything about the others. In order: what is about THIS screen (a stale read,
 * the one-time menu notice), what somebody else is waiting on, an unsent bite
 * draft, the casos (only "Te toca a vos" open; "En curso" folded), and last the
 * "Tus mascotas · N" eyebrow that heads the list itself.
 */
function ListHeader({
  staleFailure,
  onRefresh,
  biteDraft,
  onOpenBiteDraft,
  openCases,
  onOpenCaseRoute,
  onOpenCases,
  pendingIncoming,
  onOpenPendingRoute,
  onOpenTransfers,
  petCount,
  showMenuNotice,
  onDismissMenuNotice,
}: {
  staleFailure: string | null;
  onRefresh: () => void;
  biteDraft: BiteDraftInfo | null;
  onOpenBiteDraft: (publicToken: string) => void;
  openCases: MyCasesV1 | null;
  onOpenCaseRoute: (route: string) => void;
  onOpenCases: () => void;
  pendingIncoming: PendingIncomingRow[];
  onOpenPendingRoute: (route: PendingIncomingRow["route"]) => void;
  onOpenTransfers: () => void;
  /** 0 on the empty state, where the `EmptyState` speaks instead of an eyebrow. */
  petCount: number;
  showMenuNotice: boolean;
  onDismissMenuNotice: () => void;
}) {
  const showCases = hasOpenCases(openCases);
  if (
    staleFailure === null &&
    !showMenuNotice &&
    biteDraft === null &&
    !showCases &&
    pendingIncoming.length === 0 &&
    petCount === 0
  )
    return null;
  return (
    <View style={styles.headerGap}>
      {staleFailure === null ? null : <StaleNotice message={staleFailure} onRetry={onRefresh} />}
      {showMenuNotice ? <MovedToMenuNotice onDismiss={onDismissMenuNotice} /> : null}
      {/* What somebody else is waiting on this person to answer — first among
          the facts about the account, because it is the only one with a
          deadline set by someone else. */}
      <PendingIncomingCard
        rows={pendingIncoming}
        onOpenRoute={onOpenPendingRoute}
        onOpenAll={onOpenTransfers}
      />
      {biteDraft === null ? null : (
        <BiteDraftBanner onPress={() => onOpenBiteDraft(biteDraft.publicToken)} />
      )}
      <OpenCasesBlock cases={openCases} onOpenRoute={onOpenCaseRoute} onOpenAll={onOpenCases} />
      {petCount === 0 ? null : (
        // The same Eyebrow + count shape the casos block heads itself with.
        <View style={styles.petsHead} accessibilityRole="header">
          <Eyebrow>Tus mascotas</Eyebrow>
          <Text style={styles.petsCount}>{petCount}</Text>
        </View>
      )}
    </View>
  );
}

/**
 * Everything the old `ListBody` rendered AFTER the pets themselves, now the
 * `FlatList`'s `ListFooterComponent` so it renders once, however many rows are
 * mounted, instead of once per row the way an item inside `data` would.
 *
 * ONE ACTION, AND IT IS THE LAST THING ON THE SCREEN (inicio-app-rediseno):
 * "Registrar otra mascota" is the only action that belongs to this place. The
 * nine destination buttons that used to follow it are the header's ☰ now.
 *
 * D5 — the "La lista está incompleta … entrá desde la web" card is GONE. It
 * existed because there was nowhere else to go for the rest of the list;
 * `onEndReached` is that somewhere now, and `loadingMore` is this footer's own
 * small spinner while the next page is in flight — the only thing left to say
 * about pagination that a growing list does not already say by growing.
 */
function ListFooter({
  hasPets,
  onRegister,
  loadingMore,
}: {
  hasPets: boolean;
  onRegister: () => void;
  loadingMore: boolean;
}) {
  return (
    <View style={styles.footerGap}>
      {hasPets ? (
        <>
          {loadingMore ? <Loading label="Cargando más mascotas…" /> : null}
          <PrimaryButton label="Registrar otra mascota" onPress={onRegister} />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.canvas },
  // Mirrors `Screen`'s own `scroll` style (padding + gap) so the loaded arm
  // reads identically to the loading/failed arms it replaces.
  listContent: { padding: SPACE.xl2, gap: SPACE.lg },
  headerGap: { gap: SPACE.lg },
  footerGap: { gap: SPACE.lg },
  petsHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  petsCount: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.inkMuted },
});
