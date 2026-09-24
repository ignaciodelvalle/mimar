// DocumentChromeNative — the framed-sheet chrome that makes both faces read as
// ONE physical two-sided credential, drawn by React Native.
//
// THE REFERENCE IS THE WEB'S `DocumentChrome` + the `.ln-*` rules in
// app/globals.css, at the PHONE layout (`@media (max-width: 720px)`) — a phone
// is always ≤720. Same anatomy: the blue pinstripe band carrying the
// certificate title and the turn button, the situation chip, the certificate
// inner hairline frame, and the body. What differs is only the drawing tool:
//
//   · The band's `repeating-linear-gradient` pinstripes have no RN equivalent,
//     so the band is an SVG (react-native-svg, already a dependency): one
//     linear gradient underneath, one set of diagonal hairlines on top.
//   · The white-translucency literals (rgba(255,255,255,.22) on the turn
//     button, rgba(0,0,0,.22) on the chip, the .5-alpha pinstripe) are the
//     web's own values from globals.css, copied — not invented. They are not
//     tokens on the web either.
//
// THE SITUATION IS SERVER-DECIDED. `situation` arrives as the contract's
// `OwnerPetSituationV1` — key, tone, icon and an already-gender-agreed label —
// and this chrome paints it without re-deriving anything. The band tint per
// key mirrors the `.ln-face[data-situation]` variants; every key this chrome
// recognises has its own band now (T4-M6, 2026-09-22) — `prenada` and
// `fallecida` used to keep the DEFAULT band here because their tint tokens
// (--color-ln-rosa*, --color-ln-memorial-*) were not in `@dim/contract/tokens`
// yet, and this file invents no value. They are, now: only the five values
// this band actually needs crossed (see the token file's own note), not the
// whole rosa/memorial scale. The chip still carries the state as icon + text
// regardless, so nothing has ever rested on color alone (WCAG) — this closes
// a debt in the shared layer, not a real gap a reader could see.
//
// THIS CHROME OWNS THE BUTTON, NOT THE MOTION. The turn itself lives in
// `DocumentTurn.tsx` (React Native core `Animated`, never Reanimated — this
// repo lost a production build to the worklets runtime, see
// src/release/release-config.test.ts). What that split costs this file is one
// extra prop, and it is the web's split exactly: `face` is the face PAINTED on
// the sheet right now and names the button ("Dar vuelta" / "Girar a Libreta"),
// while `isLibretaActive` is the face the reader has REQUESTED and carries the
// toggle state. They disagree for the ~205ms the sheet spends turning, and
// during that gap the toggle is the honest one — the press registered, the
// document is on its way. `DocumentChrome.tsx` on the web threads the same two
// values into the same two places, for the same reason.

import type { OwnerPetSituationV1 } from "@dim/contract/api";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Defs, Line, LinearGradient, Rect, Stop } from "react-native-svg";

import { Icon } from "../ui/Icon";
import { FONTS } from "../ui/fonts";
import { COLORS, LABEL_TRACKING_EM, RADIUS, TOUCH_TARGET } from "../ui/theme";

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
 * Exported for `DocumentChromeNative.band-skin.test.ts`, which is the one
 * fence proving `prenada` and `fallecida` still resolve to their OWN skin and
 * not to the shared default — the situation this file's header explains was
 * true until T4-M6 closed it.
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

/** The pinstriped band background. The web's repeating-linear-gradient(135deg,
 *  rgba(255,255,255,.5) 0 1px, transparent 1px 11px) becomes diagonal SVG
 *  hairlines over the gradient — 11px period, measured perpendicular like the
 *  CSS does, so the x-step is 11/cos(45°) ≈ 15.5. */
function BandBackground({ situationKey }: { situationKey: string | undefined }) {
  const skin = bandSkin(situationKey);
  const lines: number[] = [];
  for (let x = 0; x <= BAND_VIEWBOX_W + BAND_H; x += 15.5) lines.push(x);
  return (
    <Svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${BAND_VIEWBOX_W} ${BAND_H}`}
      preserveAspectRatio="xMidYMid slice"
      style={StyleSheet.absoluteFill}
    >
      <Defs>
        {/* 118deg on the web — mostly horizontal, falling slightly. */}
        <LinearGradient id="band" x1="0" y1="0" x2="1" y2="0.35">
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
      {lines.map((x) => (
        <Line
          key={x}
          x1={x}
          y1={BAND_H + 10}
          x2={x + BAND_H + 10}
          y2={-10}
          stroke="rgba(255,255,255,0.5)"
          strokeWidth={1}
        />
      ))}
    </Svg>
  );
}

/**
 * Band height, and it is a LAYOUT BUDGET rather than a taste.
 *
 * Four things share this strip and three of them are absolutely positioned, so
 * the number has to be derived rather than picked. Every row below is
 * band-relative y on a 360dp card, measured from the face's content box (inside
 * the 1px border), with IBM Plex Mono at its shipped 1.30em line height, AT THE
 * DEVICE'S UNSCALED FONT (system font scale 1.0 — see the A-2 note below for
 * why the scaled case needs its own row):
 *
 * THE TITLE IS "Libreta Sanitaria" NOW — 17 characters, "Nacional" dropped by
 * the PO on 2026-09-24 (it read as State issuance; see the render call
 * below). THE ROW BELOW STILL SIZES THE BUDGET AGAINST THE OLD 26-char
 * "Libreta Sanitaria Nacional" ON PURPOSE: that was the WORST CASE the 2-line
 * wrap and the whole clearance budget were derived from, and 17 characters
 * can only need LESS width and wrap LESS, never more. The budget stays where
 * it is rather than being re-derived tighter from a title the PO could still
 * shorten again — a shorter title only helps, so there is nothing to buy by
 * chasing it.
 *
 *   | Element        | Derivation                                        | y       |
 *   |----------------|---------------------------------------------------|---------|
 *   | Title block    | top 16; sized against the OLD 26-char "…Nacional"  | [16,~56]|
 *   |                | title, which needs 218pt at 55% of 310 = 170       |         |
 *   |                | available and so WRAPS: 2 × 13.0 lines + 3         |         |
 *   |                | marginTop + the 10.4 subtitle line. The CURRENT    |         |
 *   |                | 17-char title fits in less and is not the binding  |         |
 *   |                | case — see the paragraph above.                    |         |
 *   | Flip control   | top 14; a TOUCH_TARGET square (48 since A-1)       | [14,62] |
 *   | Situation chip | top BAND_CHIP_TOP; 2×1 border + 2×6 padding +      | [72,102]|
 *   |                | max(icon 16, text 13) — the 16px ICON_SM is the    |         |
 *   |                | tallest child at THIS scale, NOT the 10px text     |         |
 *   | Frames enter   | BAND_H + FACE_SECTION_PAD_V − IDENTITY_POKE_OUT    | 116     |
 *
 * So the clearance between the chip's bottom and the frames' white ring is
 * `BAND_H + 20 − 56 − 102` = 14 points at BAND_H 152 — 6 points ABOVE the
 * geometry test's 8-point floor (`MIN_CLEARANCE`), not AT it: the floor is
 * the minimum the test accepts, the 14 is what this budget actually leaves.
 * The floor is exactly what it was before this pass; only the margin above
 * it changed, because raising `BAND_CHIP_TOP` for A-2 (below) pushed the chip
 * 10 points lower and `BAND_H` had to rise to keep the frames' entry point
 * 10 points below it too.
 *
 * WHAT THE PREVIOUS VERSION OF THIS DOCBLOCK GOT WRONG, because the numbers it
 * quoted are still quoted elsewhere in this repo. It said the title ended at
 * 42, the chip at 87, the frames entered at 96, and that the clearance was 9 —
 * and every one of those was off for one of two reasons. It omitted
 * `FaceSection`'s own paddingVertical, so the frames were placed 20 points
 * higher than they are; and it took the chip's 10px TEXT as the tallest child
 * when the 16px icon beside it is taller, so the chip measured 25 instead of
 * 30. The two errors happened to cancel into a plausible-looking 9. At the old
 * BAND_H of 152 the real clearance was 24, not 9 — the layout was SAFER than
 * its own justification claimed, which is exactly as dangerous, because the
 * next person to move a constant would have been trusting arithmetic that did
 * not describe the layout.
 *
 * HISTORY. It was 120 until 2026-09-03, with the chip at top:82: that put the
 * frames at 84 while the chip ran [82,112], so 28 of the chip's 30 points were
 * under the photo — the occlusion described at the chip. Raising it to 152
 * fixed that and left 24 points of unplanned slack; 136 was the same fix with
 * the slack spent, keeping the 8-point clearance the geometry test pinned.
 *
 * A-2 (2026-09-24, M7 accessibility pass, PO decision 17A). The table above —
 * and the geometry test that mirrored it — was arithmetic for the UNSCALED
 * title only. It never asked what happens at the font-scale CAP this file
 * already imposes (`BAND_MAX_FONT_SCALE`, 1.3): at that cap the title's own
 * fontSize is 10 × 1.3 = 13, its line height ~1.3 × 13 ≈ 17 (not the unscaled
 * 13), and the chip's text — capped the same way — grows past `ICON_SM` (16)
 * to ~17 as well, so the chip's OWN tallest child changes at that scale too.
 * Recomputed at the cap: the title's two lines + margin + subtitle end at
 * `16 + 2×17 + 3 + 14` = 67, and the chip (tallest child 17 now, not 16) runs
 * `[BAND_CHIP_TOP, BAND_CHIP_TOP + 2×1 + 2×6 + 17]`. The OLD `BAND_CHIP_TOP`
 * of 62 was measured to clear only the UNSCALED title (ends at 56) — 6 points
 * of margin that the SCALED title (ends at 67) ate entirely and then some: the
 * title overran the chip's own line by 5 points at scale 1.3, which is what a
 * reader on a Samsung J7 at system font "Grande" actually saw. Compounding it,
 * A-1's `TOUCH_TARGET` move (44 → 48) pushed the flip control's own bottom
 * edge from 58 to 62 — no longer clear of the old chip top at all. Both fixed
 * the same way this file has fixed the class before: `BAND_CHIP_TOP` moved to
 * 72 (5 points clear of the scaled title's 67, 10 clear of the flip control's
 * 62) and `BAND_H` moved back to 152 to keep the frame clearance ABOVE its
 * unchanged 8-point floor (`MIN_CLEARANCE` in the geometry test) once the
 * chip sits 10 points lower — the floor itself never moved, `BAND_H` rose by
 * the same 10 points the chip did, which is why the margin above the floor
 * (14 unscaled, 13 at the cap — see the table above) reads close to what it
 * was before rather than shrinking. The title's own font-scale
 * CAP stays exactly where it was — a letterhead is allowed to stop growing;
 * see `BAND_MAX_FONT_SCALE`'s own docblock for why. What changed is that this
 * budget now accounts for the scale IT ITSELF ALLOWS, up to that cap, instead
 * of pretending every reader is at 1.0.
 * `DocumentChromeNative.geometry.test.ts` computes both the unscaled and the
 * capped-scale case from these exported constants.
 *
 * Anything that lowers this constant, deepens the poke-out, moves the chip or
 * changes the section padding has to redo this arithmetic — and does not have
 * to redo it by hand: `DocumentChromeNative.geometry.test.ts` computes it from
 * the exported constants and fails when either clearance goes under budget.
 */
export const BAND_H = 152;

/**
 * The one place in this app that caps text scaling, and why it is this one.
 *
 * DECISION 17A — MEMBRETE (PO): this cap is a letterhead, not body copy, and
 * it stays. A credential's engraved wordmark does not grow past a fixed point
 * just because the reader's system font does — a printed document has the
 * same constraint for the same reason. This docblock is about the cap ITSELF,
 * which A-2 (below) leaves untouched; A-2 fixed a LAYOUT bug the cap exposed,
 * not the cap.
 *
 * B-06 / A6-cuenta-resiliencia-15, MEASURED on the shipped build 10 at the
 * system font size "Máximo" (scale 1.5, shot 146 vs 142): "LIBRETA SANITARIA
 * NACIONAL" wrapped to three lines inside a `maxWidth: 55%` box positioned
 * absolutely at top 16, ran past the band's fixed `height: BAND_H`, and cut
 * "CREDENCIAL · FRENTE" in half. The chip's label overprinted at the same
 * scale.
 *
 * NOT ACTUALLY "clean at 1.3", which is what this line claimed until A-2
 * (2026-09-24). The three-line overrun this cap exists to stop was gone at
 * 1.3 — but the cap only bounds how far the TITLE can grow; it says nothing
 * about whether the band's OTHER absolutely-positioned children (the chip)
 * left it room, and at the cap they did not: `BAND_H`'s own docblock has the
 * arithmetic for the 5-point overlap this measured. The cap was doing its one
 * job correctly the whole time — the budget around it was the part that had
 * not caught up.
 *
 * WHY A CAP AND NOT A CONTENT-DRIVEN HEIGHT. `BAND_H` is not a spacing
 * preference — it is one term in a published budget (the identity frames' -56
 * poke-out, `FACE_SECTION_PAD_V`, `BAND_CHIP_TOP`) that
 * `DocumentChromeNative.geometry.test.ts` recomputes and fences. A
 * `minHeight` here would move the band's floor at runtime and every one of
 * those absolute positions with it, silently, per device.
 *
 * WHY IT IS DEFENSIBLE HERE AND NOWHERE ELSE. These three are 8-10pt uppercase
 * mono CHROME — the engraved wordmark on a document, not its content. The
 * animal's name, the sections, the libreta's rows and every sentence the person
 * reads still scale without a ceiling. A printed credential has the same
 * constraint for the same reason.
 */
export const BAND_MAX_FONT_SCALE = 1.3;

/** How far the identity frames rise into the band. See BAND_H. */
export const IDENTITY_POKE_OUT = 56;

/** `FaceSection`'s vertical padding — the frames' first parent, and the term
 *  the old band arithmetic omitted. See BAND_H. */
export const FACE_SECTION_PAD_V = 20;

/** The situation chip's own line in the band. See BAND_H — raised 62 → 72 by
 *  A-2 to clear the title at the `BAND_MAX_FONT_SCALE` cap, not just unscaled. */
export const BAND_CHIP_TOP = 72;
export const BAND_CHIP_PAD_V = 6;
export const BAND_CHIP_BORDER = 1;

/** `Icon size="sm"` in points — the chip's tallest child. Mirrors the `sm`
 *  branch of `resolveSize` in ../ui/Icon.tsx. */
export const ICON_SM = 16;

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
  children: ReactNode;
};

export function DocumentChromeNative({
  face,
  isLibretaActive,
  onTurn,
  situation,
  children,
}: DocumentChromeNativeProps) {
  const isCredencial = face === "credencial";
  const bandSubtitle = isCredencial ? "Credencial · frente" : "Libreta · dorso";
  // The accessible name always names the TARGET face — the web's exact wording.
  const turnAria = isCredencial ? "Girar a Libreta" : "Girar a Credencial";
  const skin = bandSkin(situation?.key);

  return (
    <View style={[styles.face, { borderColor: skin.border }]}>
      <View style={styles.band}>
        <BandBackground situationKey={situation?.key} />
        <View style={styles.bandTitle} accessibilityElementsHidden importantForAccessibility="no">
          <Text maxFontSizeMultiplier={BAND_MAX_FONT_SCALE} style={styles.bandTitleText}>
            Libreta Sanitaria
          </Text>
          <Text maxFontSizeMultiplier={BAND_MAX_FONT_SCALE} style={styles.bandSubtitleText}>
            {bandSubtitle}
          </Text>
        </View>
        {/* State chip — icon + label, never color alone. OUTSIDE the hidden
            title wrapper: on the back face this chip is the only textual
            carrier of the state, so it must stay accessible text.

            IT HAS ITS OWN LINE IN THE BAND, and that is a fix, not a
            preference. Until 2026-09-03 it sat at top:82 centred, inside the
            vertical range the identity photo occupies once its -56 margin
            pulls it up over the band. The photo lives in `body` (zIndex 2) and
            the chip in `band` (no zIndex), so the parent stacking context
            decides and the chip's own zIndex:4 never mattered: the photo
            painted over it. On a 360dp device the photo held x∈[18,102] and
            every label longer than about eight characters reached under it —
            "En tratamiento", "Bajo custodia oficial", "En adopción", "En
            observación antirrábica". The credential's single most important
            signal was partially hidden for most of its own vocabulary, and it took a
            geometry read to see it because the SHORT label ("Perdida") clears
            by a few pixels and is the one anybody tests with. */}
        {situation === null ? null : (
          <View style={styles.bandChip}>
            <Icon name={situation.icon} size="sm" color={COLORS.onDark} />
            <Text
              maxFontSizeMultiplier={BAND_MAX_FONT_SCALE}
              style={styles.bandChipText}
              numberOfLines={1}
            >
              {situation.label}
            </Text>
          </View>
        )}
        {/* The single flip control. `selected` carries the toggle state the
            web expresses with aria-pressed — off the REQUESTED face, so it
            answers the press immediately instead of waiting out the turn. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={turnAria}
          accessibilityState={{ selected: isLibretaActive }}
          onPress={onTurn}
          style={styles.turn}
        >
          {/* ICON ONLY since 2026-09-03. Three names for one control was two
              too many: the visible text said "Dar vuelta" then "Ver
              credencial", while the accessible name said "Girar a Libreta" —
              and the web calls it Girar. The accessible name is the one that
              survives, because it names the TARGET face and is what a screen
              reader announces; the visible text was the least precise of the
              three and the one competing with a title, a subtitle and the
              state chip inside the band's height budget. */}
          <Icon name="girar" size="sm" color={COLORS.onDark} />
        </Pressable>
      </View>

      <View style={styles.body}>{children}</View>

      {/* Certificate inner hairline — last so it paints over the body edge;
          pointerEvents none so it never eats a tap. */}
      <View pointerEvents="none" style={styles.frame} />
    </View>
  );
}

/**
 * A labeled hairline divider — the web's `.ln-divider` + `.ln-divider-label`.
 * Exported from here because it is document chrome: both faces bind their
 * sections with it so the sheet reads as one credential, not a stack of cards.
 */
export function FaceDivider({ icon, label }: { icon?: string; label?: string }) {
  if (label === undefined) return <View style={styles.divider} />;
  return (
    <View style={styles.divider}>
      <View style={styles.dividerLabel}>
        {icon === undefined ? null : <Icon name={icon} size="sm" color={COLORS.inkFaint} />}
        <Text style={styles.dividerLabelText}>{label}</Text>
      </View>
    </View>
  );
}

/** The web's `.ln-sec` at the phone layout: 20px vertical, 18px horizontal. */
export function FaceSection({ children }: { children: ReactNode }) {
  return <View style={styles.sec}>{children}</View>;
}

const styles = StyleSheet.create({
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
  band: {
    height: BAND_H,
    overflow: "hidden",
  },
  bandTitle: {
    position: "absolute",
    left: 22,
    top: 16,
    maxWidth: "55%",
  },
  bandTitleText: {
    fontFamily: FONTS.monoSemibold,
    fontSize: 10,
    letterSpacing: 10 * 0.24,
    textTransform: "uppercase",
    color: "rgba(255,255,255,0.9)",
  },
  bandSubtitleText: {
    fontFamily: FONTS.mono,
    fontSize: 8,
    letterSpacing: 8 * 0.16,
    textTransform: "uppercase",
    color: "rgba(255,255,255,0.6)",
    marginTop: 3,
  },
  bandChip: {
    position: "absolute",
    // Its own line: below the wrapped title (ends ~55) and the flip control
    // (ends 58), above the identity poke-out (enters at BAND_H + 20 − 56 =
    // 100). See BAND_H for the whole budget and where each number comes from.
    top: BAND_CHIP_TOP,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    // Nothing else occupies this line, so the longest label in the vocabulary
    // ("En observación antirrábica") gets the width it needs instead of being
    // truncated by a cap that existed to dodge the photo.
    maxWidth: "88%",
    paddingHorizontal: 12,
    paddingVertical: BAND_CHIP_PAD_V,
    borderRadius: RADIUS.button,
    backgroundColor: "rgba(0,0,0,0.22)",
    borderWidth: BAND_CHIP_BORDER,
    borderColor: "rgba(255,255,255,0.38)",
    zIndex: 4,
  },
  bandChipText: {
    fontFamily: FONTS.monoSemibold,
    fontSize: 10,
    letterSpacing: 10 * LABEL_TRACKING_EM,
    textTransform: "uppercase",
    color: COLORS.onDark,
  },
  /**
   * The flip control: a CENTRED SQUARE, since 2026-09-03.
   *
   * It was a pill built for a label — `flexDirection: "row"` with a `gap: 9`
   * between an icon and text, and asymmetric 13/16 horizontal padding to
   * balance that text optically. The label was removed the same day (see the
   * note at the control), which left the gap separating one child from
   * nothing, the padding off-centre by 3 points, and a 47-wide target for a
   * 16-point glyph. `TOUCH_TARGET` on both axes with the icon centred is what
   * the control has actually been since the text went: the height it already
   * had, and 48 rather than 47 across (44 before A-1 raised the floor), with
   * the glyph at exactly (24,24).
   */
  turn: {
    position: "absolute",
    right: 16,
    top: 14,
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: RADIUS.button,
    backgroundColor: "rgba(255,255,255,0.22)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.55)",
  },
  body: {
    zIndex: 2,
  },
  sec: {
    paddingVertical: FACE_SECTION_PAD_V,
    paddingHorizontal: 18,
  },
  divider: {
    borderTopWidth: 1,
    borderTopColor: COLORS.borderSoft,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 0,
  },
  dividerLabel: {
    position: "absolute",
    top: -8,
    left: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: COLORS.surface,
    paddingHorizontal: 10,
  },
  dividerLabelText: {
    fontFamily: FONTS.monoSemibold,
    fontSize: 10,
    letterSpacing: 10 * 0.18,
    textTransform: "uppercase",
    color: COLORS.inkMuted,
  },
});

/**
 * The chrome's StyleSheet, exported for the geometry fence.
 *
 * jest has no Yoga, so the band budget in `BAND_H`'s docblock can only be kept
 * honest by arithmetic over the real style objects —
 * `DocumentChromeNative.geometry.test.ts` reads the chip's top, padding and
 * border from HERE and compares them against the exported constants, so a
 * literal that drifts from the number the docblock quotes fails.
 */
export const documentChromeStyles = styles;
