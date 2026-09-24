// ADOPTAR — el catálogo.
//
// THE FIRST SCREEN IN THIS APP ABOUT ANIMALS NOBODY IN IT HOLDS. `/mascotas` is
// what this person is responsible for; `/transferencias` and `/notificaciones`
// are addressed to them. This one is a catalogue a shelter published, and every
// affordance on it belongs to somebody else's animal.
//
// WHAT IT DOES NOT BRING ACROSS FROM THE WEB, said here rather than left as a
// silence: the web's `AdoptionFiltersBar` carries ten filters (species,
// province, locality, age, size, energy, three convivencia booleans, microchip,
// a text search and an org scope). This screen carries ONE — species — and the
// endpoint accepts three. That is a real gap and it is on the board; what makes
// it safe to ship without the rest is that the filters are a VIEW: the same
// animals are all reachable by scrolling, so a missing filter costs patience
// rather than access.
//
// PAGINATION IS "MOSTRAR MÁS" AND NOT INFINITE SCROLL, mirroring the web. The
// cursor is the server's own opaque string, appended rather than replacing the
// list, so somebody who has scrolled through four pages does not lose them by
// reaching the end.

import type { AdoptionCatalogueItemV1, AdoptionCatalogueV1 } from "@dim/contract/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";

import { type ApiResult, apiFailureMessage } from "../api/client";
import { fetchAdoptionCatalogue } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { EmptyState, ErrorNotice, Loading, StaleNotice } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { Choice, Screen, SecondaryButton, Subtitle, Title } from "../ui/kit";
import { COLORS, LEADING, RADIUS, SPACE, TOUCH_TARGET, TRACKING, TYPE } from "../ui/theme";

import { cardBadges, cardSubtitle, catalogueEmpty, catalogueSummary } from "./adoption-view-model";

type ScreenState =
  | { phase: "loading" }
  | { phase: "ready"; items: AdoptionCatalogueItemV1[]; nextCursor: string | null }
  | { phase: "failed"; message: string };

const SPECIES = ["dog", "cat"] as const;
type Species = (typeof SPECIES)[number];

const SPECIES_LABEL: Record<Species, string> = { dog: "Perros", cat: "Gatos" };

export function AdoptionCatalogueScreen({
  onOpenPet,
  onOpenMyApplications,
}: {
  onOpenPet: (petToken: string) => void;
  onOpenMyApplications: () => void;
}) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [species, setSpecies] = useState<Species | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Why the LAST "Mostrar más" produced nothing. See `onMore` (A5-ciudadanas-06). */
  const [moreFailure, setMoreFailure] = useState<string | null>(null);
  // A read started before the screen unmounted must not write into a dead
  // component; and two overlapping reads must not race to be last.
  const generation = useRef(0);

  const load = useCallback(async (filter: Species | null) => {
    const mine = ++generation.current;
    const result: ApiResult<AdoptionCatalogueV1> = await fetchAdoptionCatalogue(sessionPort, {
      species: filter,
    });
    if (generation.current !== mine) return;
    if (result.outcome === "ok") {
      setState({
        phase: "ready",
        items: result.payload.items,
        nextCursor: result.payload.nextCursor,
      });
      return;
    }
    // NOT AN EMPTY CATALOGUE. The server answers 503 rather than an empty page
    // for a read it could not finish, and this screen must not translate that
    // back into "no hay animales" — which is the one sentence that would send
    // somebody looking for a companion away.
    setState({ phase: "failed", message: apiFailureMessage(result) ?? "No pudimos cargar." });
  }, []);

  useEffect(() => {
    void load(species);
  }, [load, species]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load(species);
    setRefreshing(false);
  }, [load, species]);

  const onMore = useCallback(async () => {
    if (state.phase !== "ready" || state.nextCursor === null) return;
    setLoadingMore(true);
    setMoreFailure(null);
    const mine = ++generation.current;
    const result = await fetchAdoptionCatalogue(sessionPort, {
      species,
      cursor: state.nextCursor,
    });
    if (generation.current !== mine) {
      setLoadingMore(false);
      return;
    }
    if (result.outcome === "ok") {
      // APPENDED, never replaced: somebody who has scrolled four pages does not
      // lose them by reaching the end of the fourth.
      setState((prev) =>
        prev.phase === "ready"
          ? {
              phase: "ready",
              items: [...prev.items, ...result.payload.items],
              nextCursor: result.payload.nextCursor,
            }
          : prev,
      );
    } else {
      // A PAGE THAT DID NOT ARRIVE IS NOT A PAGE THAT IS NOT THERE
      // (A5-ciudadanas-06). This arm did not exist: the button spun, came back,
      // and nothing changed — so the only reading available to the person was
      // "there are no more animals", which is exactly what the cursor says is
      // false. The list itself stays (S-2's rule): the failure is about the
      // NEXT page, not about the ones already on screen, and the button stays
      // pressable because the next tap is the fix.
      setMoreFailure(apiFailureMessage(result) ?? "No pudimos traer más mascotas.");
    }
    setLoadingMore(false);
  }, [species, state]);

  if (state.phase === "loading") {
    return (
      <Screen>
        <Loading label="Buscando mascotas…" />
      </Screen>
    );
  }

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Adoptar</Title>
        <ErrorNotice message={state.message} onRetry={() => void load(species)} />
      </Screen>
    );
  }

  const empty = catalogueEmpty(species !== null);

  return (
    <Screen
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}
    >
      <Title>Adoptar</Title>
      <Subtitle>
        Mascotas publicadas por refugios verificados. Si ves alguna que te resuene, postulate y el
        refugio te contacta.
      </Subtitle>

      <Choice
        label="Especie"
        options={SPECIES}
        selected={species}
        optionLabel={(value) => SPECIES_LABEL[value]}
        onSelect={(value) => setSpecies((current) => (current === value ? null : value))}
      />

      {state.items.length === 0 ? (
        <EmptyState
          headline={empty.title}
          body={empty.body}
          actionLabel={species === null ? undefined : "Ver todas"}
          onAction={species === null ? undefined : () => setSpecies(null)}
        />
      ) : (
        <>
          <Text style={styles.summary}>
            {catalogueSummary(state.items.length, state.nextCursor !== null)}
          </Text>
          {state.items.map((item) => (
            <AdoptionCard
              key={item.petToken}
              item={item}
              onPress={() => onOpenPet(item.petToken)}
            />
          ))}
          {moreFailure === null ? null : <StaleNotice message={moreFailure} />}
          {state.nextCursor === null ? null : (
            <SecondaryButton
              label={loadingMore ? "Cargando…" : "Mostrar más"}
              disabled={loadingMore}
              onPress={() => void onMore()}
            />
          )}
        </>
      )}

      <SecondaryButton label="Mis postulaciones" onPress={onOpenMyApplications} />
    </Screen>
  );
}

function AdoptionCard({
  item,
  onPress,
}: {
  item: AdoptionCatalogueItemV1;
  onPress: () => void;
}) {
  const subtitle = cardSubtitle(item);
  const badges = cardBadges(item);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.name}, ${item.speciesLabel}`}
      onPress={onPress}
      style={styles.card}
    >
      <Text style={styles.cardName}>{item.name}</Text>
      {subtitle === "" ? null : <Text style={styles.cardSubtitle}>{subtitle}</Text>}
      {item.facts.length === 0 ? null : (
        <Text style={styles.cardFacts}>{item.facts.join(" · ")}</Text>
      )}
      {badges.length === 0 ? null : (
        <View style={styles.badges}>
          {badges.map((badge) => (
            <Text key={badge} style={styles.badge}>
              {badge}
            </Text>
          ))}
        </View>
      )}
      <Text style={styles.cardOrg}>{item.orgName}</Text>
    </Pressable>
  );
}

/** Exported for the screen test, which asserts the copy rather than the layout. */
export const CATALOGUE_STRINGS = {
  loading: "Buscando mascotas…",
} as const;

const styles = StyleSheet.create({
  summary: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.sm,
    color: COLORS.inkMuted,
    letterSpacing: TRACKING.wide,
  },
  card: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.control,
    backgroundColor: COLORS.surface,
    padding: SPACE.md,
    gap: SPACE.xs,
    minHeight: TOUCH_TARGET,
  },
  cardName: {
    fontFamily: FONTS.serif,
    fontSize: TYPE.lg,
    color: COLORS.ink,
  },
  cardSubtitle: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.md,
    color: COLORS.inkSoft,
    lineHeight: TYPE.md * LEADING.md,
  },
  cardFacts: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    color: COLORS.inkMuted,
  },
  badges: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: SPACE.xs,
  },
  badge: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.xs,
    color: COLORS.accent,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.chip,
    paddingHorizontal: SPACE.xs,
    paddingVertical: 2,
  },
  cardOrg: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.xs,
    color: COLORS.inkMuted,
    letterSpacing: TRACKING.wide,
  },
});
