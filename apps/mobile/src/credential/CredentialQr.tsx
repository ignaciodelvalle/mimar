// CredentialQr (native) — the same QR the web renders, drawn with react-native-svg.
//
// This is the React Native counterpart of `components/ui/CredentialQr.tsx`, and
// it is deliberately the SAME ALGORITHM rather than a different library doing
// something similar. The web component's header explains why the encode moved
// into the client at all (native-readiness RN-5: "the QR becomes a pure function
// of a cached string") — this file is the payoff. Two renderers, one encoder,
// one module matrix, one `d` attribute.
//
// WHY NOT `react-native-qrcode-svg`
// ---------------------------------------------------------------------------
// It would work, and it is the obvious pick. It was not taken because it solves
// a problem this repo has already solved: `qrcode` is already a dependency of
// the web app, `QRCode.create()` is synchronous and pure, and `modulesToPath()`
// below is the web component's function verbatim. Adding a second QR library
// would mean the phone and the browser could disagree about the code printed
// on the same credential — with a different error-correction default, a
// different quiet zone, or a different module rounding — and nothing would
// catch it, because nobody diffs two images across two platforms.
//
// `qrcode` resolves under Metro through its `browser` field
// (`lib/browser.js`), which exports `create` without touching `node:fs` or
// `canvas`. That is the whole reason the deep-import ban in the web component
// ("that path is package internals, not API") can hold here too.
//
// The only real difference from the web version is the element vocabulary:
// `<Svg>`/`<Path>` from react-native-svg instead of intrinsic `<svg>`/`<path>`,
// and `fill` as a literal colour because there is no `currentColor` and no
// cascade to inherit it from.

import QRCode from "qrcode";
import { useMemo } from "react";
import { Path, Svg } from "react-native-svg";

/** Quiet zone, in modules, on every side. Matches the web component. */
const QUIET_ZONE = 1;

/**
 * True black, not the design system's ink.
 *
 * The web component reaches for `--color-qr-ink` and `app/globals.css` explains
 * why that token is not the document's text colour: a scanner wants maximum
 * contrast, and a softened near-black costs decode margin in bad light — which
 * is the light a lost pet's collar is read in.
 */
const QR_INK = "#000000";

export type CredentialQrProps = {
  /** The ABSOLUTE URL the QR encodes. Build it with `publicCredentialPageUrl()`. */
  value: string;
  /** Rendered pixel size. */
  size: number;
  /** es-AR accessible name (the svg is exposed as an image). */
  label: string;
};

/**
 * Serializes a QR module matrix into ONE svg path of filled rectangles.
 *
 * Copied from `components/ui/CredentialQr.tsx`, itself adapted from the row-run
 * idea in qrcode's `lib/renderer/svg-tag.js` (`qrToPath`, MIT): consecutive
 * dark modules in a row collapse into a single subpath, and each run is CLOSED
 * (`h{n}v1h-{n}z`) so the path renders with `fill` rather than a 1-unit stroke.
 */
function modulesToPath(data: Uint8Array, size: number, margin: number): string {
  let path = "";

  for (let row = 0; row < size; row += 1) {
    let col = 0;
    while (col < size) {
      if (!data[row * size + col]) {
        col += 1;
        continue;
      }
      let run = 1;
      while (col + run < size && data[row * size + col + run]) run += 1;
      path += `M${col + margin} ${row + margin}h${run}v1h-${run}z`;
      col += run;
    }
  }

  return path;
}

export function CredentialQr({ value, size, label }: CredentialQrProps) {
  const { path, extent } = useMemo(() => {
    // Synchronous and pure — no effect, no state, no loading flash.
    const symbol = QRCode.create(value, { errorCorrectionLevel: "M" });
    const moduleCount = symbol.modules.size;
    return {
      path: modulesToPath(symbol.modules.data, moduleCount, QUIET_ZONE),
      extent: moduleCount + QUIET_ZONE * 2,
    };
  }, [value]);

  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${extent} ${extent}`}
      accessibilityRole="image"
      accessibilityLabel={label}
    >
      <Path d={path} fill={QR_INK} />
    </Svg>
  );
}
