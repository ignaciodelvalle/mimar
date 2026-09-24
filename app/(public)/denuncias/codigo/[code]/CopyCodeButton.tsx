"use client";

// CopyCodeButton — copies a welfare report reference code to clipboard.
// Shows brief "¡Copiado!" feedback, then resets.
// Used on the comprobante page so reporters can copy their tracking code
// on every visit (not only at submission time).

import { useState } from "react";

interface Props {
  code: string;
}

export function CopyCodeButton({ code }: Props) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable — silently degrade.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? "Código copiado" : `Copiar código ${code}`}
      className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--color-ln-mute)] hover:text-[var(--color-ln-ink-2)] border border-[var(--color-ln-line)] rounded-[var(--radius-sm)] px-2.5 py-1 transition-colors print:hidden"
    >
      {copied ? (
        <>
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-3.5 h-3.5 text-[var(--color-ln-ok)]"
            aria-hidden="true"
          >
            <polyline points="13 4 6 11 3 8" />
          </svg>
          <span className="text-[var(--color-ln-ok)]">¡Copiado!</span>
        </>
      ) : (
        <>
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-3.5 h-3.5"
            aria-hidden="true"
          >
            <rect x="5" y="5" width="9" height="9" rx="1.5" />
            <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
          </svg>
          Copiar código
        </>
      )}
    </button>
  );
}
