// DocumentChromeNative — the framed-sheet chrome that makes both faces read as
// ONE physical two-sided credential, drawn by React Native.
//
// THE REFERENCE IS THE WEB'S `DocumentChrome` + `PublicDocumentBand` + the
// `.pc-band*` / `.pc-cred::before` rules in app/globals.css. Same anatomy: the
// navy landing-sweep band with sunk mark + doctype + flip (both corners turn),
// latent "miMAR", the situation chip on the libreta face, and the body (the
// web's paper grain and escarapela watermark are not drawn here — see below).
// What differs is only the drawing tool:
//
//   · The band is an SVG linear gradient (118deg) — no pinstripes. The web
//     dropped them with the landing carnet recipe.
//   · The mark is the mask path from `logo-mimar-mark-mask.svg`, filled in
//     sunk ink (CSS mask has no RN twin).
//   · No paper grain and no escarapela watermark: both were turned off for
//     the J7 and their PNG rasters, knobs and styles were REMOVED 2026-10-06.
//     Re-adding them means re-adding the assets to apps/mobile/assets too.
//
// THE SITUATION IS SERVER-DECIDED. `situation` arrives as the contract's
// `OwnerPetSituationV1` — key, tone, icon and an already-gender-agreed label —
// and this chrome paints it without re-deriving anything. The BAND is navy for
// every key (`credentialBandSkin`): the approved owner paper does not recolor
// the stripe. The situation's own colour lives on the chip (`bandSkin`), which
// this file draws on the libreta face only — the credencial face has no
// identity row here, so its chip sits under the name in `OwnerFace`. Al día
// sends `situation: null` and gets no chip. Icon + text, never colour alone.
//
// THIS CHROME OWNS THE BUTTON, NOT THE MOTION. The turn itself lives in
// `DocumentTurn.tsx` (React Native core `Animated`, never Reanimated — this
// repo lost a production build to the worklets runtime, see
// src/release/release-config.test.ts). What that split costs this file is one
// extra prop, and it is the web's split exactly: `face` is the face PAINTED on
// the sheet right now and names the button ("Girar a Libreta" / "Girar a
// Credencial"; the control itself is the glyph),
// while `isLibretaActive` is the face the reader has REQUESTED and carries the
// toggle state. They disagree for the ~205ms the sheet spends turning, and
// during that gap the toggle is the honest one — the press registered, the
// document is on its way. `DocumentChrome.tsx` on the web threads the same two
// values into the same two places, for the same reason.

import type { OwnerPetSituationV1 } from "@dim/contract/api";
import { chromeForSurface } from "@dim/contract/credential";
import { type ReactNode, useState } from "react";
import { type LayoutChangeEvent, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";

import { Icon } from "../ui/Icon";
import { FONTS } from "../ui/fonts";
import { COLORS, RADIUS } from "../ui/theme";
import { CARD_LIFT, LATENT_BRAND, MIMAR_MARK } from "./chrome-visual";

const OWNER_CHROME = chromeForSurface("owner");

/**
 * The band names the DOCUMENT TYPE of the face on show — "Credencial · frente"
 * / "Libreta · dorso" (PO-approved band). The owner recipe is two-faced, so
 * its back subtitle is never null; there is deliberately no `?? title`
 * fallback (it was unreachable, and a fence that asserted the title was
 * asserting a string nobody saw). If the contract ever drops the back, fail
 * at load instead of painting an unnamed band.
 */
function ownerBackDoctype(): string {
  const back = OWNER_CHROME.subtitleBack;
  if (back === null) throw new Error("owner credential chrome has no back-face doctype");
  return back;
}
const OWNER_BACK_DOCTYPE = ownerBackDoctype();

/** Web `--color-ln-memorial-chip-bg`. */
const MEMORIAL_CHIP_BG = COLORS.memorialSurface;

/**
 * Sunk/lasered ink on the navy band — the native twin of web `--pc-sunk`
 * (which the web mixes at paint time) and landing `--lp-sunk-ink`.
 */
const SUNK_INK = COLORS.bandSunk;
/** Highlight edge of the engraved ink (web `--pc-sunk-lo` / celeste mix). */
const SUNK_LO = "rgba(215, 243, 255, 0.42)";
/** Web `--pc-head-ink`: celeste-100 at ~82% over the navy. */
const HEAD_INK = "rgba(186, 224, 242, 0.88)";

/** Path from public/logo-mimar-mark-mask.svg (frame + paw). */
const MIMAR_MARK_PATH =
  "M16.25 6.25H83.75L93.75 16.25V83.75L83.75 93.75H16.25L6.25 83.75V16.25ZM21.43 18.75H78.57L81.25 21.43V78.57L78.57 81.25H21.43L18.75 78.57V21.43ZM41.3 30.07C42.75 29.9 44.29 30.5 45.41 31.71C46.53 32.92 47.23 34.75 47.37 36.64C47.51 38.53 47.09 40.49 46.29 41.94C45.5 43.39 44.33 44.32 43.07 44.47C41.81 44.63 40.45 44.01 39.33 42.79C38.21 41.58 37.32 39.78 37 37.91C36.68 36.04 36.92 34.1 37.71 32.66C38.51 31.21 39.86 30.25 41.3 30.07ZM58.66 29.64C60.11 29.87 61.44 30.88 62.2 32.38C62.96 33.87 63.14 35.84 62.77 37.73C62.39 39.61 61.44 41.41 60.26 42.59C59.07 43.78 57.65 44.36 56.36 44.16C55.07 43.95 53.9 42.96 53.14 41.47C52.38 39.97 52.04 37.97 52.26 36.06C52.48 34.15 53.27 32.34 54.45 31.15C55.63 29.96 57.21 29.41 58.66 29.64ZM26.14 40.56C27.2 39.79 28.66 39.59 30.06 40.05C31.46 40.52 32.78 41.65 33.7 43.07C34.62 44.49 35.14 46.21 35.15 47.68C35.16 49.16 34.66 50.38 33.76 51.04C32.85 51.7 31.53 51.79 30.14 51.33C28.74 50.86 27.26 49.84 26.19 48.53C25.12 47.21 24.46 45.6 24.45 44.13C24.44 42.66 25.08 41.32 26.14 40.56ZM73.51 39.92C74.62 40.64 75.34 41.96 75.41 43.45C75.48 44.95 74.91 46.63 73.9 48.02C72.9 49.42 71.46 50.53 70.07 51.07C68.67 51.62 67.32 51.58 66.35 50.96C65.38 50.33 64.8 49.1 64.72 47.61C64.65 46.11 65.09 44.34 65.95 42.86C66.82 41.37 68.12 40.17 69.51 39.62C70.91 39.08 72.4 39.2 73.51 39.92ZM50.29 48.13C52.57 48.14 54.87 48.8 56.98 49.9C59.1 50.99 61.04 52.53 62.53 54.37C64.03 56.21 65.07 58.35 65.4 60.4C65.73 62.45 65.34 64.4 64.26 65.91C63.17 67.42 61.39 68.49 58.99 68.51C56.6 68.53 53.59 67.5 50.48 67.47C47.36 67.45 44.13 68.43 41.58 68.41C39.03 68.39 37.15 67.36 36.03 65.81C34.91 64.26 34.53 62.19 34.88 60.09C35.23 57.99 36.3 55.85 37.85 54.06C39.4 52.27 41.44 50.83 43.59 49.79C45.74 48.76 48 48.12 50.29 48.13Z";

export type DocumentFace = "credencial" | "libreta";

/**
 * Is this string one of the document's two faces?
 *
 * A TYPE GUARD FOR A QUERY PARAMETER, mirroring `isWritableKind` in
 * `record-event-view-model.ts` and used the same way: the route file validates
 * what the URL carried and falls back to the default rather than trusting it.
 * Written here, beside the union, so a third face could never be added without
 * this guard being in the same diff.
 *
 * It exists for `?face=libreta` (native QA batch 1, D3). Saving an asiento used
 * to return the reader to the CREDENTIAL side of the document they had just
 * written into the back of, because `PetDocumentScreen` always opened on
 * `"credencial"` and the return carried nothing to say otherwise.
 */
export function isDocumentFace(raw: string): raw is DocumentFace {
  return raw === "credencial" || raw === "libreta";
}

/**
 * The band's gradient stops + the face's border tint, per situation key —
 * mirroring the `.ln-face[data-situation]` CSS variants, tokens only.
 *
 * The CHIP's colour, not the band's. Exported for
 * `DocumentChromeNative.band-skin.test.ts`: `prenada` and `fallecida` still
 * resolve to their own ink, and the painted band (`credentialBandSkin`) stays
 * the navy default for every key.
 */
export function bandSkin(situationKey: string | undefined): {
  stops: ReadonlyArray<{ offset: string; color: string }>;
  border: string;
} {
  switch (situationKey) {
    case "perdida":
      return {
        stops: [
          { offset: "0%", color: COLORS.seal },
          { offset: "100%", color: COLORS.danger },
        ],
        border: COLORS.dangerBorder,
      };
    case "custodia-oficial":
    case "en-tratamiento":
      return {
        stops: [
          { offset: "0%", color: COLORS.warnInk },
          { offset: "100%", color: COLORS.warnInk },
        ],
        border: COLORS.warnBorder,
      };
    case "observacion-antirrabica":
      return {
        stops: [
          { offset: "0%", color: COLORS.accent },
          { offset: "55%", color: COLORS.celeste },
          { offset: "100%", color: COLORS.celeste },
        ],
        border: COLORS.celeste100,
      };
    case "en-adopcion":
    case "en-transito":
      return {
        stops: [
          { offset: "0%", color: COLORS.ink },
          { offset: "100%", color: COLORS.inkSoft },
        ],
        border: COLORS.borderStrong,
      };
    case "prenada":
      // A FLAT tint — both stops the same colour, byte-for-byte the web's
      // `linear-gradient(135deg, var(--color-ln-rosa), var(--color-ln-rosa))`.
      // Not a mistake to simplify away: every OTHER band here is a two-tone
      // gradient, and this one genuinely is not.
      return {
        stops: [
          { offset: "0%", color: COLORS.rosa },
          { offset: "100%", color: COLORS.rosa },
        ],
        border: COLORS.rosaBorder,
      };
    case "fallecida":
      return {
        stops: [
          { offset: "0%", color: COLORS.memorialSepia },
          { offset: "100%", color: COLORS.memorialText },
        ],
        border: COLORS.memorialBorder,
      };
    default:
      // The default navy band — azul-900 → azul (58%) → celeste, the web's
      // stops verbatim. The fallback for a situation key from a newer server
      // this build does not recognise yet: the chip still names the state.
      return {
        stops: [
          { offset: "0%", color: COLORS.bandDeep },
          { offset: "58%", color: COLORS.accent },
          { offset: "100%", color: COLORS.celeste },
        ],
        border: COLORS.border,
      };
  }
}

/** The band the sheet actually paints: navy, for every situation. */
export function credentialBandSkin(): ReturnType<typeof bandSkin> {
  return bandSkin(undefined);
}

/** Ink for a situation chip sitting on the paper. The band stays navy. */
export function situationChipInk(situationKey: string): string {
  return situationChipSkin(situationKey).color;
}

/**
 * Pill fill / border / ink for a situation chip — web `.pc-sit-chip` per
 * `data-situation`. Perdida is solid white-on-red; the rest are quiet tints.
 */
export function situationChipSkin(situationKey: string): {
  backgroundColor: string;
  borderColor: string;
  color: string;
} {
  switch (situationKey) {
    case "perdida":
      return {
        backgroundColor: COLORS.danger,
        borderColor: COLORS.danger,
        color: COLORS.onDark,
      };
    case "custodia-oficial":
    case "en-tratamiento":
      return {
        backgroundColor: COLORS.warnSurface,
        borderColor: COLORS.warnBorder,
        color: COLORS.warnInk,
      };
    case "observacion-antirrabica":
      return {
        backgroundColor: COLORS.focusRing,
        borderColor: COLORS.celeste100,
        color: COLORS.accent,
      };
    case "fallecida":
      return {
        backgroundColor: MEMORIAL_CHIP_BG,
        borderColor: COLORS.memorialBorder,
        color: COLORS.memorialText,
      };
    case "prenada":
      return {
        backgroundColor: COLORS.stripe,
        borderColor: COLORS.rosaBorder,
        color: COLORS.ink,
      };
    case "en-adopcion":
    case "en-transito":
      return {
        backgroundColor: COLORS.stripe,
        borderColor: COLORS.border,
        color: COLORS.ink,
      };
    default:
      return {
        backgroundColor: COLORS.stripe,
        borderColor: COLORS.border,
        color: bandSkin(situationKey).stops[0]?.color ?? COLORS.ink,
      };
  }
}

/** Landing-sweep band ground — gradient only, no pinstripes. */
/**
 * The band's gradient. NUMERIC SIZE, INSIDE AN ABSOLUTE WRAPPER — never a
 * `width="100%" height="100%"` Svg that is itself absolutely positioned: on
 * Android react-native-svg resolved those percentages to a partial box, and the
 * J7 (EAS preview, 2026-10-06) painted a ~613×45px strip with the rest of the
 * 106px band white, doctype and latent miMAR on white. The wrapper fills the
 * band and measures it; the Svg gets the measured width and `BAND_H`. Until the
 * first layout the wrapper itself is the first stop's navy, so the band is
 * never white even for a frame.
 */
function BandBackground() {
  const skin = credentialBandSkin();
  const [width, setWidth] = useState(0);
  const onLayout = (event: LayoutChangeEvent) => {
    const measured = Math.round(event.nativeEvent.layout.width);
    if (measured > 0 && measured !== width) setWidth(measured);
  };
  return (
    <View
      testID="band-background"
      pointerEvents="none"
      onLayout={onLayout}
      style={[styles.bandBackground, { backgroundColor: skin.stops[0]?.color }]}
    >
      {width > 0 ? <BandGradient width={width} skin={skin} /> : null}
    </View>
  );
}

function BandGradient({
  width,
  skin,
}: {
  width: number;
  skin: ReturnType<typeof credentialBandSkin>;
}) {
  return (
    <Svg
      width={width}
      height={BAND_H}
      viewBox={`0 0 ${BAND_VIEWBOX_W} ${BAND_H}`}
      preserveAspectRatio="xMidYMid slice"
    >
      <Defs>
        {/* 118deg on the web. A mild vertical fall (y2) lets the celeste edge
            read across the taller pad-bottom without washing the latent
            miMAR zone out of navy. */}
        <LinearGradient id="band" x1="0" y1="0" x2="1" y2="0.22">
          {skin.stops.map((stop) => (
            <Stop
              key={`${stop.offset}-${stop.color}`}
              offset={stop.offset}
              stopColor={stop.color}
            />
          ))}
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width={BAND_VIEWBOX_W} height={BAND_H} fill="url(#band)" />
    </Svg>
  );
}

/** Dual Path — ink + celeste hi edge — approximates the web mark's sunk shadow. */
function MimarMark() {
  return (
    <Svg width={BAND_MARK_SIZE} height={BAND_MARK_SIZE} viewBox="0 0 100 100">
      <Path
        d={MIMAR_MARK_PATH}
        fill={SUNK_LO}
        fillRule="evenodd"
        opacity={MIMAR_MARK.hiOpacity}
        transform={`translate(0 ${MIMAR_MARK.hiTranslate})`}
      />
      <Path
        d={MIMAR_MARK_PATH}
        fill={SUNK_INK}
        fillRule="evenodd"
        opacity={MIMAR_MARK.inkOpacity}
      />
    </Svg>
  );
}

/**
 * Card-turn mark — NOT unicode ↻ / Icon `girar` (RefreshCw).
 *
 * On Android, U+21BB often paints as an emoji-style refresh and ignores our
 * sunk colour (J7 review 2026-10-05: a white circular refresh). An open arc
 * with an arrowhead reads as "girar el carnet", not "recargar".
 */
function FlipGlyph({ back }: { back: boolean }) {
  return (
    <Svg
      width={BAND_MARK_SIZE}
      height={BAND_MARK_SIZE}
      viewBox="0 0 22 22"
      style={back ? styles.flipMirrored : undefined}
    >
      <Path
        d="M15.2 6.1a6.1 6.1 0 1 0 1.2 7.2"
        stroke={SUNK_INK}
        strokeWidth={2}
        strokeLinecap="round"
        fill="none"
        opacity={0.62}
      />
      <Path
        d="M14.6 3.6 L17.6 6.5 L14.6 9.4"
        stroke={SUNK_INK}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        opacity={0.62}
      />
    </Svg>
  );
}

/** Engraved latent brand — dual Text so RN can approximate the web's two-way text-shadow. */
function LatentBrand({ label }: { label: string }) {
  return (
    <View
      pointerEvents="none"
      style={styles.bandLatentWrap}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      <Text
        maxFontSizeMultiplier={BAND_MAX_FONT_SCALE}
        style={[styles.bandLatentHi, { opacity: LATENT_BRAND.hiOpacity }]}
      >
        {label}
      </Text>
      <Text
        maxFontSizeMultiplier={BAND_MAX_FONT_SCALE}
        style={[styles.bandLatent, { opacity: LATENT_BRAND.inkOpacity }]}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * Band height — web `.pc-band` padding recipe, not the old absolute-title
 * budget.
 *
 *   pad-top 10 + head min 24 + pad-bottom 72 = 106
 *
 * The bottom pad is the room the identity frames rise into
 * (`IDENTITY_POKE_OUT` ≤ pad-bottom). Mark and flip sit in the head row; the
 * situation chip is NOT in the band (under the name on the front, below the
 * band on the back). `DocumentChromeNative.geometry.test.ts` fences the sum.
 */
export const BAND_PAD_TOP = 10;
/**
 * Bottom pad of the navy sweep — room the photo rises into on the front
 * (`IDENTITY_POKE_OUT`), and the visible gradient fall on both faces.
 * Raised from the web's 50 so the landing sweep reads as a real header on a
 * phone-width card (PO annotate, 2026-10-05), not a thin stripe.
 */
export const BAND_PAD_BOTTOM = 72;
export const BAND_PAD_INLINE_OUTER = 16;
export const BAND_PAD_INLINE_INNER = 12;
export const BAND_HEAD_MIN_H = 24;
export const BAND_MARK_SIZE = 22;
export const BAND_H = BAND_PAD_TOP + BAND_HEAD_MIN_H + BAND_PAD_BOTTOM;

/**
 * The one place in this app that caps text scaling, and why it is this one.
 *
 * DECISION 17A — MEMBRETE (PO): this cap is a letterhead, not body copy, and
 * it stays. A credential's engraved wordmark does not grow past a fixed point
 * just because the reader's system font does — a printed document has the
 * same constraint for the same reason.
 *
 * B-06 measured a three-line title overrun at scale 1.5 on the OLD absolute
 * band. The band is now a single-line doctype + latent brand; the cap still
 * bounds those chrome glyphs so a scaled letterhead cannot push the head past
 * the pad budget. Body copy still scales without a ceiling.
 */
export const BAND_MAX_FONT_SCALE = 1.3;

/**
 * How far the identity frames rise into the band — web `.pc-id { margin-top:
 * -18px }` (shallower poke; mounts sit lower and read larger on web). Must
 * stay ≤ `BAND_PAD_BOTTOM` or the frames collide with the head row.
 *
 * With the taller pad-bottom (72) the photo nests deeper in the navy sweep so
 * the gradient reads as an extended header behind it (PO annotate 2026-10-05).
 */
export const IDENTITY_POKE_OUT = 36;

/** `FaceSection`'s vertical padding — the frames' first parent. */
export const FACE_SECTION_PAD_V = 20;

// The in-band chip line (BAND_CHIP_TOP / _PAD_V / _BORDER, ICON_SM and the
// `bandChip` styles) is gone with the chip itself (2026-10-06): the situation
// chip sits under the name on the front and below the band on the back, so
// nothing in the band has to clear it any more. The geometry fence budgets
// the head row instead, at every system font scale.

/**
 * Latent miMAR sits just under the head row, still inside the navy pad —
 * web uses top:42; on a phone-width card that lands in washed celeste, so we
 * keep it one step higher (J7 review 2026-10-05). Tunable in `chrome-visual.ts`.
 */
export const BAND_LATENT_TOP = LATENT_BRAND.top;

const BAND_VIEWBOX_W = 400;

type DocumentChromeNativeProps = {
  /** The face PAINTED on the sheet right now — names the band and the button. */
  face: DocumentFace;
  /** The face the reader has REQUESTED — the turn button's toggle state, so a
   *  press reads as registered before the sheet finishes turning. */
  isLibretaActive: boolean;
  onTurn: () => void;
  /** Server-decided situation (key/tone/icon/label) — or null for the default
   *  blue band and no chip. Never re-derived client-side. */
  situation: OwnerPetSituationV1 | null;
  children?: ReactNode;
};

function TurnHit({
  onPress,
  label,
  selected,
  children,
}: {
  onPress: () => void;
  /** Name the TARGET face ("Girar a …"), or say what a secondary control is
   *  ("Marca miMAR: …") — never two controls, one name. */
  label: string;
  /** Toggle state. Give it to ONE control per band; omit on the others. */
  selected?: boolean;
  children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      hitSlop={11}
      style={styles.turnHit}
    >
      {children}
    </Pressable>
  );
}

export function DocumentChromeNative({
  face,
  isLibretaActive,
  onTurn,
  situation,
  children,
}: DocumentChromeNativeProps) {
  const isCredencial = face === "credencial";
  const doctype = isCredencial ? OWNER_CHROME.subtitleFront : OWNER_BACK_DOCTYPE;
  // The accessible name always names the TARGET face — the web's exact wording.
  const turnAria = isCredencial ? "Girar a Libreta" : "Girar a Credencial";
  // The mark turns the sheet too, but it is a SECOND control: two controls
  // sharing one name and one toggle state read to TalkBack as the same control
  // listed twice. The flip glyph owns "Girar a …" and the selected state; the
  // mark says what it is and what it does — the web's `markAria`, verbatim.
  const markAria = isCredencial
    ? "Marca miMAR: mostrar la libreta"
    : "Marca miMAR: mostrar la credencial";
  const showBackChip = !isCredencial && situation != null && OWNER_CHROME.showSituationChip;

  const markControl = (
    <TurnHit onPress={onTurn} label={markAria}>
      <MimarMark />
    </TurnHit>
  );
  const flipControl = (
    <TurnHit onPress={onTurn} label={turnAria} selected={isLibretaActive}>
      <FlipGlyph back={!isCredencial} />
    </TurnHit>
  );

  const faceBorder = situation ? bandSkin(situation.key).border : COLORS.border;
  const backChip = situation ? situationChipSkin(situation.key) : null;

  // Outer shell carries the soft lift; inner face clips band/paper to the
  // card radius. (overflow:hidden on the same node as elevation eats the shadow.)
  //
  // NO PAPER / ESCARAPELA TEXTURES. They were turned off for the J7 and their
  // assets, knobs and styles were removed (2026-10-06); re-adding them means
  // re-adding the PNGs. If they come back: on Android a %-height absolute Image
  // of the escarapela (even nested under absoluteFill) grew this card to
  // ~window height (mimar AVD, 2026-10-05) — paint it inside an absoluteFill
  // layer that cannot contribute to the face's height.
  return (
    <View style={styles.faceLift}>
      <View style={[styles.face, { borderColor: faceBorder }]}>
        <View
          style={[
            styles.band,
            isCredencial
              ? { paddingLeft: BAND_PAD_INLINE_OUTER, paddingRight: BAND_PAD_INLINE_INNER }
              : { paddingLeft: BAND_PAD_INLINE_INNER, paddingRight: BAND_PAD_INLINE_OUTER },
          ]}
        >
          <BandBackground />
          <LatentBrand label={OWNER_CHROME.brand} />
          <View style={styles.bandHead}>
            {/* Back face: mark and flip swap sides (web order on balance/trim). */}
            <View style={[styles.bandSlot, styles.bandSlotStart]}>
              {isCredencial ? markControl : flipControl}
            </View>
            <Text maxFontSizeMultiplier={BAND_MAX_FONT_SCALE} style={styles.bandDoctype}>
              {doctype}
            </Text>
            <View style={[styles.bandSlot, styles.bandSlotEnd]}>
              {isCredencial ? flipControl : markControl}
            </View>
          </View>
        </View>

        {showBackChip && situation && backChip ? (
          <View style={styles.backChipRow}>
            <View
              accessibilityRole={situation.key === "perdida" ? "alert" : undefined}
              style={[
                styles.situationPill,
                {
                  backgroundColor: backChip.backgroundColor,
                  borderColor: backChip.borderColor,
                },
              ]}
            >
              <Icon name={situation.icon} size="sm" color={backChip.color} />
              <Text
                maxFontSizeMultiplier={BAND_MAX_FONT_SCALE}
                style={[styles.situationPillText, { color: backChip.color }]}
                numberOfLines={1}
              >
                {situation.label}
              </Text>
            </View>
          </View>
        ) : null}

        <View style={styles.body}>{children}</View>

        {/* Certificate inner hairline — last so it paints over the body edge;
            pointerEvents none so it never eats a tap. */}
        <View pointerEvents="none" style={styles.frame} />
      </View>
    </View>
  );
}

/**
 * Section eyebrow — web `.pc-sec-eyebrow`. Lean: uppercase mono label, no
 * floating chip punched through a hairline. `icon` is accepted and ignored so
 * call sites stay compatible while the chrome stays quiet.
 */
export function FaceDivider({
  icon: _icon,
  label,
}: {
  icon?: string;
  label?: string;
}) {
  if (label === undefined) return <View style={styles.secRule} />;
  return (
    <View style={styles.secEyebrowWrap}>
      <Text style={styles.secEyebrow}>{label}</Text>
    </View>
  );
}

/** The web's `.ln-sec` at the phone layout: 20px vertical, 18px horizontal. */
export function FaceSection({ children }: { children: ReactNode }) {
  return <View style={styles.sec}>{children}</View>;
}

const styles = StyleSheet.create({
  /**
   * Soft lift under the card. Lives OUTSIDE the clipped face so Android
   * elevation / iOS shadow are not eaten by `overflow: "hidden"`.
   * Knobs: `CARD_LIFT` in chrome-visual.ts.
   */
  /**
   * Soft lift under the card. Lives OUTSIDE the clipped face so Android
   * elevation / iOS shadow are not eaten by `overflow: "hidden"`.
   * Knobs: `CARD_LIFT` in chrome-visual.ts.
   */
  faceLift: {
    borderRadius: RADIUS.card,
    ...Platform.select({
      ios: {
        shadowColor: COLORS.ink,
        shadowOpacity: CARD_LIFT.shadowOpacity,
        shadowRadius: CARD_LIFT.shadowRadius,
        shadowOffset: { width: 0, height: CARD_LIFT.shadowOffsetY },
      },
      android: { elevation: CARD_LIFT.elevation },
      default: {},
    }),
  },
  face: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderRadius: RADIUS.card,
    overflow: "hidden",
  },
  frame: {
    position: "absolute",
    top: 7,
    right: 7,
    bottom: 7,
    left: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderSoft,
    borderRadius: 9,
    zIndex: 5,
  },
  /** Fills the band; the gradient Svg inside it carries numeric dimensions. */
  bandBackground: {
    ...StyleSheet.absoluteFill,
    overflow: "hidden",
  },
  band: {
    height: BAND_H,
    paddingTop: BAND_PAD_TOP,
    paddingBottom: BAND_PAD_BOTTOM,
    overflow: "hidden",
    zIndex: 1,
  },
  bandLatentWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    top: BAND_LATENT_TOP,
    zIndex: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  /** Celeste highlight edge under the engraved ink (web's sunk-lo shadow). */
  bandLatentHi: {
    position: "absolute",
    fontFamily: FONTS.serif,
    fontSize: LATENT_BRAND.fontSize,
    lineHeight: LATENT_BRAND.fontSize,
    letterSpacing: LATENT_BRAND.letterSpacing,
    textAlign: "center",
    color: SUNK_LO,
    transform: [{ translateY: 1 }],
  },
  bandLatent: {
    fontFamily: FONTS.serif,
    fontSize: LATENT_BRAND.fontSize,
    lineHeight: LATENT_BRAND.fontSize,
    letterSpacing: LATENT_BRAND.letterSpacing,
    textAlign: "center",
    color: SUNK_INK,
    textShadowColor: "rgba(0,0,0,0.65)",
    textShadowOffset: { width: 0, height: -1 },
    textShadowRadius: 0,
  },
  bandHead: {
    position: "relative",
    zIndex: 1,
    flexDirection: "row",
    alignItems: "center",
    minHeight: BAND_HEAD_MIN_H,
    columnGap: 8,
  },
  bandSlot: {
    flex: 1,
    minHeight: BAND_MARK_SIZE,
    justifyContent: "center",
  },
  bandSlotStart: { alignItems: "flex-start" },
  bandSlotEnd: { alignItems: "flex-end" },
  bandDoctype: {
    fontFamily: FONTS.mono,
    fontSize: 10,
    lineHeight: 10,
    letterSpacing: 10 * 0.22,
    textTransform: "uppercase",
    color: HEAD_INK,
    flexShrink: 0,
  },
  turnHit: {
    width: BAND_MARK_SIZE,
    height: BAND_MARK_SIZE,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: BAND_MARK_SIZE / 2,
  },
  flipMirrored: {
    transform: [{ scaleX: -1 }],
  },
  backChipRow: {
    alignItems: "center",
    paddingTop: 12,
    paddingBottom: 0,
    zIndex: 2,
  },
  /** Shared pill for front (OwnerFace) and back situation chips. */
  situationPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    maxWidth: "88%",
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: RADIUS.button,
    borderWidth: 1,
  },
  situationPillText: {
    fontFamily: FONTS.monoSemibold,
    fontSize: 9,
    letterSpacing: 9 * 0.08,
    textTransform: "uppercase",
  },
  body: {
    zIndex: 2,
  },
  sec: {
    paddingVertical: FACE_SECTION_PAD_V,
    paddingHorizontal: 18,
  },
  /** Quiet rule when a section has no label. */
  secRule: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.borderSoft,
    marginHorizontal: 20,
    marginTop: 4,
  },
  /** Web `.pc-sec-eyebrow` — lean section title, no punched chip. */
  secEyebrowWrap: {
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 0,
    zIndex: 2,
  },
  secEyebrow: {
    fontFamily: FONTS.monoSemibold,
    fontSize: 10,
    letterSpacing: 10 * 0.1,
    textTransform: "uppercase",
    color: COLORS.inkMuted,
  },
});

/** Exported so OwnerFace can reuse the same pill geometry as the libreta face. */
export const situationPillStyles = {
  pill: styles.situationPill,
  text: styles.situationPillText,
};

/**
 * The chrome's StyleSheet, exported for the geometry fence.
 *
 * jest has no Yoga, so the band budget can only be kept honest by arithmetic
 * over the real style objects — `DocumentChromeNative.geometry.test.ts` reads
 * pad / height / poke from HERE.
 */
export const documentChromeStyles = styles;
