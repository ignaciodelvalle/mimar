// Generates BOTH clients' identity images — the Expo client's launcher,
// adaptive and splash images, the Play Store's feature graphic, and the web's
// three PWA icons — from the ONE brand mark this project has.
//
// Run with: pnpm mobile:icons
//
// THE FILE NAME IS NOW NARROWER THAN THE SCRIPT. It was written when the only
// outputs were the phone's; the web icons joined on 2026-09-04 precisely so
// there would stop being two marks. Renaming it ripples into package.json, the
// conventions canon, docs/architecture/facts.json and several handoffs, which is
// not this cycle's work — so the scope is stated here instead of in the name.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A SCRIPT AND NOT SEVEN HAND-DRAWN FILES
// ---------------------------------------------------------------------------
// The mark already exists, once, as a vector: `public/logo-mimar-mark.svg`.
// Every surface that shows the brand — the icon on a phone's home screen, the
// icon an installed PWA gets, the Android adaptive layer, the splash, the Play
// listing — must be THAT picture and not a second one, because two marks is a
// brand problem no amount of tooling fixes later.
//
// So nothing here is drawn. Everything is COMPOSED, from one source, by a
// recipe that is readable and re-runnable. What would otherwise be seven opaque
// binaries "somebody made in Figma once" is instead seven binaries whose
// provenance is fifty lines of arithmetic.
//
// The outputs ARE committed. EAS Build and CI both run `pnpm install
// --frozen-lockfile` and then read the config; neither runs this script, and a
// build that regenerated its own icons would be a build whose icons depend on
// which version of sharp the runner resolved. Next.js serves `public/icons/*`
// as static bytes for the same reason. Committed pixels; reproducible recipe.
// Re-run it when the mark changes, and only then.
//
// ---------------------------------------------------------------------------
// THE SOURCE
// ---------------------------------------------------------------------------
// `public/logo-mimar-mark.svg` — a QR finder pattern with CHAMFERED corners
// holding a paw, on a 100x100 viewBox with the plaque painted from 5 to 95 on
// both axes (90x90 units, square). The SVG's own comments carry the design
// argument; what matters to this script is the geometry and the colour:
//
//   · the plaque is SQUARE (90x90), so every output below is square-ink;
//   · the frame stroke is 14 units — 15.56% of the ink width — which is what
//     the launcher ratio below is chosen against;
//   · the corners are cut at 45 degrees, so the octagon's circumradius is 51 of
//     the 100-unit viewBox: maxRadius / inkWidth = 51/90 = 0.5667. That single
//     number is what makes a CIRCULAR mask assertion possible at all (see
//     release-config.test.ts) — a bounding box cannot answer it;
//   · the mark is `currentColor` throughout, with `style="color:#0E5A99"` on
//     the root. It is BLUE, not black — see "WHY THE MARK IS NOT RECOLOURED";
//   · the inner octagon is a genuine `evenodd` KNOCKOUT — a hole, transparent,
//     showing whatever sits behind it — and the paw inside that window is a
//     SOLID BLUE POSITIVE FILL, not a second knockout.
//
// The last point is why the recipes below divide into two postures: an output
// with `ground: PAPER` fills the window with Libreta Nacional paper; one with
// `ground: null` leaves it transparent for the OS to fill.
//
// ---------------------------------------------------------------------------
// THE TRIM, AND THE ONE RULE BEHIND IT
// ---------------------------------------------------------------------------
// Every ratio below is an INK measurement — how much of the canvas the ARTWORK
// covers, not how wide a rectangle containing it is — which is why the source is
// trimmed before anything else happens to it. Getting the mechanism behind that
// sentence right took THREE authors on the previous, raster source, so the rule
// is kept even though its worked example has been replaced.
//
// ONE RULE, NOT TWO: default `trim()` trims against the TOP-LEFT PIXEL — its
// colour and its alpha together — at a default threshold of 10. It is not an
// alpha trim that happens to work on transparent images; alpha is just one of
// the channels it compares. Two earlier authors each proposed a plausible
// mechanism ("sharp trims transparency", then "sharp trims alpha when an alpha
// channel is present, so you must pass `background: '#FBFAF5'`") and each
// checked it only against the file where it happened to predict the right
// answer. The lesson survives them; their numbers do not.
//
// MEASURED ON TODAY'S SOURCE, sharp 0.34.5 / libvips 8.17.3:
//
//   sharp(SOURCE, { density: 1536 })                   → 2133x2133, top-left (0,0,0,0)
//   sharp(SOURCE, { density: 1536 }).trim({threshold:10}) → 1921x1921
//
// — a symmetric 106px margin removed on every side, which is exactly the
// viewBox's 5-unit border rendered at this density. The top-left pixel is
// transparent, so the default background is what the trim wants and passing the
// icons' cream `#FBFAF5` here would return the untrimmed canvas.
//
// A sharp trap worth naming for the next person who measures this: `.trim()
// .metadata()` does NOT report the trimmed size — `metadata()` reads the source
// header. Materialise with `.toBuffer({ resolveWithObject: true })` (or
// `toFile`) before measuring anything.
//
// ---------------------------------------------------------------------------
// THE RATIOS ARE CHOSEN, AND HERE IS WHY
// ---------------------------------------------------------------------------
// They used to be MEASURED off the shipped PWA icons — 393/512 and 294/512 —
// back when those icons were the only place the old mark lived at a known size.
// That inheritance is over: the PWA icons are now OUTPUTS of this script, so
// quoting them would be the script measuring itself. Each ratio below is a
// decision with an argument.
//
// RATIO_LAUNCHER = 0.68. The mark is a square plaque with a 15.56% frame
// stroke, and the paper margin around it reads as a SECOND concentric band. At
// the old 0.768 the margin was 119px against a 122px stroke — margin/stroke =
// 0.97, two rings of identical weight, which is a picture of a frame inside a
// frame rather than a plaque on paper. Requiring the margin to be at least 1.5
// stroke-widths:
//
//     (1024 - W)/2  >=  1.5 * 0.1556 * W     →     W <= 698
//
// which is 0.6817 of the canvas, rounded to 0.68 (696px, margin 164px, stroke
// 108px, margin/stroke = 1.51). iOS's mask is NOT the binding constraint and
// was checked rather than assumed: at 0.768 the superellipse still cleared the
// plaque's flat-edge midpoints by 119px and its chamfers by ~204px.
//
// RATIO_MASKABLE = 0.53. This one answers to Android, in dp on a 108dp layer.
// Only the centre 72dp is GUARANTEED to survive every OEM mask, and Google
// additionally RECOMMENDS keeping content inside a 66dp keyline. Both are
// diameters of CIRCLES, so what has to fit is the mark's circumradius —
// 0.5667 x ink width, from the chamfer geometry above:
//
//     0.53 x 1024 = 543px ink  →  circumradius 32.45dp of 108
//         · 3.55dp inside the 72dp guaranteed mask (36dp radius)
//         · 0.55dp inside the 66dp content keyline (33dp radius)
//
// The old 0.574 put it at 0.86dp inside the mask and 2.14dp OUTSIDE the
// keyline — passing the guarantee, failing the recommendation, with less than a
// dp of air.
//
// RATIO_FEATURE = 0.55, by HEIGHT, on Play's 1024x500 canvas. This is the one
// output whose real answer is a DESIGNED LOCKUP — the plaque beside the
// wordmark, laid out by a person — and that is a pending product item, not
// something a compositing script can invent. Until it exists this is a lone
// plaque centred on paper, and the honest choice is to make it read as a
// deliberate emblem rather than as a cropped icon: at the old 0.768 the mark
// filled 384 of 500 vertically (11.6% of margin above and below) while 62.5% of
// the canvas width sat empty beside it, which looks like an accident. At 0.55
// (275px) the margins are 22.5% vertically and the emptiness reads as intended
// space waiting for the wordmark.
//
// SPLASH_PX is not a ratio at all. `expo-splash-screen` renders the file at
// `imageWidth` dp, and the densest Android bucket (xxxhdpi) is 4x — so a 200dp
// declaration needs 800 physical pixels or the OS upscales. It is read from
// app.json below rather than restated, so the two cannot drift.
//
// EVERY OUTPUT IS A DOWNSCALE from the 1921px trimmed master — icon 696px
// (0.36x), adaptive/maskable 543px (0.28x), splash 800px (0.42x), feature 275px
// (0.14x), web 348px (0.18x) and 131px (0.07x). Nothing here is interpolated
// UP any more. The previous mark was a 610px-wide photographic scan and the
// launcher icon was a 1.29x upscale of it, i.e. roughly a quarter of its pixels
// were Lanczos invention on a subject made of fine parallel lines. That whole
// problem left with the raster source.
//
// ---------------------------------------------------------------------------
// WHY THERE IS NO adaptive-icon-background.png
// ---------------------------------------------------------------------------
// Android's adaptive icon takes two layers, and this script emits one. The
// background is declared in app.json as `adaptiveIcon.backgroundColor:
// "#fbfaf5"` — a flat paper fill — and that is a decision, not a shortcut.
//
// A background PNG buys exactly one thing: art that is not a flat colour. This
// brand's ground IS a flat colour; the identity is the mark, and every surface
// in both clients sits on `--color-ln-paper`. So the PNG would carry no
// information a hex string does not, and would cost three things that are not
// hypothetical:
//
//   1. A second file to keep in sync with the token when the paper ever moves.
//      A hex string in app.json is greppable and sits next to the foreground
//      it pairs with; a PNG's colour is invisible until somebody opens it.
//   2. Banding. Android scales and masks the background layer per launcher, and
//      a flat fill delivered as 8-bit PNG through that pipeline can band where
//      a declared colour cannot — the OS fills it exactly.
//   3. Weight in every APK, for a rectangle.
//
// The moment the background stops being a flat colour, it becomes a PNG and it
// becomes another recipe below. Until then, the colour is the honest form.
//
// ---------------------------------------------------------------------------
// WHY THERE IS NO DARK SPLASH
// ---------------------------------------------------------------------------
// `expo-splash-screen` takes a `dark` variant. This app declares none, and that
// matches the product rather than skipping work: the design system is
// light-only by decision — `app/globals.css` disables dark mode outright and
// `pnpm lint:tokens` fails the build on any `dark:` prefix. The credential is a
// paper document; it does not have a night mode on the web and must not acquire
// one on the phone, least of all on the first screen a user sees.
//
// (`userInterfaceStyle` in app.json is pinned to "light" for exactly this
// reason (2026-09-03) — it no longer disagrees with the above.)
//
// ---------------------------------------------------------------------------
// WHY THE MARK IS NOT RECOLOURED
// ---------------------------------------------------------------------------
// Because it already carries its colour, and this script has no opinion to add.
// The SVG paints everything with `currentColor` and sets `color:#0E5A99` on the
// root element, so the mark arrives BLUE — the brand blue, the same
// `--color-ln-azul` the web chrome and `manifest.ts`'s `theme_color` use.
//
// Recolouring it is therefore a ONE-ATTRIBUTE EDIT to one SVG, upstream of
// here, and that is where it belongs. Doing it in this file would make the
// script a second opinion about the brand — the exact failure
// `apps/mobile/src/ui/theme.ts` was rewritten to stop committing.
//
// What this script DOES decide is what shows through the knockout. The inner
// octagon is a hole; the paw inside it is a solid blue positive fill, not a
// second hole. So an output with `ground: PAPER` reads as a blue plaque with a
// blue paw on cream, and one with `ground: null` hands that decision to
// whatever composites it — Android's background layer, or the splash's
// configured `backgroundColor`.

import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

// UNLIKE PAPER AND BRAND_BLUE BELOW, this one IS imported rather than
// restated. Those two are colour tokens with no cheap JS module to pull from
// (see PAPER's own doc comment: the workspace tokens package is not worth
// resolving for one hex string). BRANDING is a plain, dependency-free object
// in a sibling file, and branding.ts's own header already explains why a
// hardcoded copy of the brand strings is the mistake this repo just finished
// fixing: "a rebrand editing this line would have missed both places the
// mark is actually drawn." Hardcoding "miMAR" here would be that mistake a
// third time.
import { BRANDING } from "../lib/ui/branding";

/** Repo root, from `scripts/`. */
const ROOT = path.resolve(import.meta.dirname, "..");

/** The single home of the brand mark. */
const SOURCE = path.join(ROOT, "public", "logo-mimar-mark.svg");

/**
 * The rasterisation density, and it is NOT decoration — it is the whole reason
 * a vector source is worth having.
 *
 * sharp renders an SVG at its INTRINSIC size unless told otherwise, and this
 * mark declares `width="100" height="100"`. Feed it straight into the recipes
 * below and every output is a 100px render scaled UP to 1024 — blurrier than
 * the scanned PNG this replaced, which is the opposite of the point. At
 * 1536 DPI against libvips' 72 DPI baseline the master render is
 * 100 × 1536/72 ≈ 2133px, so every output below is a DOWNscale, which is where
 * raster quality comes from.
 *
 * Raise this if the canvas ever exceeds ~2000px. Do not lower it to save time:
 * the whole run is under two seconds.
 */
const RASTER_DENSITY = 1536;

/** Phone assets: the Expo client reads these by relative path from app.json. */
const MOBILE_OUT_DIR = path.join(ROOT, "apps", "mobile", "assets");

/** Web assets: Next.js serves `public/` verbatim, so these are `/icons/*.png`. */
const WEB_OUT_DIR = path.join(ROOT, "public", "icons");

/**
 * `--color-ln-paper`, restated as a literal.
 *
 * NOT imported from `@dim/contract/tokens`: this script runs under tsx from the
 * repo root, the token module is an ESM workspace package, and buying that
 * resolution for one hex string is not worth it.
 *
 * BE HONEST ABOUT WHAT GUARDS IT, WHICH IS NOT MUCH. `pnpm lint:token-parity`
 * fences `--color-ln-paper` between app/globals.css and the contract; it has
 * never heard of this file. `release-config.test.ts` asserts that app.json's
 * two `#fbfaf5` literals match each other, so the ground under the mark and the
 * adaptive background cannot diverge, and `__tests__/pwa-icons.test.ts` asserts
 * the same hex is the top-left pixel of all three web icons — but every one of
 * those literals could drift away from the token together and nothing would
 * notice.
 *
 * That is a small, contained risk (paper has not moved since the Libreta
 * Nacional handoff, and a wrong ground is visible on the first launch), and the
 * fix if it stops being small is a fence, not a comment. Do not read this
 * paragraph as saying the value is protected.
 */
export const PAPER = { r: 0xfb, g: 0xfa, b: 0xf5, alpha: 1 } as const;

/**
 * The mark's own colour, restated so tests can assert a pixel against it.
 *
 * Not a decision made here: it is `style="color:#0E5A99"` on the SVG's root
 * element, which every `currentColor` fill in the file inherits. Stated in
 * upper case because that is how the SVG spells it; PNG pixels carry no case.
 */
export const BRAND_BLUE = "#0E5A99";

/**
 * How much of a SQUARE canvas the plaque covers on a launcher-style icon.
 *
 * CHOSEN, not measured off anything — see "THE RATIOS ARE CHOSEN" in the
 * header. 0.68 is the largest ratio at which the paper margin is at least 1.5×
 * the plaque's own frame stroke, so the two do not read as concentric bands.
 */
export const RATIO_LAUNCHER = 0.68;

/**
 * How much of a MASKABLE canvas the plaque covers — Android's adaptive
 * foreground layer, and the web manifest's `purpose: "maskable"` icon.
 *
 * CHOSEN against Android's two circles: 0.53 puts the plaque's circumradius at
 * 32.45dp of a 108dp layer, inside both the 72dp guaranteed mask and the 66dp
 * content keyline. See the header for the full derivation.
 */
export const RATIO_MASKABLE = 0.53;

/**
 * How much of Play's 1024×500 feature graphic the plaque covers, BY HEIGHT.
 *
 * Deliberately modest: this canvas wants a designed lockup (plaque + wordmark)
 * that does not exist yet, and a lone plaque sized to fill the height reads as
 * a cropped icon rather than an emblem. See the header.
 */
export const RATIO_FEATURE = 0.55;

/** Store icon canvas. Non-negotiable: both stores want 1024×1024. */
const CANVAS = 1024;

/** The two sizes `app/manifest.ts` declares. 512 also serves the maskable icon. */
const WEB_ICON_LARGE = 512;
const WEB_ICON_SMALL = 192;

/**
 * Google Play's feature graphic. Also non-negotiable, and unlike the icon
 * canvas it is NOT square — 1024×500, the only LANDSCAPE output this script
 * produces. Play rejects anything else outright, PNG or JPEG, ≤15 MB.
 */
const FEATURE_GRAPHIC_WIDTH = 1024;
const FEATURE_GRAPHIC_HEIGHT = 500;

/**
 * `expo-splash-screen`'s declared `imageWidth`, in dp, READ FROM app.json.
 *
 * Read rather than restated because the two numbers are one decision: the file
 * this script writes and the width the plugin renders it at. A literal here
 * would be a second copy free to drift, and the drift is invisible — the splash
 * would simply be soft on the densest phones, which is exactly the class of
 * defect nobody files a bug about.
 *
 * It THROWS rather than defaulting if the plugin entry is gone: a splash sized
 * against a guess is worse than a script that refuses to run.
 */
function readSplashImageWidthDp(): number {
  const appJson = JSON.parse(
    readFileSync(path.join(ROOT, "apps", "mobile", "app.json"), "utf8"),
  ) as { expo?: { plugins?: readonly unknown[] } };
  for (const entry of appJson.expo?.plugins ?? []) {
    if (!Array.isArray(entry) || entry[0] !== "expo-splash-screen") continue;
    const options = entry[1] as { imageWidth?: unknown } | undefined;
    if (typeof options?.imageWidth === "number") return options.imageWidth;
  }
  throw new Error("apps/mobile/app.json declares no expo-splash-screen imageWidth");
}

/**
 * The splash image's width in PHYSICAL pixels.
 *
 * `imageWidth` is dp. xxxhdpi — the densest Android bucket in the wild, and
 * what every recent flagship reports — is 4×, so 200dp needs 800px or the OS
 * upscales the file it was handed. Before this was derived, the splash reused
 * the adaptive icon's 588px composition and was being blown up 1.36× on 4×
 * phones, on the very first screen of the app.
 */
export const SPLASH_PX = readSplashImageWidthDp() * 4;

type Recipe = {
  /** Directory the file is written to. Two clients, two trees. */
  readonly dir: string;
  readonly file: string;
  readonly what: string;
  /**
   * Canvas the mark is centred on, or `null` (both fields) to crop tight to
   * the mark. Two fields rather than one square number because the feature
   * graphic below is not square — width and height diverge for it.
   */
  readonly canvasWidth: number | null;
  readonly canvasHeight: number | null;
  /**
   * How the mark is resized onto that canvas: `sharp` derives the other axis
   * from the source aspect ratio either way, so this is just which axis is
   * the BINDING one. For the square outputs it is `width` — on a square canvas
   * either axis gives the same answer, so `width` was picked arbitrarily. It
   * stops being arbitrary for the feature graphic: 1024×500 is wide and short,
   * height (500) is the dimension that runs out first, and sizing off width
   * there would either overflow the canvas or require a second, undocumented
   * shrink to compensate.
   */
  readonly markSize: { readonly by: "width" | "height"; readonly px: number };
  /** `null` means a transparent ground. */
  readonly ground: typeof PAPER | null;
};

export const RECIPES: readonly Recipe[] = [
  {
    dir: MOBILE_OUT_DIR,
    file: "icon.png",
    what: "iOS app icon and the Android legacy/fallback launcher icon",
    canvasWidth: CANVAS,
    canvasHeight: CANVAS,
    markSize: { by: "width", px: Math.round(CANVAS * RATIO_LAUNCHER) },
    // OPAQUE, and this is a hard requirement rather than a preference: the App
    // Store rejects an icon with an alpha channel outright, and Android's
    // legacy launcher composites it over an unknown ground. Paper is also what
    // the knocked-out window needs behind it to read at all.
    ground: PAPER,
  },
  {
    dir: MOBILE_OUT_DIR,
    file: "adaptive-icon-foreground.png",
    what: "Android adaptive icon, foreground layer",
    canvasWidth: CANVAS,
    canvasHeight: CANVAS,
    markSize: { by: "width", px: Math.round(CANVAS * RATIO_MASKABLE) },
    // TRANSPARENT on purpose. The background layer is a flat paper fill
    // declared in app.json as `backgroundColor` — see the note there for why a
    // colour and not a second PNG.
    ground: null,
  },
  {
    dir: MOBILE_OUT_DIR,
    file: "splash-icon.png",
    what: "expo-splash-screen image",
    // Tight crop, no canvas. expo-splash-screen renders this at `imageWidth`
    // dp; padding baked into the file would just shrink the mark inside its own
    // declared width and force a compensating number in the config.
    canvasWidth: null,
    canvasHeight: null,
    // NOT a ratio of any canvas — there is no canvas. See SPLASH_PX.
    markSize: { by: "width", px: SPLASH_PX },
    ground: null,
  },
  {
    dir: MOBILE_OUT_DIR,
    file: "feature-graphic.png",
    what: "Google Play Store listing feature graphic",
    canvasWidth: FEATURE_GRAPHIC_WIDTH,
    canvasHeight: FEATURE_GRAPHIC_HEIGHT,
    // Sized BY HEIGHT (500px), the binding dimension of a 1024×500 rectangle:
    // 500 × 0.55 = 275px of mark, square, centred on paper. RATIO_FEATURE and
    // not RATIO_LAUNCHER because this canvas is not an icon and the plaque is
    // not the finished artwork for it — the wordmark lockup is a pending
    // product item. See the header for why filling the height was wrong.
    markSize: { by: "height", px: Math.round(FEATURE_GRAPHIC_HEIGHT * RATIO_FEATURE) },
    // OPAQUE. Play's feature graphic spec requires no alpha channel — same
    // requirement as icon.png above, different store. See the fence in
    // release-config.test.ts for why this one additionally cannot borrow the
    // adaptive icon's or splash's transparent posture: THIS asset is Play's,
    // and Play's rule, not this app's convention, governs it.
    ground: PAPER,
  },
  {
    dir: WEB_OUT_DIR,
    file: "icon-512.png",
    what: 'PWA manifest icon, purpose "any" — the installed web app\'s home-screen icon',
    canvasWidth: WEB_ICON_LARGE,
    canvasHeight: WEB_ICON_LARGE,
    markSize: { by: "width", px: Math.round(WEB_ICON_LARGE * RATIO_LAUNCHER) },
    // OPAQUE PAPER, same composition as the phone's icon.png at half the size.
    // That identity is the entire point of these three recipes existing: until
    // 2026-09-04 the web shipped the RETIRED fingerprint mark here while the
    // phone shipped the plaque, and nothing in the repo compared them.
    ground: PAPER,
  },
  {
    dir: WEB_OUT_DIR,
    file: "icon-192.png",
    what: "PWA manifest icon and the <link rel=icon> / apple-touch-icon in app/layout.tsx",
    canvasWidth: WEB_ICON_SMALL,
    canvasHeight: WEB_ICON_SMALL,
    markSize: { by: "width", px: Math.round(WEB_ICON_SMALL * RATIO_LAUNCHER) },
    ground: PAPER,
  },
  {
    dir: WEB_OUT_DIR,
    file: "icon-512-maskable.png",
    what: 'PWA manifest icon, purpose "maskable" — the browser masks this one itself',
    canvasWidth: WEB_ICON_LARGE,
    canvasHeight: WEB_ICON_LARGE,
    markSize: { by: "width", px: Math.round(WEB_ICON_LARGE * RATIO_MASKABLE) },
    // OPAQUE PAPER, unlike the phone's adaptive FOREGROUND which is
    // transparent — and the difference is real rather than an oversight. An
    // Android adaptive icon is TWO layers and the OS paints the background
    // itself from `adaptiveIcon.backgroundColor`; a maskable web icon is ONE
    // image the browser crops, with no second layer to supply a ground. So the
    // ground has to be in the file, and it is the same paper, which keeps the
    // two maskable surfaces one composition instead of two.
    ground: PAPER,
  },
];

// ---------------------------------------------------------------------------
// THE PLAY STORE LOCKUP — mark + wordmark, the "pending product item" above
// ---------------------------------------------------------------------------
// RATIO_FEATURE's own comment, on the `feature-graphic` recipe above, already
// names this: "a DESIGNED LOCKUP — the plaque beside the wordmark, laid out
// by a person — and that is a pending product item, not something a
// compositing script can invent." It now exists, as the function below.
//
// WHY IT IS NOT A Recipe. Every Recipe above is ONE mark, centred on ONE flat
// ground. This is three layers — a navy field, a rounded paper tile carrying
// the mark, and two lines of set type — which the shared loop's vocabulary
// (`markSize`, `ground`) has no way to say. Forcing it into that shape would
// either flatten the type until it described nothing, or grow fields only
// this one recipe would ever set. A dedicated function is the honest shape.
//
// WHY THIS DOES NOT REPLACE `assets/feature-graphic.png` ABOVE. That file is
// still the lone plaque RATIO_FEATURE describes, still written by the recipe
// loop, still asserted on by release-config.test.ts. Retargeting that recipe
// to this composition in the same change that adds it would delete a
// committed, tested file as a side effect of an "add" — the opposite of what
// was asked. So the two coexist for now: `assets/feature-graphic.png` (the
// placeholder) and `assets/store/feature-graphic.png` (this lockup, the one
// meant for the actual Play listing). Retiring the placeholder — and
// re-pointing whatever eventually uploads to Play at the new path — is a
// follow-up decision, not a side effect of this function existing.
//
// THE TILE'S CORNER RADIUS is measured, not invented. It is the SAME ratio
// the mark already wears on a rounded paper tile elsewhere in this product —
// the masthead brand slot, `components/layout/AppCitizenMasthead.tsx`:
// `h-[38px] w-[38px] rounded-[var(--radius-lg)]` with `--radius-lg: 8px`
// (app/globals.css). 8/38 is computed below rather than restated, so the two
// stay locked together if the masthead's tile ever resizes.
//
// THE TEXT IS RENDERED, THEN TRIMMED — not measured in advance. Two lines of
// SVG `<text>` are rasterised onto a canvas sized deliberately larger than
// either line could plausibly need, then `.trim()`'d to their own ink — the
// same technique `main()` already uses to turn the source mark's viewBox
// border into an ink measurement (see "THE TRIM, AND THE ONE RULE BEHIND IT"
// in the file header). Predicting glyph widths for "a system sans-serif"
// ahead of time is not knowable from this script: the font that actually
// renders depends on what the machine running `pnpm mobile:icons` has
// installed, and this repo runs that command on both the PO's Windows
// machine and Linux CI. Trimming after the fact is what makes the placement
// correct on either, and the safe-margin check below is what makes a bad
// substitution loud instead of silently shipping a clipped graphic.

/** The tile's own side, square, "~300px tall" per the brief. */
const LOCKUP_TILE_PX = 300;

/** How far the tile's left edge sits from the canvas edge. */
const LOCKUP_TILE_LEFT_PX = 90;

/**
 * The tile's corner radius, as a fraction of its own side — see "THE TILE'S
 * CORNER RADIUS" above. 8px of a 38px masthead tile.
 */
const LOCKUP_TILE_RADIUS_RATIO = 8 / 38;

/** Gap between the tile's right edge and the wordmark's left edge. */
const LOCKUP_TEXT_GAP_PX = 56;

/**
 * Minimum clearance every element must keep from every canvas edge. Play
 * crops this graphic's edges on some surfaces (the brief's own words);
 * nothing load-bearing may sit closer.
 */
const LOCKUP_SAFE_MARGIN_PX = 60;

/**
 * `--color-ln-azul-900`, restated as a literal — same posture as PAPER above
 * and the same reason: this script does not import app/globals.css or
 * @dim/contract/tokens, so nothing guards this beyond the fact that the navy
 * field has not moved since Libreta Nacional. Exported so the test can
 * measure against it instead of restating a third copy.
 */
export const NAVY = { r: 0x0a, g: 0x35, b: 0x56, alpha: 1 } as const;

/** `--color-ln-celeste-100`, same posture as NAVY above. Tagline colour only. */
const CELESTE_100_HEX = "#DCEBF7";

/**
 * Composes the Play Store feature graphic's designed lockup and writes it to
 * `apps/mobile/assets/store/feature-graphic.png`. See the header above this
 * function for what it is and is not.
 */
async function buildFeatureGraphicLockup(trimmedMark: Buffer): Promise<void> {
  const outDir = path.join(MOBILE_OUT_DIR, "store");
  mkdirSync(outDir, { recursive: true });

  // --- The rounded paper tile, mark centred on it, launcher-style -----------
  // Same posture as icon.png's own recipe above (RATIO_LAUNCHER, paper
  // ground): this tile IS a launcher icon in miniature, just with a drawn
  // corner radius instead of an OS mask, because nothing here goes through a
  // launcher.
  const tileRadius = Math.round(LOCKUP_TILE_PX * LOCKUP_TILE_RADIUS_RATIO);
  const tileBase = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${LOCKUP_TILE_PX}" height="${LOCKUP_TILE_PX}">` +
        `<rect width="${LOCKUP_TILE_PX}" height="${LOCKUP_TILE_PX}" rx="${tileRadius}" ry="${tileRadius}" fill="#FBFAF5"/></svg>`,
    ),
  )
    .png()
    .toBuffer();

  const markOnTile = await sharp(trimmedMark)
    .resize({ width: Math.round(LOCKUP_TILE_PX * RATIO_LAUNCHER), kernel: "lanczos3" })
    .png()
    .toBuffer();

  const tile = await sharp(tileBase)
    .composite([{ input: markOnTile, gravity: "centre" }])
    .png()
    .toBuffer();

  // --- The wordmark, set as SVG text and trimmed to its own ink -------------
  const TEXT_CANVAS_WIDTH = 700;
  const TEXT_CANVAS_HEIGHT = 220;
  const FONT_STACK = "-apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
  const textSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TEXT_CANVAS_WIDTH}" height="${TEXT_CANVAS_HEIGHT}">` +
    `<text x="4" y="112" font-family="${FONT_STACK}" font-weight="700" font-size="104" ` +
    `fill="#FFFFFF">${BRANDING.appName}</text>` +
    `<text x="4" y="182" font-family="${FONT_STACK}" font-weight="500" font-size="40" ` +
    `fill="${CELESTE_100_HEX}">${BRANDING.appNameLong}</text></svg>`;
  const textRaw = await sharp(Buffer.from(textSvg)).png().toBuffer();
  const text = await sharp(textRaw).trim({ threshold: 10 }).png().toBuffer();
  const textMeta = await sharp(text).metadata();
  if (!textMeta.width || !textMeta.height) {
    throw new Error("feature graphic lockup: could not measure the rendered wordmark");
  }

  // --- Placement, checked against the safe margin, not assumed into it ------
  const tileLeft = LOCKUP_TILE_LEFT_PX;
  const tileTop = Math.round((FEATURE_GRAPHIC_HEIGHT - LOCKUP_TILE_PX) / 2);
  const textLeft = tileLeft + LOCKUP_TILE_PX + LOCKUP_TEXT_GAP_PX;
  const textTop = Math.round((FEATURE_GRAPHIC_HEIGHT - textMeta.height) / 2);

  if (
    tileLeft < LOCKUP_SAFE_MARGIN_PX ||
    tileTop < LOCKUP_SAFE_MARGIN_PX ||
    textTop < LOCKUP_SAFE_MARGIN_PX ||
    textLeft + textMeta.width > FEATURE_GRAPHIC_WIDTH - LOCKUP_SAFE_MARGIN_PX ||
    textTop + textMeta.height > FEATURE_GRAPHIC_HEIGHT - LOCKUP_SAFE_MARGIN_PX
  ) {
    throw new Error(
      `feature graphic lockup: composition crossed the 60px safe margin — measured wordmark ${textMeta.width}x${textMeta.height}; adjust font sizes or LOCKUP_TEXT_GAP_PX`,
    );
  }

  const out = path.join(outDir, "feature-graphic.png");
  await sharp({
    create: {
      width: FEATURE_GRAPHIC_WIDTH,
      height: FEATURE_GRAPHIC_HEIGHT,
      channels: 4,
      background: NAVY,
    },
  })
    .composite([
      { input: tile, left: tileLeft, top: tileTop },
      { input: text, left: textLeft, top: textTop },
    ])
    // OPAQUE — Play's spec for this asset forbids an alpha channel, the same
    // rule the `feature-graphic` recipe above answers to. See its own
    // comment for the citation; it is Play's rule, not a style choice here.
    .flatten({ background: NAVY })
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toFile(out);

  const written = await sharp(out).metadata();
  console.log(
    `  ${path.relative(ROOT, out).replaceAll("\\", "/").padEnd(44)} ${written.width}×${written.height}  tile ${LOCKUP_TILE_PX}px@(${tileLeft},${tileTop})  text ${textMeta.width}×${textMeta.height}@(${textLeft},${textTop})  alpha=${written.hasAlpha}  Google Play Store listing feature graphic — mark + wordmark lockup`,
  );
}

async function main(): Promise<void> {
  const meta = await sharp(SOURCE, { density: RASTER_DENSITY }).metadata();
  if (!meta.width || !meta.height) {
    throw new Error(`Could not read dimensions from ${SOURCE}`);
  }

  // THE TRIM IS THE FIRST OPERATION, and everything downstream measures against
  // its result rather than against the file. See "THE TRIM, AND THE ONE RULE
  // BEHIND IT" in the header: the ratios are ink measurements, and the SVG
  // carries a 5-unit border the ratios must not be paying for.
  //
  // Threshold 10 rather than 0: a rasteriser's edge is never perfectly clean,
  // and a handful of near-transparent stray pixels would otherwise defeat the
  // trim entirely and silently — the failure would be a mark a few percent
  // smaller than intended, which nobody sees on a phone.
  //
  // WRITTEN OUT EVEN THOUGH 10 IS ALSO SHARP'S DEFAULT. The explicit value is a
  // pin, not an override: a default that changes in a minor release would move
  // the ink measurement under a script whose whole claim is that its outputs are
  // reproducible. What is NOT passed is `background` — the default compares
  // against the top-left pixel, which on this file is transparent, and naming
  // the icons' cream `#FBFAF5` here would return the untrimmed canvas.
  const trimmed = await sharp(SOURCE, { density: RASTER_DENSITY })
    .trim({ threshold: 10 })
    .png()
    .toBuffer();
  const ink = await sharp(trimmed).metadata();
  if (!ink.width || !ink.height) {
    throw new Error(`Could not measure the trimmed mark from ${SOURCE}`);
  }

  console.log(
    `source: ${path.relative(ROOT, SOURCE)} — ${meta.width}×${meta.height}, ` +
      `ink ${ink.width}×${ink.height} after trim`,
  );
  for (const dir of new Set(RECIPES.map((recipe) => recipe.dir))) {
    mkdirSync(dir, { recursive: true });
  }

  for (const recipe of RECIPES) {
    // Only ONE axis is ever passed to `resize` — sharp derives the other from
    // the source aspect ratio. The plaque is square today, but squashing a mark
    // by a rounding pixel is the one distortion nobody would notice until it was
    // on 12 phones. Which axis is passed is `markSize.by`; see the Recipe type
    // for why that stops being arbitrary once the canvas is not square.
    const mark = await sharp(trimmed)
      .resize(
        recipe.markSize.by === "width"
          ? { width: recipe.markSize.px, kernel: "lanczos3" }
          : { height: recipe.markSize.px, kernel: "lanczos3" },
      )
      .png()
      .toBuffer();

    const out = path.join(recipe.dir, recipe.file);
    const scaleBasis = recipe.markSize.by === "width" ? ink.width : ink.height;
    const scale = recipe.markSize.px / scaleBasis;
    const scaleLabel = scale >= 1 ? `↑${scale.toFixed(2)}×` : `↓${scale.toFixed(2)}×`;

    if (recipe.canvasWidth === null || recipe.canvasHeight === null) {
      await sharp(mark).png({ compressionLevel: 9 }).toFile(out);
    } else {
      let canvas = sharp({
        create: {
          width: recipe.canvasWidth,
          height: recipe.canvasHeight,
          channels: 4,
          background: recipe.ground ?? { r: 0, g: 0, b: 0, alpha: 0 },
        },
      }).composite([{ input: mark, gravity: "centre" }]);

      // THE ALPHA CHANNEL IS DROPPED, NOT MERELY FILLED. App Store Connect
      // rejects an app icon that HAS an alpha channel — it does not look at
      // whether every pixel in it happens to be opaque, which is what a
      // composite over a solid ground produces. Two separate calls because
      // they answer two separate questions: `flatten` decides what shows
      // through the knocked-out window, `removeAlpha` decides how many
      // channels the file declares.
      if (recipe.ground !== null) {
        canvas = canvas.flatten({ background: recipe.ground }).removeAlpha();
      }

      await canvas.png({ compressionLevel: 9 }).toFile(out);
    }

    // Reported from the file on disk, never from the intent above it: `resize`
    // rounds the derived height, and a log that prints the requested number is
    // a log that cannot tell you it got something else.
    const written = await sharp(out).metadata();
    console.log(
      `  ${path.relative(ROOT, out).replaceAll("\\", "/").padEnd(44)} ` +
        `${written.width}×${written.height}` +
        `  mark ${recipe.markSize.px}px-${recipe.markSize.by} ${scaleLabel}` +
        `  alpha=${written.hasAlpha}  ${recipe.what}`,
    );
  }

  await buildFeatureGraphicLockup(trimmed);

  const dirs = [...new Set(RECIPES.map((recipe) => path.relative(ROOT, recipe.dir)))];
  console.log(
    `\nwrote ${RECIPES.length} file(s) to ${dirs.join(", ")}, plus the Play Store lockup graphic ` +
      `to ${path.relative(ROOT, path.join(MOBILE_OUT_DIR, "store"))}`,
  );
}

/**
 * Only run when this file IS the entry point.
 *
 * Without this guard, importing the module to read `RATIO_LAUNCHER` from a test
 * would regenerate seven binaries as a side effect of an import — which is both
 * a slow test and a test that can rewrite the very files it is about to assert
 * on. Same shape as scripts/check-icon-registry.ts, with the filename fallbacks
 * for the tsx/Windows paths where the URL comparison is not exact.
 */
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("build-mobile-app-icons.ts") ||
    process.argv[1].endsWith("build-mobile-app-icons.js") ||
    import.meta.url === pathToFileURL(process.argv[1]).href);

if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
