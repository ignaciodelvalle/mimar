"use client";

// CopyButton — copies arbitrary text to the clipboard with brief "¡Copiado!"
// feedback. Generic, reusable version of the miembros CopyLinkButton, used to
// make generated tokens/codes copyable (UX 3.6 c). Falls back silently when the
// Clipboard API is unavailable — the text stays selectable for manual copy.

import { useState } from "react";

export function CopyButton({
  text,
  label = "Copiar",
  copiedLabel = "¡Copiado!",
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access denied — the value stays selectable for manual copy.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={`${label}: ${text}`}
      className="ml-1 inline-flex items-center rounded-[var(--radius-sm)] border border-ln-op-line px-2 py-0.5 align-middle text-sm font-medium text-ln-op-ink transition-colors hover:bg-ln-op-stripe"
    >
      {copied ? copiedLabel : label}
    </button>
  );
}
