"use client";

// LostShareCard — share-first hero for the lost-panel lean (task #43): a
// full-width WhatsApp CTA (the channel that actually moves finder tips in
// barrio/grupo contexts) plus a secondary row for copy-link + the printable
// poster. Twitter/Facebook were dropped from this default lost path — they
// converted far less than WhatsApp for lost-pet alerts and just diluted the
// primary CTA into a 4-up grid (Cursor audit #735). Client because each
// action does a window.open() / navigator.clipboard / navigator.share call.
//
// Why server-rendering the URL + text first: we want a stable link the
// server has approved (canonical /p/{token}) instead of relying on the
// client to assemble it. shareText is templated server-side by the caller
// (LostCaseBlock) so the pet's first-name visibility honours the owner's
// disclosure prefs — fixed 2026-07-04 (Cursor audit #735 flagged the prior
// text as disclosure-blind despite this same claim).

import { useEffect, useState } from "react";

import { Icon } from "@/components/Icon";

interface Props {
  /** Public credential URL. e.g. https://www.mimar.com.ar/p/{token} */
  publicUrl: string;
  /** Pre-built share copy, already filtered by disclosure prefs. */
  shareText: string;
  /** Route or external link to the printable poster (PDF/SVG). */
  posterHref: string;
}

export function LostShareCard({ publicUrl, shareText, posterHref }: Props) {
  const [copied, setCopied] = useState(false);
  // Mounted flag instead of reading `navigator` during render: SSR has no
  // navigator, so the conditional button hydrated differently than it
  // server-rendered (React #418 on every lost-pet profile). First client
  // render now matches the server (no button), and the button appears
  // after mount only where Web Share actually exists.
  const [canNativeShare, setCanNativeShare] = useState(false);
  useEffect(() => {
    if ("share" in navigator) setCanNativeShare(true);
  }, []);

  function copy() {
    void navigator.clipboard?.writeText(publicUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function shareWhatsApp() {
    const url = `https://wa.me/?text=${encodeURIComponent(`${shareText} ${publicUrl}`)}`;
    window.open(url, "_blank", "noopener");
  }

  function nativeShare() {
    if (typeof navigator !== "undefined" && "share" in navigator) {
      void navigator
        .share({ title: "Mascota perdida", text: shareText, url: publicUrl })
        .catch(() => {});
    }
  }

  return (
    <section aria-labelledby="lp-share-h">
      <h2 id="lp-share-h" className="sr-only">
        Compartir alerta
      </h2>

      {/* Hero — WhatsApp, the channel that actually moves finder tips. Uses
          the project's own ok/success token rather than WhatsApp's brand
          green — this design system is tokenized, no raw hex (lint:tokens). */}
      <button
        type="button"
        onClick={shareWhatsApp}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-[var(--color-ln-ok)] px-5 py-3 text-md font-semibold text-white transition-colors hover:opacity-90"
      >
        <Icon name="mensaje" size="md" decorative />
        Compartir por WhatsApp
      </button>

      {/* Secondary row — copy link + poster. */}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={copy}
          className="flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-ln-line bg-ln-card px-3 text-sm font-medium text-ln-ink-2 transition-colors hover:bg-ln-stripe"
        >
          {copied ? (
            <>
              <Icon name="check" size="sm" decorative /> Copiado
            </>
          ) : (
            "Copiar link"
          )}
        </button>
        <a
          href={posterHref}
          target="_blank"
          rel="noreferrer"
          className="flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-ln-line bg-ln-card px-3 text-sm font-medium text-ln-ink-2 no-underline transition-colors hover:bg-ln-stripe"
        >
          <Icon name="impresora" size="sm" decorative />
          Afiche
        </a>
      </div>

      {canNativeShare && (
        <button
          type="button"
          onClick={nativeShare}
          className="mt-2 min-h-11 w-full rounded-full bg-ln-stripe px-3 py-2 text-sm font-medium text-ln-ink-2 hover:bg-ln-stripe"
        >
          Compartir con otras apps…
        </button>
      )}
    </section>
  );
}
