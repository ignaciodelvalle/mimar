"use client";

// CredentialQr — the credential's QR, encoded in the BROWSER as a pure function
// of the URL it carries (native-readiness Track 2, RN-5 F3).
//
// Why this exists. The QR used to be produced on the server with
// `QRCode.toString({ type: "svg" })` and shipped to the client as a markup
// string, injected into the DOM as raw HTML. That made the one artifact that
// IS the credential depend on a server round-trip, even though its only input
// — a single absolute URL — is a string the device could hold. RN-5 states the
// target shape directly: "the QR becomes a pure function of a cached string".
// This component is that function. It is a PREREQUISITE for an offline
// credential, not the capability itself: `public/sw.js` keeps no fetch handler,
// so the page does not load offline today — what changed is that drawing the
// QR no longer needs anything the server computes.
//
// Rendering contract:
//   · `QRCode.create()` is SYNCHRONOUS and pure, so the encode happens in the
//     component body. No `useEffect` + `useState` fetch, therefore no skeleton,
//     no pop-in, and byte-identical SSR and hydration output (AGENTS.md
//     #design-rules-ui-conventions: no CLS).
//   · Real JSX, never an injected HTML string: the QR is markup we COMPUTE.
//     Its own test pins the absence of every raw-HTML injection escape hatch in
//     this file, so the ban cannot be reintroduced quietly.
//   · Deterministic: the same `value` + `errorCorrectionLevel` always produce
//     the same `d`. `useMemo` only avoids re-encoding on unrelated re-renders.
//   · No service worker is involved, and none may be added for this (RN-5:
//     `public/sw.js` must keep no fetch handler — a fitness test enforces it).
//
// Invariant #1 (the pet is the credential): `value` MUST be an absolute URL.
// Every caller builds it with `credentialQrUrl()` from lib/infra/site-url.ts —
// the one helper that can never return a host-less relative URL, which no phone
// camera can resolve (a real past production bug).
//
// This file deliberately does NOT deep-import qrcode's own SVG renderer
// (`qrcode/lib/renderer/svg-tag`). That path is package internals, not API;
// `modulesToPath` below is a ~20-line re-implementation of the same row-run
// idea, adapted to emit CLOSED rectangles so the path can be FILLED (qrcode's
// own version emits open horizontal lines and relies on a 1-unit stroke).

import QRCode from "qrcode";
import { useMemo } from "react";

/** Quiet zone, in modules, on every side. Matches the previous `margin: 1`. */
const QUIET_ZONE = 1;

export type CredentialQrErrorCorrectionLevel = "L" | "M" | "Q" | "H";

export type CredentialQrProps = {
  /**
   * The ABSOLUTE URL the QR encodes. Build it with `credentialQrUrl()` from
   * lib/infra/site-url.ts — a relative URL produces an unscannable code.
   */
  value: string;
  /**
   * Intrinsic pixel size written to the svg's `width`/`height` attributes.
   * These are SVG PRESENTATION attributes, which sit below every CSS rule in
   * the cascade: a stylesheet that sizes the element (e.g. the credential
   * hero's `.ln-qr-frame svg { width: 76px }`, bumped to 104px at `md`) still
   * wins. `size` therefore sets the pre-CSS intrinsic box, not the final one.
   */
  size: number;
  /** QR error-correction level. Defaults to "M", the credential's standard. */
  errorCorrectionLevel?: CredentialQrErrorCorrectionLevel;
  /** es-AR accessible name for the code (the svg carries `role="img"`). */
  label: string;
  /** Extra classes. `text-qr-ink` (`--color-qr-ink`, true black — app/globals.css
   *  says why it is not the document ink) is always applied first so the ink
   *  stays at maximum contrast for scanners unless a caller deliberately
   *  overrides it. */
  className?: string;
};

/**
 * Serializes a QR module matrix into ONE svg path of filled rectangles.
 *
 * Adapted from the row-run idea in qrcode's `lib/renderer/svg-tag.js`
 * (`qrToPath`, MIT): consecutive dark modules in a row collapse into a single
 * subpath instead of one rect each, which keeps the `d` string short. The
 * difference is that each run is CLOSED (`h{n}v1h-{n}z`) so the path renders
 * with `fill` rather than a 1-unit `stroke`.
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

export function CredentialQr({
  value,
  size,
  errorCorrectionLevel = "M",
  label,
  className,
}: CredentialQrProps) {
  const { path, extent } = useMemo(() => {
    const symbol = QRCode.create(value, { errorCorrectionLevel });
    const moduleCount = symbol.modules.size;
    return {
      path: modulesToPath(symbol.modules.data, moduleCount, QUIET_ZONE),
      extent: moduleCount + QUIET_ZONE * 2,
    };
  }, [value, errorCorrectionLevel]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${extent} ${extent}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={className ? `text-qr-ink ${className}` : "text-qr-ink"}
    >
      <path fill="currentColor" d={path} />
    </svg>
  );
}
