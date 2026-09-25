// Mis mascotas — the list, and the four things it can honestly be.
//
//   loading   — a spinner with a sentence, not a bare spinner.
//   failed    — the server's own message plus a retry. NEVER an empty list:
//               "no tenés mascotas" is a claim, and a failed read has not earned
//               the right to make it. That confusion is the single most likely
//               way this screen could lie, because both states draw nothing.
//   empty     — an invitation, not a statement of absence.
//   loaded    — the pets, plus an honest note when the server TRUNCATED the list.
//
// `truncated` DESERVES ITS OWN NOTE. The payload carries `total` and a boolean
// saying the array is shorter than it; a client that ignores both shows a
// complete-looking list that is not complete. There is no pagination in v1, so
// the honest answer is to say how many are missing and where to see them, not to
// pretend the page is the set.
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
import { FlatList, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { apiFailureMessage } from "../../src/api/client";
import { fetchMyPets } from "../../src/api/endpoints";
import { sessionPort } from "../../src/auth/session-store";
import { useGate } from "../../src/auth/useGate";
import { OpenCasesBlock } from "../../src/cases/OpenCasesBlock";
import { hasOpenCases } from "../../src/cases/cases-view-model";
import { useOpenCases } from "../../src/cases/use-open-cases";
import { BiteDraftBanner } from "../../src/pets/BiteDraftBanner";
import { PetRow } from "../../src/pets/PetRow";
import {
  type BiteDraftBanner as BiteDraftInfo,
  useBiteDraftBanner,
} from "../../src/pets/use-bite-draft-banner";
import { DestinationsFooter } from "../../src/ui/TopLevelNavMenu";
import { Body, Card, EmptyState, ErrorNotice, Loading, StaleNotice } from "../../src/ui/components";
import { PrimaryButton, Screen, pullToRefresh } from "../../src/ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../../src/ui/reload-state";
import { ROUTES, credentialRoute, recordEventRoute } from "../../src/ui/routes";
import { COLORS, SPACE } from "../../src/ui/theme";
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

  // WHEN THE NETWORK COMES BACK, TRY AGAIN (B-05). The offline banner already
  // clears itself on this exact event; the list used to sit broken beside it
  // until somebody pressed a button. A refresh and not an initial read: whatever
  // is on screen stays there while it happens.
  useReconnect(() => {
    void load("refresh");
    void refreshCases();
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

  if (!gate.allowed) return gate.element;

  if (state.phase !== "ready") {
    return (
      <Screen refreshControl={pullToRefresh(() => void load("refresh"), refreshing)}>
        {state.phase === "loading" ? (
          <Loading label="Buscando tus mascotas…" />
        ) : (
          // NOT an empty list. See the header. Only the FIRST read reaches this:
          // once there are animals on screen they stay.
          <ErrorNotice message={state.message} onRetry={() => void load("initial")} />
        )}
        {/* THE FOOTER STAYS, EVEN HERE (review fix, 2026-09-24). It used to
            render only from the loaded arm's `ListFooterComponent` below —
            which meant a person offline on first open, or hitting a real
            server failure, saw an `ErrorNotice` and no way out of the screen
            but the hardware back button. `DestinationsFooter` is the SAME
            component the loaded arm uses (`src/ui/TopLevelNavMenu.tsx`), not
            a second copy, so the two arms cannot drift apart again. */}
        <DestinationsFooter />
      </Screen>
    );
  }

  return (
    <PetListScreen
      view={state.view}
      staleFailure={state.staleFailure}
      biteDraft={biteDraft}
      openCases={openCases}
      refreshing={refreshing}
      onRefresh={() => {
        void load("refresh");
        void refreshCases();
      }}
      onOpen={handleOpenPet}
      onRegister={handleRegister}
      onOpenBiteDraft={handleOpenBiteDraft}
      onOpenCaseRoute={handleOpenCaseRoute}
      onOpenCases={handleOpenCases}
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
  refreshing,
  onRefresh,
  onOpen,
  onRegister,
  onOpenBiteDraft,
  onOpenCaseRoute,
  onOpenCases,
}: {
  view: MyPetsV1;
  staleFailure: string | null;
  biteDraft: BiteDraftInfo | null;
  openCases: MyCasesV1 | null;
  refreshing: boolean;
  onRefresh: () => void;
  onOpen: (publicToken: string) => void;
  onRegister: () => void;
  onOpenBiteDraft: (publicToken: string) => void;
  onOpenCaseRoute: (route: string) => void;
  onOpenCases: () => void;
}) {
  const { pets, total, truncated } = view;

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
        ListHeaderComponent={
          <ListHeader
            staleFailure={staleFailure}
            onRefresh={onRefresh}
            biteDraft={biteDraft}
            onOpenBiteDraft={onOpenBiteDraft}
            openCases={openCases}
            onOpenCaseRoute={onOpenCaseRoute}
            onOpenCases={onOpenCases}
          />
        }
        ListEmptyComponent={
          <EmptyState
            headline="Todavía no registraste ninguna mascota"
            body="Registrala una vez y su credencial queda disponible para siempre: un QR que cualquiera puede escanear si se pierde."
            actionLabel="Registrar una mascota"
            onAction={onRegister}
          />
        }
        ListFooterComponent={
          <ListFooter
            hasPets={pets.length > 0}
            onRegister={onRegister}
            total={total}
            truncated={truncated}
            visibleCount={pets.length}
          />
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
 * below. Two banners and one block can coexist here: a stale read, an unsent
 * bite draft and an open case are unrelated facts about the account, and none
 * of them being true says anything about the others. The banners come first —
 * they are about THIS screen's state — and the casos block after them.
 */
function ListHeader({
  staleFailure,
  onRefresh,
  biteDraft,
  onOpenBiteDraft,
  openCases,
  onOpenCaseRoute,
  onOpenCases,
}: {
  staleFailure: string | null;
  onRefresh: () => void;
  biteDraft: BiteDraftInfo | null;
  onOpenBiteDraft: (publicToken: string) => void;
  openCases: MyCasesV1 | null;
  onOpenCaseRoute: (route: string) => void;
  onOpenCases: () => void;
}) {
  const showCases = hasOpenCases(openCases);
  if (staleFailure === null && biteDraft === null && !showCases) return null;
  return (
    <View style={styles.headerGap}>
      {staleFailure === null ? null : <StaleNotice message={staleFailure} onRetry={onRefresh} />}
      {biteDraft === null ? null : (
        <BiteDraftBanner onPress={() => onOpenBiteDraft(biteDraft.publicToken)} />
      )}
      <OpenCasesBlock cases={openCases} onOpenRoute={onOpenCaseRoute} onOpenAll={onOpenCases} />
    </View>
  );
}

/**
 * Everything the old `ListBody` rendered AFTER the pets themselves, now the
 * `FlatList`'s `ListFooterComponent` so it renders once, however many rows are
 * mounted, instead of once per row the way an item inside `data` would.
 */
function ListFooter({
  hasPets,
  onRegister,
  total,
  truncated,
  visibleCount,
}: {
  hasPets: boolean;
  onRegister: () => void;
  total: number;
  truncated: boolean;
  visibleCount: number;
}) {
  return (
    <View style={styles.footerGap}>
      {hasPets ? (
        <>
          {truncated ? (
            <Card title="La lista está incompleta">
              <Body>
                {`Estamos mostrando ${visibleCount} de ${total}. Todavía no hay paginado en la app: para ver el resto entrá desde la web.`}
              </Body>
            </Card>
          ) : null}
          <PrimaryButton label="Registrar otra mascota" onPress={onRegister} />
        </>
      ) : null}

      {/* THE SHARED FOOTER (`src/ui/TopLevelNavMenu.tsx`'s
          `DestinationsFooter`) — see that file for why Tránsito sits beside
          Transferencias, why Reclamar is not beside "Registrar otra mascota",
          why Denunciar runs last, and why this is now the SAME component the
          loading/failed arms render above, not a second copy. */}
      <DestinationsFooter />
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
});
