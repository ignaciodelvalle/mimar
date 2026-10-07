// COMPARTIR — who else can see this animal's record, and for how long.
//
// ONE SCREEN FOR TWO MECHANISMS, because the web already fused them
// (`MergedShareSheet`, design ADR-7) and it fused them for a product reason
// rather than a layout one: a person here is choosing HOW MUCH to expose, not
// which subsystem to use. A share LINK is a secret url handed to one vet; the
// TIER-2 WINDOW is the animal's own public credential temporarily showing more.
// Revoking one does nothing to the other, which is exactly why they belong on
// one screen — the question "is anything open right now" has two answers and a
// person must be able to see both without navigating.
//
// EVERY AFFORDANCE COMES FROM `capabilities`, NEVER FROM "is this my pet".
// The four commands do not share one guard: three are titular-only and
// REVOCATION is creator-or-admin, so a co-owner sees links they cannot revoke.
// That flag is per ROW (`share.canRevoke`), it comes from the server, and this
// screen renders the reason instead of the button rather than offering a control
// that answers 403 — which is what the web does, after the tap
// (`SharesManager.tsx:306`).
//
// THE TOKEN NEVER LEAVES THIS SCREEN EXCEPT INTO THE OS SHARE SHEET
// ---------------------------------------------------------------------------
// `shareToken` is a bearer secret over the animal's medical record. The rules,
// which this file follows and a reviewer should check it against:
//
//   · It is NEVER rendered as text. The list shows the label, the expiry and
//     the view count — never the credential — so a screenshot, a screen
//     recording or somebody reading over a shoulder in a waiting room does not
//     hand it over. The web shows the url because a desktop has a copy button
//     and no shoulder; a phone has both problems and the OS share sheet solves
//     the one that matters.
//   · It is NEVER logged. There is no `console.*` in this file, and no failure
//     message echoes anything the server sent — every arm of every switch is a
//     fixed sentence.
//   · It is NEVER cached. This screen holds the payload in state and it dies
//     with the screen; `credential-cache.ts` is for the PUBLIC credential and
//     nothing here goes near it. That is the same line `LibretaScreen` draws.
//   · The only exit is `Share.share({ message: url })` — the OS sheet, where
//     the person chooses the recipient. `Share` is React Native's own, so this
//     costs no dependency.
//
// THE PUBLIC CREDENTIAL TRAVELS THE SAME WAY, AND FIRST. "Enviar la credencial
// pública" hands `/p/{token}` — the url the QR already encodes — to the same OS
// sheet. It is the one thing on this screen that exposes nothing new (the QR is
// printed on the animal's tag), so it leads, above the two mechanisms that do.
//
// NO CLIPBOARD BUTTON, and that is a decision rather than an omission. Copying
// would need `expo-clipboard` (a dependency, for one button) and would put a
// live medical credential on the system clipboard, where every other app can
// read it and where it sits until something else overwrites it. The share sheet
// hands it to one chosen recipient and keeps nothing.

import { useCallback, useEffect, useState } from "react";
import { RefreshControl, Share, StyleSheet, Text, View } from "react-native";

import type { PetSharesV1, ShareCommandAckV1 } from "@dim/contract/api";
import { LIBRETA_SHARE_LABEL_MAX } from "@dim/contract/input";
import type { ShareCommandInput, Tier2Window } from "@dim/contract/input";

import { apiFailureMessage } from "../api/client";
import { fetchPetShares, sendShareCommand } from "../api/endpoints";
import { sessionPort } from "../auth/session-store";
import { API_BASE_URL, publicCredentialPageUrl } from "../config/api";
import { Body, Card, StaleNotice } from "../ui/components";
import { FONTS } from "../ui/fonts";
import {
  Callout,
  Choice,
  ListRow,
  PrimaryButton,
  Screen,
  SecondaryButton,
  TextField,
  Title,
} from "../ui/kit";
import { type ReadyState, loaded, reloadFailed } from "../ui/reload-state";
import { ListSkeleton } from "../ui/skeleton";
import { COLORS, SPACE, TYPE } from "../ui/theme";

import {
  SHARE_DURATION_CHOICES,
  TIER2_WINDOW_CHOICES,
  buildCreateShare,
  buildEnableTier2,
  buildRevokeShare,
  buildRevokeTier2,
  createBlockedReason,
  credentialShareMessage,
  durationChoiceKey,
  libretaShareUrl,
  shareExpiryLabel,
  shareRevokeBlockedReason,
  shareTitle,
  shareViewsLabel,
  tier2BlockedReason,
  tier2StateLabel,
} from "./shares-view-model";

/**
 * One sentence per failure arm. No arm may fall through to a generic shrug, and
 * none of them quotes anything the server sent — see the header on why an error
 * message is a place a credential must never reach.
 */
type ScreenState =
  | { phase: "loading" }
  | ReadyState<PetSharesV1>
  | { phase: "failed"; message: string };

/** What just happened, for the line above the list. */
type Notice = { tone: "ok" | "err"; message: string } | null;

function ackLabel(ack: ShareCommandAckV1): string {
  if (!ack.changed) {
    // A no-op is a SUCCESS and saying "listo" would be true but unhelpful. All
    // three no-op paths mean the same thing to a person: what you asked for was
    // already the case.
    switch (ack.command) {
      case "create_libreta_share":
        return "Ya tenías un link igual. Te devolvimos ese.";
      case "enable_tier2":
        return "Esa ventana ya estaba abierta.";
      case "revoke_tier2":
        return "La libreta ya no se mostraba en la credencial pública.";
      case "revoke_libreta_share":
        return "Ese link ya estaba revocado.";
    }
  }
  switch (ack.command) {
    case "create_libreta_share":
      return "Link creado.";
    case "revoke_libreta_share":
      return "Link revocado. Deja de funcionar ahora mismo.";
    case "enable_tier2":
      return "Listo. La libreta se muestra en la credencial pública.";
    case "revoke_tier2":
      return "Listo. La libreta dejó de mostrarse en la credencial pública.";
  }
}

export function SharesScreen({ publicToken }: { publicToken: string }) {
  const [state, setState] = useState<ScreenState>({ phase: "loading" });
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [days, setDays] = useState<number | null>(30);
  // Nothing is sent until "Mostrar la libreta" is pressed; the recommended
  // window is the starting point, as the web's sheet starts on it.
  const [tier2Window, setTier2Window] = useState<Tier2Window>("24h");

  // Pull-to-refresh (QOL 2026-09-01): the shared Screen carried the prop all
  // along and /mascotas + notificaciones already used it — these lists were
  // the odd ones out. A refresh keeps the list on screen instead of blanking
  // to the loading phase; only the very first load does that.
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (mode: "initial" | "refresh" = "initial") => {
      if (mode === "refresh") setRefreshing(true);
      else setState({ phase: "loading" });
      const result = await fetchPetShares(sessionPort, publicToken);
      if (mode === "refresh") setRefreshing(false);
      if (result.outcome === "ok") {
        setState(loaded(result.payload));
        return;
      }
      // KEEPING WHAT IS ON SCREEN (S-2). This panel holds live share links and
      // the Tier-2 window; a failed refresh that deleted them would leave
      // somebody unable to revoke a link that is still public.
      setState((current) =>
        reloadFailed(
          current,
          result,
          apiFailureMessage(result) ?? "No pudimos leer los compartidos.",
        ),
      );
    },
    [publicToken],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (input: ShareCommandInput) => {
      setBusy(true);
      setNotice(null);
      const result = await sendShareCommand(sessionPort, publicToken, input);
      setBusy(false);
      if (result.outcome !== "ok") {
        setNotice({
          tone: "err",
          message: apiFailureMessage(result) ?? "No pudimos leer los compartidos.",
        });
        return null;
      }
      setNotice({ tone: "ok", message: ackLabel(result.payload) });
      // The ack is deliberately NOT the new state — re-read, because the list,
      // the window and the capability flags are computed together exactly once.
      await load();
      return result.payload;
    },
    [load, publicToken],
  );

  /**
   * Hand a link to the OS share sheet.
   *
   * The ONLY exit a token has from this screen. `Share.share` rejects when the
   * user dismisses on some platforms, so the failure is swallowed rather than
   * reported: a dismissed share sheet is not an error and a red banner over it
   * would be the app scolding somebody for changing their mind.
   */
  const shareLink = useCallback(async (shareToken: string, petName: string) => {
    const url = libretaShareUrl(API_BASE_URL, shareToken);
    try {
      await Share.share({ message: `Libreta sanitaria de ${petName}: ${url}` });
    } catch {
      // Dismissed, or no share target. Nothing to say and nothing to log.
    }
  }, []);

  /**
   * Hand the PUBLIC credential's url to the OS share sheet — the same url the
   * QR encodes. Not a secret (it is printed on the tag), but it still leaves
   * only through the sheet, where the person picks who gets it.
   */
  const shareCredential = useCallback(
    async (petName: string) => {
      try {
        await Share.share({
          message: credentialShareMessage(petName, publicCredentialPageUrl(publicToken)),
        });
      } catch {
        // Dismissed, or no share target. Nothing to say and nothing to log.
      }
    },
    [publicToken],
  );

  const refresher = (
    <RefreshControl
      colors={[COLORS.accent]}
      onRefresh={() => void load("refresh")}
      refreshing={refreshing}
      tintColor={COLORS.accent}
    />
  );

  if (state.phase === "loading")
    return (
      <Screen>
        <ListSkeleton rows={3} label="Cargando compartidos…" />
      </Screen>
    );

  if (state.phase === "failed") {
    return (
      <Screen>
        <Title>Compartir</Title>
        <Callout tone="err">
          <Body>{state.message}</Body>
        </Callout>
        <SecondaryButton label="Reintentar" onPress={() => void load()} />
      </Screen>
    );
  }

  const view = state.view;
  const createBlocked = createBlockedReason(view);
  const tier2Blocked = tier2BlockedReason(view);
  const selectedTier2 = TIER2_WINDOW_CHOICES.find((choice) => choice.window === tier2Window);

  return (
    // `keyboardAvoiding` because the create form has a text input near the
    // bottom of a long scroll — without it the keyboard covers the field a
    // person is typing into.
    <Screen keyboardAvoiding refreshControl={refresher}>
      <Title>Compartir</Title>
      <Body>{view.petName}</Body>

      <ListRow
        label="Enviar la credencial pública"
        caption="La página pública de su credencial, con lo que elegiste mostrar."
        accessibilityHint="Abre el menú para compartir del teléfono"
        onPress={() => void shareCredential(view.petName)}
      />

      {state.staleFailure === null ? null : (
        <StaleNotice message={state.staleFailure} onRetry={() => void load("refresh")} />
      )}

      {/* `Callout` renders its children into a bare <View>, so the text has to
          arrive already wrapped — a raw string there is invalid in React Native
          and simply never becomes a node anything can find. */}
      {notice !== null && (
        <Callout tone={notice.tone}>
          <Body>{notice.message}</Body>
        </Callout>
      )}

      <Card title="Credencial pública">
        <Body>{tier2StateLabel(view.tier2)}</Body>
        {tier2Blocked !== null ? (
          <Callout tone="neutral">
            <Body>{tier2Blocked}</Body>
          </Callout>
        ) : (
          <View style={styles.stack}>
            <Choice
              label="¿Por cuánto tiempo?"
              options={TIER2_WINDOW_CHOICES.map((choice) => choice.window)}
              selected={tier2Window}
              optionLabel={(window) =>
                TIER2_WINDOW_CHOICES.find((choice) => choice.window === window)?.label ?? window
              }
              onSelect={setTier2Window}
              disabled={busy}
            />
            {/* THE RISK TRAVELS IN THE COPY (see TIER2_WINDOW_CHOICES): the
                permanent window is marked "Avanzado" where the web hides it
                behind an expander, and its detail says what it costs. */}
            {selectedTier2 === undefined ? null : (
              <Text style={styles.detail}>
                {selectedTier2.advanced
                  ? `Avanzado · ${selectedTier2.detail}`
                  : selectedTier2.detail}
              </Text>
            )}
            <SecondaryButton
              label="Mostrar la libreta"
              disabled={busy}
              onPress={() => {
                const built = buildEnableTier2(tier2Window);
                if (!built.ok) {
                  setNotice({ tone: "err", message: built.message });
                  return;
                }
                void run(built.input);
              }}
            />
            {view.capabilities.canRevokeTier2 && (
              <SecondaryButton
                label="Dejar de mostrar"
                disabled={busy}
                onPress={() => {
                  const built = buildRevokeTier2();
                  if (built.ok) void run(built.input);
                }}
              />
            )}
          </View>
        )}
      </Card>

      <Card title="Links de la libreta">
        {view.libretaShares.length === 0 ? (
          <Body>No hay links activos.</Body>
        ) : (
          view.libretaShares.map((share) => {
            const blocked = shareRevokeBlockedReason(share);
            return (
              <View key={share.id} style={styles.row}>
                <Text style={styles.rowTitle}>{shareTitle(share)}</Text>
                <Text style={styles.detail}>{shareExpiryLabel(share)}</Text>
                <Text style={styles.detail}>{shareViewsLabel(share)}</Text>
                <SecondaryButton
                  label="Compartir link"
                  disabled={busy}
                  onPress={() => void shareLink(share.shareToken, view.petName)}
                />
                {blocked === null ? (
                  <SecondaryButton
                    label="Revocar"
                    disabled={busy}
                    onPress={() => {
                      const built = buildRevokeShare(share.id);
                      if (!built.ok) {
                        setNotice({ tone: "err", message: built.message });
                        return;
                      }
                      void run(built.input);
                    }}
                  />
                ) : (
                  <Text style={styles.detail}>{blocked}</Text>
                )}
              </View>
            );
          })
        )}
      </Card>

      <Card title="Crear un link nuevo">
        {createBlocked !== null ? (
          <Callout tone="neutral">
            <Body>{createBlocked}</Body>
          </Callout>
        ) : (
          <View style={styles.stack}>
            <TextField
              label="¿Para quién es? (opcional)"
              value={label}
              onChangeText={setLabel}
              // The CONTRACT's cap, not a number typed here. The web had two
              // copies of this limit that disagreed (one 80, one absent); a
              // third would have been the same mistake with a new author.
              maxLength={LIBRETA_SHARE_LABEL_MAX}
            />
            <Choice
              label="Vence en"
              options={SHARE_DURATION_CHOICES.map((choice) => durationChoiceKey(choice.days))}
              selected={durationChoiceKey(days)}
              optionLabel={(key) =>
                SHARE_DURATION_CHOICES.find((choice) => durationChoiceKey(choice.days) === key)
                  ?.label ?? key
              }
              onSelect={(key) => {
                const choice = SHARE_DURATION_CHOICES.find(
                  (c) => durationChoiceKey(c.days) === key,
                );
                if (choice !== undefined) setDays(choice.days);
              }}
              disabled={busy}
            />
            <PrimaryButton
              label="Crear link"
              disabled={busy}
              onPress={() => {
                const built = buildCreateShare({ days, label });
                if (!built.ok) {
                  setNotice({ tone: "err", message: built.message });
                  return;
                }
                void (async () => {
                  const ack = await run(built.input);
                  setLabel("");
                  // Hand the fresh link straight to the share sheet: the person
                  // is standing in front of the vet, and the reason the ack
                  // carries a token at all is that this is the moment it is
                  // needed. It is never rendered on the way past.
                  if (ack?.shareToken !== null && ack?.shareToken !== undefined) {
                    await shareLink(ack.shareToken, view.petName);
                  }
                })();
              }}
            />
          </View>
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { gap: SPACE.sm },
  row: {
    gap: SPACE.xs,
    paddingVertical: SPACE.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  rowTitle: {
    fontFamily: FONTS.sansSemibold,
    fontSize: TYPE.base,
    color: COLORS.ink,
  },
  detail: { fontFamily: FONTS.sans, fontSize: TYPE.sm, color: COLORS.inkMuted },
});
