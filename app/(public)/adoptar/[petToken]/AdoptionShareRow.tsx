"use client";

// AdoptionShareRow — WhatsApp share + copy-link for the adoption ficha.
// Small two-button row; no Twitter/Facebook clutter per the §2.1 design handoff.

import { useState } from "react";

import { Icon } from "@/components/Icon";

interface Props {
  /** Full canonical URL for this adoption ficha. */
  fichaUrl: string;
  /** Pet name for composing the share text. */
  petName: string;
}

export function AdoptionShareRow({ fichaUrl, petName }: Props) {
  const [copied, setCopied] = useState(false);

  function shareWhatsApp() {
    const text = encodeURIComponent(`¡Mirá a ${petName}, está en adopción en miMAR! ${fichaUrl}`);
    window.open(`https://wa.me/?text=${text}`, "_blank", "noopener");
  }

  function copyLink() {
    const markCopied = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(fichaUrl).then(markCopied);
      return;
    }
    // Fallback for browsers without the async Clipboard API (http dev,
    // older WebViews).
    const el = document.createElement("textarea");
    el.value = fichaUrl;
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
    markCopied();
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={shareWhatsApp}
        className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border px-3 py-2 text-sm font-semibold transition-colors"
        style={{
          background: "var(--color-ln-ok-050)",
          borderColor: "var(--color-ln-ok-100)",
          color: "var(--color-ln-ok)",
        }}
      >
        <Icon name="mensaje" size="sm" decorative />
        Compartir por WhatsApp
      </button>
      <button
        type="button"
        onClick={copyLink}
        className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border px-3 py-2 text-sm font-semibold transition-colors"
        style={{
          background: "var(--color-ln-stripe)",
          borderColor: "var(--color-ln-line-2)",
          color: "var(--color-ln-ink-2)",
        }}
      >
        {copied ? (
          <>
            ¡Copiado! <Icon name="check" size="sm" decorative />
          </>
        ) : (
          <>
            <Icon name="enlace" size="sm" decorative /> Copiar link
          </>
        )}
      </button>
    </div>
  );
}
