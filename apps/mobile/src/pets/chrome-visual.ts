// Chrome visual tuning — ONE place for the next agent (or a device pass) to
// nudge the credential paper without hunting through StyleSheets.
//
// HOW TO USE
// ----------
// 1. Change a number here.
// 2. Re-run the geometry / band-skin / PetDocumentScreen jest suites under
//    apps/mobile (they import these constants where the recipe is fenced).
// 3. Install a preview and check on a mid-range phone AND a low-DPI one (J7):
//    cheap panels wash out low-opacity ink; do not "fix" by cranking opacity
//    until a flagship looks muddy.
//
// WHAT LIVES HERE vs WHAT STAYS IN DocumentChromeNative
// -----------------------------------------------------
// · HERE: opacity / position / size / elevation knobs that a PO can ask to
//   "subí un poco" / "bajá la escarapela" without redesigning the sheet.
// · DocumentChromeNative: structure (band recipe, mark path, FaceDivider,
//   LatentBrand dual-text). Do not move layout arithmetic here.
//
// WEB PARITY ANCHORS (app/globals.css)
// ------------------------------------
// · `.pc-cred` paper tile 180×112, escarapela opacity 0.28 at 50% / 42%
// · `.pc-photo-mount` phone 116×116; desktop 156×156
// · Situation chip / face border tints per `data-situation`

/** Raster of public/landing-passport-paper.svg (512px RGBA tile). */
export const PAPER_TEXTURE = require("../../assets/landing-passport-paper.png");

/** Raster of public/landing-escarapela.svg (512px palette PNG). */
export const ESCARAPELA_TEXTURE = require("../../assets/landing-escarapela.png");

/**
 * Paper grain. Web tiles at 180×112; RN Image does not CSS-tile, so we stretch
 * a 512 tile across the sheet. On a J7 the grain is almost invisible — leave
 * it ON and tune on a better phone; lower opacity before raising it.
 */
export const PAPER = {
  /** 0 = off, 1 = full. Web reads the SVG at native ink strength over card. */
  opacity: 0.55,
} as const;

/**
 * Escarapela watermark on the paper (NOT on the navy band — the band paints
 * over it, as on the web). Web: opacity 0.28, position 50% 42%, size 100% auto.
 *
 * The two % knobs are turned into NUMBERS by `faceWatermarkGeometry` in
 * DocumentChromeNative, from the face's measured box. They never reach a style
 * as a % string: a %-height absolute Image of the escarapela grew the card to
 * ~window height on Android (mimar AVD, 2026-10-05).
 */
export const ESCARAPELA = {
  opacity: 0.28,
  /** Top of the watermark box, as a % of the card height. */
  topPct: 18,
  /** Height of the watermark box, as a % of the card height. */
  heightPct: 70,
} as const;

/**
 * Soft lift under the whole credential. Android uses `elevation`; iOS uses
 * the shadow* fields. Keep ONE light layer — Exynos 7580 (J7) pays for each.
 */
export const CARD_LIFT = {
  elevation: 3,
  shadowOpacity: 0.14,
  shadowRadius: 8,
  shadowOffsetY: 3,
} as const;

/**
 * Photo mount — the only identity frame on the owner face (QR left the card;
 * Compartir / the public credential route owns the bright QR).
 * Web phone breakpoint: 116.
 */
export const PHOTO_MOUNT = {
  size: 116,
  /** White surface ring (web box-shadow ring). */
  ring: 4,
  /** Corner radius of the mount. */
  radius: 14,
  /** Soft drop under the photo — iOS only; Android gets no nested elevation
   *  inside the rotating card (one light layer: `CARD_LIFT`). */
  shadowOpacity: 0.2,
  shadowRadius: 5,
  shadowOffsetY: 2,
} as const;

/**
 * Latent "miMAR" engraving on the navy band. Dual Text approximates the web's
 * two-way text-shadow. Raise `inkOpacity` before moving `top` — on phone-width
 * cards a lower brand lands in washed celeste.
 */
export const LATENT_BRAND = {
  top: 34,
  fontSize: 15,
  letterSpacing: 5.1,
  inkOpacity: 0.72,
  hiOpacity: 0.5,
} as const;

/** Sunk mark in the band head — dual Path (ink + hi edge). */
export const MIMAR_MARK = {
  inkOpacity: 0.62,
  hiOpacity: 0.35,
  hiTranslate: 0.6,
} as const;
