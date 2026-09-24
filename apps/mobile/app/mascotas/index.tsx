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
// ONE READ PER MOUNT, PLUS PULL-TO-REFRESH. No focus-refetch and no timer: the
// endpoint runs a 120/min per-user limiter, and a list that re-reads every time
// it comes back into view spends that on nothing.
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

import type { MyPetsV1 } from "@dim/contract/api";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { apiFailureMessage } from "../../src/api/client";
import { fetchMyPets } from "../../src/api/endpoints";
import { sessionPort } from "../../src/auth/session-store";
import { useGate } from "../../src/auth/useGate";
import { PetRow } from "../../src/pets/PetRow";
import { TOP_LEVEL_DESTINATIONS } from "../../src/ui/TopLevelNavMenu";
import { Body, Card, EmptyState, ErrorNotice, Loading, StaleNotice } from "../../src/ui/components";
import { PrimaryButton, Screen, SecondaryButton, pullToRefresh } from "../../src/ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../../src/ui/reload-state";
import { ROUTES, credentialRoute } from "../../src/ui/routes";
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

  // WHEN THE NETWORK COMES BACK, TRY AGAIN (B-05). The offline banner already
  // clears itself on this exact event; the list used to sit broken beside it
  // until somebody pressed a button. A refresh and not an initial read: whatever
  // is on screen stays there while it happens.
  useReconnect(() => void load("refresh"));

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
      </Screen>
    );
  }

  return (
    <PetListScreen
      view={state.view}
      staleFailure={state.staleFailure}
      refreshing={refreshing}
      onRefresh={() => void load("refresh")}
      onOpen={handleOpenPet}
      onRegister={handleRegister}
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
  refreshing,
  onRefresh,
  onOpen,
  onRegister,
}: {
  view: MyPetsV1;
  staleFailure: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onOpen: (publicToken: string) => void;
  onRegister: () => void;
}) {
  const { pets, total, truncated } = view;

  return (
    <SafeAreaView style={styles.screen} edges={["bottom"]}>
      <FlatList
        data={pets}
        keyExtractor={(pet) => pet.publicToken}
        renderItem={({ item }) => <PetRow pet={item} onPress={onOpen} />}
        contentContainerStyle={styles.listContent}
        refreshControl={pullToRefresh(onRefresh, refreshing)}
        ListHeaderComponent={
          staleFailure === null ? null : <StaleNotice message={staleFailure} onRetry={onRefresh} />
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
        removeClippedSubviews
      />
    </SafeAreaView>
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
  const router = useRouter();
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

      {/* THE FOOTER RENDERS FROM `TOP_LEVEL_DESTINATIONS` (`src/ui/
          TopLevelNavMenu.tsx`), not from hand-written buttons any more. That
          file carries the WHY for each destination and each position — why
          Tránsito sits beside Transferencias, why Reclamar is not beside
          "Registrar otra mascota", why Denunciar runs last — none of it
          repeated here, because a footer and a header menu built from two
          separately-maintained lists is exactly how the two go on to
          disagree about what "the top level" even is.

          `civicAction` IS THE ONE THING THIS FOOTER DOES THAT THE MENU
          DOESN'T: wrap "Denunciar maltrato" in extra top margin, stacked on
          `styles.footer`'s own uniform `gap`, so a button that files a
          criminal allegation against a named person is not reachable by a
          thumb aiming at the one above it. That is a property of eight
          stacked full-width buttons, not of a short sheet row list, which is
          why the header menu ignores the flag. */}
      <View style={styles.footer}>
        {TOP_LEVEL_DESTINATIONS.map((destination) =>
          destination.civicAction ? (
            <View key={destination.route} style={styles.civicAction}>
              <SecondaryButton
                accessibilityHint={destination.accessibilityHint}
                label={destination.label}
                onPress={() => router.push(destination.route)}
              />
            </View>
          ) : (
            <SecondaryButton
              key={destination.route}
              accessibilityHint={destination.accessibilityHint}
              label={destination.label}
              onPress={() => router.push(destination.route)}
            />
          ),
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.canvas },
  // Mirrors `Screen`'s own `scroll` style (padding + gap) so the loaded arm
  // reads identically to the loading/failed arms it replaces.
  listContent: { padding: SPACE.xl2, gap: SPACE.lg },
  footerGap: { gap: SPACE.lg },
  footer: { marginTop: SPACE.lg, gap: SPACE.sm },
  // The one break in the footer's uniform `gap`, and it carries an argument
  // rather than a taste: "Denunciar maltrato" opens a criminal allegation about
  // a named third party, and every other child of this View is an act on the
  // reader's own records. `marginTop` STACKS on the parent's gap, so the button
  // sits at twice the distance of any other pair — the smallest amount of layout
  // that makes a mis-tap cost a deliberate correction instead of a case file.
  civicAction: { marginTop: SPACE.sm },
});
