// LA FICHA — one animal in adoption.
//
// THE ANSWER HAS FOUR SHAPES AND THIS SCREEN DRAWS THREE OF THEM. A listed pet
// renders the ficha; `recently_adopted` and `paused` render a sentence and a way
// back; a 404 is the fourth and it is the only one that says "no encontramos".
// Somebody who arrives at one of the middle two followed a shared link, and
// telling them the animal was never found would be false about a pet that
// exists — that is the whole case spec D7.2 was written for.
//
// EVERY AFFORDANCE COMES FROM THE SERVER. `canApply` and `applyBlockedReason`
// need state this app does not hold (the account's type, whether an unresolved
// application already exists), so the button is drawn from the payload and never
// from anything on the row. The rule is `pets/{token}/profile`'s and it is the
// same one: a client must never draw a control the write would refuse.
//
// THE LABELS ARE THE SERVER'S TOO. `facts`, `sexLabel`, `speciesLabel` and
// `sterilizedLabel` arrive resolved, because three of them agree with the
// animal's sex and the web already shipped "Castrada" over a male dog once.
//
// NO PHOTOS YET, and it is a gap rather than a decision: the payload carries
// `photoUrls` and this screen does not render them. `expo-image` is not in this
// app's dependencies, and adding a native module is an EAS build — the pipeline
// row #1 of the board rules out for now. The URLs are on the wire so the day the
// build lands this is a render and not a round trip.

import type { AdoptionDetailListedV1, AdoptionDetailV1 } from "@dim/contract/api";
import { useFocusEffect } from "expo-router";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { apiFailureMessage } from "../api/client";
import { fetchAdoptionDetail } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { Body, Card, ErrorNotice, Loading, Row, StaleNotice } from "../ui/components";
import { FONTS } from "../ui/fonts";
import { Callout, Eyebrow, PrimaryButton, Screen, SecondaryButton, Title } from "../ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../ui/reload-state";
import { COLORS, LEADING, RADIUS, SPACE, TRACKING, TYPE } from "../ui/theme";
import { useReconnect } from "../ui/use-reconnect";

import {
  applyBlockedCopy,
  closedFichaCopy,
  convivenciaChips,
  feeCopy,
  healthRows,
  orgSectionBody,
  orgSectionLabel,
} from "./adoption-view-model";

type ScreenState =
  | { phase: "loading" }
  | ReadyState<AdoptionDetailV1>
  | { phase: "failed"; message: string };

export function AdoptionDetailScreen({
  petToken,
  onApply,
  onBackToCatalogue,
}: {
  petToken: string;
  onApply: (petToken: string, petName: string) => void;
  onBackToCatalogue: () => void;
}) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const generation = useRef(0);

  /**
   * Read the ficha.
   *
   * THE MODE WAS WRITTEN AND NEVER WIRED (lote 1b review, F7). `hasLoaded` below
   * was assigned and never read, so a failed focus read took
   * `{ phase: "failed" }` and DELETED a ficha somebody was looking at — returning
   * from the postulación form in a dead spot replaced the animal with a refusal.
   * That is the S-2 rule this batch is about, newly violated on a screen that had
   * just started re-reading on focus.
   */
  const load = useCallback(
    async (mode: "initial" | "refresh" = "initial") => {
      const mine = ++generation.current;
      if (mode === "initial") setState({ phase: "loading" });
      const result = await fetchAdoptionDetail(sessionPort, petToken);
      if (generation.current !== mine) return;
      if (result.outcome === "ok") {
        setState(loaded(result.payload));
        return;
      }
      setState((current) =>
        reloadFailed(current, result, apiFailureMessage(result) ?? "No pudimos cargar."),
      );
    },
    [petToken],
  );

  // ON FOCUS, NOT ONLY ON MOUNT (A5-ciudadanas-05 / A4-custodia-07 — the shape
  // `TransfersScreen` has carried since QA batch 3). This screen pushes
  // something on top of itself that CHANGES it, and coming back pops rather than
  // remounts, so a mount-only effect left the reader looking at the state from
  // before their own write.
  //
  // THE REF IS READ AT THE CALL SITE, which is what makes the mode above mean
  // anything. Only the first appearance has nothing to keep.
  const hasLoaded = useRef(false);
  useFocusEffect(
    useCallback(() => {
      void load(hasLoaded.current ? "refresh" : "initial");
      hasLoaded.current = true;
    }, [load]),
  );

  // WHEN THE NETWORK COMES BACK, TRY AGAIN (B-05, the other half of S-2). The
  // ficha holds no input of its own — the postulación form is a separate screen —
  // so an unprompted re-read cannot discard anything somebody typed.
  useReconnect(() => void load("refresh"));

  if (state.phase === "loading") {
    return (
      <Screen>
        <Loading label="Abriendo la ficha…" />
      </Screen>
    );
  }

  if (state.phase === "failed") {
    return (
      <Screen>
        <ErrorNotice message={state.message} onRetry={() => void load("initial")} />
        <SecondaryButton label="Ver otras en adopción" onPress={onBackToCatalogue} />
      </Screen>
    );
  }

  const { detail } = state.view;
  // The failed RE-read, over the ficha it could not replace (S-2). It sits above
  // whichever of the three shapes below is drawn, because "esto puede estar
  // desactualizado" is equally true of a closed ficha and a listed one.
  const stale =
    state.staleFailure === null ? null : (
      <StaleNotice message={state.staleFailure} onRetry={() => void load("refresh")} />
    );

  if (detail.state !== "listed") {
    const copy = closedFichaCopy(detail);
    return (
      <Screen>
        {stale}
        <Title>{copy.title}</Title>
        <Body>{copy.body}</Body>
        <PrimaryButton label="Ver otras en adopción" onPress={onBackToCatalogue} />
      </Screen>
    );
  }

  return (
    <ListedFicha detail={detail} stale={stale} onApply={() => onApply(petToken, detail.name)} />
  );
}

function ListedFicha({
  detail,
  stale,
  onApply,
}: {
  detail: AdoptionDetailListedV1;
  /** The S-2 banner, when the last re-read did not land. */
  stale: ReactNode;
  onApply: () => void;
}) {
  const place = [detail.locality, detail.province].filter(Boolean).join(", ");
  const marks = [detail.color, detail.distinguishingFeatures].filter(Boolean).join(" · ");
  const fee = feeCopy(detail.feeArs);
  const chips = convivenciaChips(detail);

  return (
    <Screen>
      {stale}
      <Title>{detail.name}</Title>
      {detail.breed === null ? null : <Text style={styles.breed}>{detail.breed}</Text>}
      <Text style={styles.meta}>
        {[detail.speciesLabel, detail.sexLabel, ...detail.facts].join(" · ")}
      </Text>
      {marks === "" ? null : <Text style={styles.marks}>{marks}</Text>}
      {place === "" ? null : <Text style={styles.marks}>{place}</Text>}

      {detail.story === null ? null : (
        <Card title={`Sobre ${detail.name}`}>
          <Body>{detail.story}</Body>
        </Card>
      )}

      <Card title="Salud">
        {healthRows(detail).map((row) => (
          <Row key={row.label} label={row.label} value={row.note ?? "Sí"} />
        ))}
        <Body>El detalle clínico completo se comparte al finalizar la adopción.</Body>
      </Card>

      {detail.requirements === null && chips.length === 0 ? null : (
        <Card title="Qué necesita su nuevo hogar">
          {detail.requirements === null ? null : <Body>{detail.requirements}</Body>}
          {chips.map((chip) => (
            <Row key={chip.label} label={chip.label} value={chip.value ? "Sí" : "No"} />
          ))}
        </Card>
      )}

      {/* GATED SERVER-SIDE. The array is empty unless the owner answered "yes"
          to publishing them, and this screen has no way to ask for the codes it
          was not given — which is the point of gating it there. */}
      {detail.permanentConditions.length === 0 ? null : (
        <Card title="Necesidades especiales">
          <Body>
            {detail.name} convive con condiciones permanentes que es importante que conozcas antes
            de postularte. El refugio puede contarte cómo cuidarla.
          </Body>
          {detail.permanentConditions.map((condition) => (
            <Text key={condition} style={styles.condition}>
              {condition}
            </Text>
          ))}
          {detail.permanentConditionsOther === null ? null : (
            <Body>{detail.permanentConditionsOther}</Body>
          )}
        </Card>
      )}

      <View style={styles.org}>
        <Eyebrow>{orgSectionLabel(detail)}</Eyebrow>
        <Text style={styles.orgName}>{detail.org.name}</Text>
        {[detail.org.locality, detail.org.province].filter(Boolean).length === 0 ? null : (
          <Text style={styles.marks}>
            {[detail.org.locality, detail.org.province].filter(Boolean).join(", ")}
          </Text>
        )}
        <Body>{orgSectionBody(detail)}</Body>
      </View>

      {fee === null ? null : (
        <Callout tone="neutral" title={fee}>
          <Body>
            Este aporte ayuda al refugio a cubrir vacunación, castración y atención veterinaria.
          </Body>
        </Callout>
      )}

      {detail.canApply ? (
        <PrimaryButton label={`Postularme a ${detail.name}`} onPress={onApply} />
      ) : (
        <Callout tone="neutral">
          <Body>
            {detail.applyBlockedReason === null
              ? "El refugio no está recibiendo postulaciones por ahora."
              : applyBlockedCopy(detail.applyBlockedReason)}
          </Body>
        </Callout>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  breed: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.md,
    color: COLORS.inkSoft,
  },
  meta: {
    fontFamily: FONTS.mono,
    fontSize: TYPE.sm,
    color: COLORS.inkMuted,
    letterSpacing: TRACKING.wide,
  },
  marks: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    color: COLORS.inkMuted,
    lineHeight: TYPE.sm * LEADING.sm,
  },
  condition: {
    fontFamily: FONTS.sans,
    fontSize: TYPE.sm,
    color: COLORS.accent,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.chip,
    paddingHorizontal: SPACE.xs,
    paddingVertical: 2,
    alignSelf: "flex-start",
  },
  org: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: RADIUS.control,
    backgroundColor: COLORS.surface,
    padding: SPACE.md,
    gap: SPACE.xs,
  },
  orgName: {
    fontFamily: FONTS.serif,
    fontSize: TYPE.lg,
    color: COLORS.ink,
  },
});
