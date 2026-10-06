"use client";

import Image from "next/image";
import { useState } from "react";

/**
 * The credential's pet photo, with a fallback for a URL that FAILS TO LOAD.
 *
 * The page already fell back when there was no photo row at all, but that is a
 * render-time conditional: it cannot see a `storagePath` that still resolves to
 * a URL whose object is gone (deleted from the bucket, expired signature, a
 * storage outage). In that case next/image rendered a broken-image glyph on the
 * single most public page in the product — the one every QR scan lands on.
 *
 * A client component is the only way to get `onError`, so the whole photo block
 * lives here rather than duplicating the placeholder markup across the server
 * page and this file.
 *
 * `priority` still preloads correctly: next/image emits its preload link during
 * SSR, before any of this hydrates.
 *
 * `fetchPriority="high"` is separate from `priority` in this Next.js version
 * (next/dist/shared/lib/get-img-props.js — `priority` alone gates `loading`,
 * not the `fetchpriority` attribute). Lighthouse's own lcp-discovery-insight
 * flagged this photo's preload link and `<img>` as missing it (2026-09-23
 * mobile LCP audit, R-2) — without it the browser's fetch scheduler has no
 * signal to prefer this image over the page's fonts/scripts under
 * contention, even though it is the LCP element on this route.
 *
 * TWO SIZES. `tile` is the 156px square of the identity row (every situation
 * but lost). `hero` is the full-width 4:3 photo the LOST render keeps: a finder
 * standing over an animal has to recognise it, and a thumbnail is not enough
 * to match a face (PO default, review 2026-10-06 — the photo was large on main).
 * Both stay `priority` + `fetchPriority="high"`: in either size it is the LCP
 * element, and `sizes` tells the optimizer which width to serve.
 */
export function CredentialPhoto({
  src,
  petName,
  variant = "tile",
}: {
  src: string | null;
  petName: string;
  variant?: "tile" | "hero";
}) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div className="pc-photo-placeholder">
        <span className="pc-photo-placeholder-initial">{petName.charAt(0).toUpperCase()}</span>
      </div>
    );
  }

  if (variant === "hero") {
    return (
      <Image
        src={src}
        alt={petName}
        width={460}
        height={345}
        priority
        fetchPriority="high"
        sizes="(max-width: 480px) 100vw, 460px"
        className="block w-full aspect-[4/3] object-cover"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <Image
      src={src}
      alt={petName}
      width={320}
      height={320}
      priority
      fetchPriority="high"
      sizes="156px"
      className="block h-full w-full object-cover"
      onError={() => setFailed(true)}
    />
  );
}
