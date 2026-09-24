// IBM Plex, loaded for React Native.
//
// WHY THE APP HAD NO BRAND TYPEFACE UNTIL NOW
// ---------------------------------------------------------------------------
// Nothing was broken; nothing had been done. The web renders IBM Plex Serif /
// Sans / Mono through next/font, which is a build-time mechanism with no
// equivalent on a phone: Metro does not inline `@font-face`, and React Native's
// `fontFamily` resolves against fonts REGISTERED with the runtime, not against
// a stack it can fall back through. Every `<Text>` in this app therefore drew
// in Roboto, and the two products did not look related.
//
// SIX FACES, AND THE COUNT IS A DECISION
// ---------------------------------------------------------------------------
// `@expo-google-fonts/*` ships each weight as its own module with its own
// `.ttf`, so importing `.../600SemiBold` pulls exactly that file into the
// bundle and leaves the other thirteen out. The subpath imports below are that
// choice made explicit — a bare `import { ... } from "@expo-google-fonts/
// ibm-plex-serif"` reads the same but hands Metro the barrel.
//
// WHICH six comes from `LN_FONT_WEIGHTS` in the contract, which explains each
// one. `fonts.test.ts` asserts this file registers exactly that set: declaring
// a weight nobody loads, or loading one nobody declared, is red.
//
// WHY `useFonts` AND NOT THE `expo-font` CONFIG PLUGIN
// ---------------------------------------------------------------------------
// `expo install` printed a note asking for `plugins: ["expo-font"]` in the
// Expo config. That plugin EMBEDS font files into a native build at prebuild
// time, which is a different mechanism with a different cost: it needs a
// native rebuild to change a face, and it does nothing for Expo Go — which is
// how the PO runs this app today. `useFonts` loads them at runtime from the
// bundle and works in both. When this app moves to a Play-signed build the
// plugin becomes worth revisiting for the first-paint cost; today it would buy
// nothing and break the emulator loop.

import { IBMPlexMono_400Regular } from "@expo-google-fonts/ibm-plex-mono/400Regular";
import { IBMPlexMono_600SemiBold } from "@expo-google-fonts/ibm-plex-mono/600SemiBold";
import { IBMPlexSans_400Regular } from "@expo-google-fonts/ibm-plex-sans/400Regular";
import { IBMPlexSans_500Medium } from "@expo-google-fonts/ibm-plex-sans/500Medium";
import { IBMPlexSans_600SemiBold } from "@expo-google-fonts/ibm-plex-sans/600SemiBold";
import { IBMPlexSerif_600SemiBold } from "@expo-google-fonts/ibm-plex-serif/600SemiBold";
import { useFonts } from "expo-font";

/**
 * The registry handed to `useFonts`: the name a `StyleSheet` will ask for,
 * mapped to the asset that answers.
 *
 * The keys are the packages' own constant names, written out rather than
 * derived from `LN_FONT_FAMILY`. Deriving them would LOOK tighter and would be
 * a lie: a contract rename would silently register "SourceSerif_600SemiBold"
 * pointing at IBM Plex bytes. `fonts.test.ts` ties the two ends honestly
 * instead, by asserting every key here starts with the contract's family name.
 */
export const LN_FONT_ASSETS = {
  IBMPlexSerif_600SemiBold,
  IBMPlexSans_400Regular,
  IBMPlexSans_500Medium,
  IBMPlexSans_600SemiBold,
  IBMPlexMono_400Regular,
  IBMPlexMono_600SemiBold,
} as const;

/**
 * The family names by role and weight — what every `StyleSheet` in this app
 * points `fontFamily` at.
 *
 * React Native has no synthetic weights on Android: `fontWeight: "600"` over a
 * family that only registered its Regular face renders Regular, silently. So
 * weight is part of the FAMILY here and `fontWeight` is never set alongside it.
 * That is not a style preference; it is the difference between a bold label and
 * a label that looks bold on the reviewer's iPhone and normal on the PO's
 * emulator.
 */
export const FONTS = {
  /** Display. Titles, pet names. */
  serif: "IBMPlexSerif_600SemiBold",
  /** Body copy. */
  sans: "IBMPlexSans_400Regular",
  /** The primary CTA's label — the web's `font-medium`. */
  sansMedium: "IBMPlexSans_500Medium",
  /** Emphasis inside body: values, names, chips. */
  sansSemibold: "IBMPlexSans_600SemiBold",
  /** Hints, codes, the public token. */
  mono: "IBMPlexMono_400Regular",
  /** The uppercase letterspaced field label. */
  monoSemibold: "IBMPlexMono_600SemiBold",
} as const;

export type LnFontName = (typeof FONTS)[keyof typeof FONTS];

/**
 * Load the six faces. Returns `true` once they are ready.
 *
 * The caller must hold the first paint until it is (see `_layout.tsx`): text
 * laid out in Roboto and then re-laid-out in Plex is a visible reflow of the
 * whole screen, and the fix is not to hide the flash but not to draw twice.
 */
export function useLnFonts(): boolean {
  const [loaded, error] = useFonts(LN_FONT_ASSETS);
  // A font that failed to load is not a reason to hold the app hostage: every
  // style names a family the runtime will simply not find, and React Native
  // falls back to the system face. That is an ugly app, not a broken one, and
  // an app that never opens IS broken. So a failure releases the gate.
  return loaded || error !== null;
}
