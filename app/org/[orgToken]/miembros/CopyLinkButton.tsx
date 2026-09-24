"use client";

// CopyLinkButton — copies the invite URL to clipboard and provides brief feedback.

import { useState } from "react";

import { OpButton } from "@/components/ui/dashboard";

export function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access denied — fall back to selection for manual copy.
    }
  }

  return (
    <OpButton variant="ghost" size="sm" onClick={handleCopy}>
      {copied ? "¡Copiado!" : "Copiar link"}
    </OpButton>
  );
}
