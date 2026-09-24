"use client";

// CopyViewButton — copies the current page URL (path + every active
// searchParam) to the clipboard. The filter bar's own commit model already
// drives every filter through the URL (period/jurisdiction/domain axes are
// all searchParams — see OpFilterBar's doc comment), so the live URL already
// IS a shareable "saved view"; this just surfaces a one-click affordance
// instead of "select the address bar manually".
//
// Read at CLICK TIME (not render time) — the button's static markup (icon +
// label) is byte-identical on server and client; only the ephemeral "copied"
// feedback differs, and that starts `false` on both, so there is no
// SSR/hydration mismatch from reading `window.location` during render.
//
// Mirrors the "Copiar vista" idiom already established in
// components/panorama/PanoramaConsole.tsx (Exportar rail panel) — same label,
// same clipboard-only mechanism. Read-only: never calls
// window.location.assign — this control never navigates.
//
// Reusable across every OpFilterBar consumer (censo/poblacion/adopciones/
// campanas/perdidas/maltrato/analytics/…) instead of a per-screen affordance.

import { useCallback, useState } from "react";

import { Icon } from "@/components/Icon";

export function CopyViewButton({ className = "" }: { className?: string }) {
  const [copied, setCopied] = useState(false);

  const copyView = useCallback(() => {
    if (typeof window === "undefined" || !navigator.clipboard) return;
    navigator.clipboard.writeText(window.location.href).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      },
      () => {
        // Clipboard access denied — the URL is still shareable from the address bar.
      },
    );
  }, []);

  return (
    <button
      type="button"
      onClick={copyView}
      aria-label="Copiar vista: copia el enlace con los filtros activos al portapapeles"
      className={[
        "inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-ln-op-line",
        "px-2 py-1 text-xs font-medium text-ln-op-ink-2 transition-colors",
        "hover:bg-ln-op-stripe hover:text-ln-op-ink",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-op-azul",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <Icon name="enlace" size={13} decorative />
      {copied ? "¡Copiado!" : "Copiar vista"}
    </button>
  );
}
