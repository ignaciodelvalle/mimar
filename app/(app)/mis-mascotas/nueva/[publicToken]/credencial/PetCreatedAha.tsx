"use client";

// PetCreatedAha — celebratory success screen shown after first pet creation.
//
// Core aha: "your pet has a verifiable QR credential you can share right now."
//
// Three CTAs (spec: max 3, regla de 4 verbos):
//   1. "Compartir" — Web Share API, falls back to copy-to-clipboard.
//   2. "Ver perfil" — navigates to the pet profile page.
//   3. "Ver credencial pública" — opens the public-facing credential page.
//
// Plus ONE affordance that is not part of that cluster: "Imprimir la chapita",
// rendered with the QR block itself (D.8, 2026-07-30). The copy above the QR
// has always said "Guardalo en el collar" and offered no way to do it; the
// print surface already exists at /mis-mascotas/[token]/chapita
// (ChapitaSheet, three printable layouts + window.print). This screen LINKS
// there — it does NOT reimplement printing — because /chapita is gated by
// resolvePhysicalCredentialChannels and the `printable_qr` channel can be
// disabled per jurisdiction; an embedded print button would bypass that gate.
// The server parent resolves the same channel and passes printableQrEnabled,
// so a jurisdiction with the channel off never sees the link at all.
// It sits with the QR, not with the actions, so the max-3-CTA action cluster
// is intact and the affordance lands where "guardalo en el collar" is read.
//
// A11y:
//   - Focus moves to the h1 heading on mount.
//   - The QR svg itself (CredentialQr) carries role="img" + an aria-label
//     describing the linked URL.
//   - All interactive elements have visible focus rings.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { CredentialQr } from "@/components/ui/CredentialQr";

interface Props {
  petName: string;
  publicToken: string;
  /** ABSOLUTE credential URL (built with `credentialQrUrl()`). It is both the
   *  shared link and the QR's only input — <CredentialQr> encodes it here in
   *  the browser instead of receiving server-rendered SVG markup. */
  credentialUrl: string;
  /** Whether the pet's jurisdiction has the `printable_qr` channel enabled.
   *  Resolved server-side by the parent page from the SAME resolver /chapita
   *  itself uses, so the link is never offered into a closed channel. */
  printableQrEnabled: boolean;
}

export function PetCreatedAha({ petName, publicToken, credentialUrl, printableQrEnabled }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [shareState, setShareState] = useState<"idle" | "copied" | "error">("idle");

  // A11y: focus the heading on mount so screen-reader users land in context.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  async function handleShare() {
    const shareData = {
      title: `Credencial de ${petName} — miMAR`,
      text: `La libreta sanitaria digital de ${petName} en miMAR.`,
      url: credentialUrl,
    };

    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch (err) {
        // User cancelled share or API unavailable — fall through to clipboard.
        if (err instanceof Error && err.name === "AbortError") return;
      }
    }

    // Fallback: copy URL to clipboard.
    try {
      await navigator.clipboard.writeText(credentialUrl);
      setShareState("copied");
      setTimeout(() => setShareState("idle"), 2500);
    } catch {
      setShareState("error");
      setTimeout(() => setShareState("idle"), 2500);
    }
  }

  const shareLabel =
    shareState === "copied"
      ? "¡Link copiado!"
      : shareState === "error"
        ? "No se pudo copiar"
        : "Compartir";

  return (
    <div className="min-h-screen bg-[var(--color-ln-paper)] flex flex-col items-center justify-center px-4 py-12">
      <div className="max-w-sm w-full space-y-8 text-center">
        {/* Success badge */}
        <div
          className="w-16 h-16 rounded-full bg-[var(--color-ln-ok-050)] border border-[var(--color-ln-ok-100)] flex items-center justify-center mx-auto"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-8 h-8 text-[var(--color-ln-ok)]"
            role="img"
            aria-label="Éxito"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>

        {/* Heading — receives focus on mount for a11y */}
        <div className="space-y-2">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-2xl font-semibold text-[var(--color-ln-ink)] outline-none"
          >
            {petName} ya tiene su credencial
          </h1>
          <p className="text-sm text-[var(--color-ln-mute)] leading-relaxed">
            Cualquiera que escanee el QR puede ver su libreta pública. Guardalo en el collar o
            compartilo con el veterinario.
          </p>
        </div>

        {/* QR block — ≥200px per spec (drawn at 240px).
            <CredentialQr> owns role=img + the aria-label describing the QR's
            purpose and the URL it encodes; the wrapper is pure chrome, so the
            two never nest competing img roles. */}
        <div className="rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-white p-4 mx-auto inline-block">
          <CredentialQr
            value={credentialUrl}
            size={240}
            label={`Código QR que enlaza a la credencial pública de ${petName}: ${credentialUrl}`}
          />
        </div>

        {/* Credential URL — small, readable, below the QR */}
        <p
          className="font-ln-mono text-sm text-[var(--color-ln-mute)] break-all"
          aria-hidden="true"
        >
          {credentialUrl}
        </p>

        {/* The "guardalo en el collar" affordance. Belongs to the QR, not to
            the action cluster below. Hidden entirely when the jurisdiction has
            printable_qr off — /chapita would only show its own "no habilitado"
            notice, so offering the link would be a dead end. */}
        {printableQrEnabled && (
          <p className="-mt-4">
            <Link
              href={`/mis-mascotas/${publicToken}/chapita`}
              data-section="aha-print-chapita"
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1 text-sm font-medium text-[var(--color-ln-azul)] no-underline hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ln-azul)] focus-visible:ring-offset-2"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4"
              >
                <path d="M6 9V2h12v7" />
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <path d="M6 14h12v8H6z" />
              </svg>
              Imprimir la chapita
            </Link>
          </p>
        )}

        {/* Self-scan privacy lesson — the moment the landing deliberately does
            NOT teach (the flagship-pet demo stays curiosity-only). Alta is
            when it's actionable: the owner can still adjust what a stranger
            sees before anyone ever scans. Reframes the existing "Ver
            credencial pública" link below instead of adding a 4th CTA — the
            regla de 4 verbos / max-3-CTAs contract stays intact. */}
        <p className="text-left text-xs leading-relaxed text-[var(--color-ln-mute)] bg-[var(--color-ln-stripe)] rounded-[var(--radius-md)] px-3 py-2.5">
          Esto es lo que ve un extraño que escanea a {petName}: su nombre, especie y lo que vos
          decidas mostrar — nunca tus datos sin que los actives. Podés revisarlo con el link de
          abajo y, si {petName} alguna vez se pierde, elegir qué se comparte desde su perfil.
        </p>

        {/* Actions — max 3 per spec. The chapita link above is deliberately
            NOT one of them; the guard test counts inside this container. */}
        <div className="space-y-3" data-section="aha-actions">
          {/* Primary: share */}
          <button
            type="button"
            onClick={handleShare}
            className="block w-full px-4 py-3.5 rounded-[var(--radius-pill)] font-semibold text-sm text-center transition-colors bg-[var(--color-ln-azul)] text-white border border-[var(--color-ln-azul)] hover:bg-[var(--color-ln-azul-700)] hover:border-[var(--color-ln-azul-700)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ln-azul)] focus-visible:ring-offset-2"
          >
            {shareLabel}
          </button>

          {/* Secondary: view pet profile */}
          <Link
            href={`/mis-mascotas/${publicToken}`}
            className="block w-full px-4 py-3.5 rounded-[var(--radius-pill)] font-semibold text-sm text-center transition-colors border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] text-[var(--color-ln-ink-2)] hover:bg-[var(--color-ln-stripe)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ln-azul)] focus-visible:ring-offset-2"
          >
            Ver perfil
          </Link>

          {/* Tertiary: view public credential in a new tab */}
          <Link
            href={`/p/${publicToken}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full px-4 py-3.5 rounded-[var(--radius-pill)] font-medium text-sm text-center text-[var(--color-ln-mute)] hover:text-[var(--color-ln-ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ln-azul)] focus-visible:ring-offset-2"
          >
            Ver credencial pública
          </Link>
        </div>
      </div>
    </div>
  );
}
