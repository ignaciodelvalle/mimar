"use client";

import { useState } from "react";

import { Icon } from "@/components/Icon";
import { Sheet } from "@/components/ui/VaulSheet";
import { resolveSiteUrl } from "@/lib/infra/site-url";
import { buildCloseSheetUrl } from "@/lib/ui/sheet-helpers";
import { closeSheetNav } from "@/lib/ui/sheet-nav";
import { usePathname, useSearchParams } from "next/navigation";

// "Compartir refugio" — copy-link + native share (handoff P2-9).

interface Props {
  orgToken: string;
  orgDisplayName: string;
}

export function CompartirOrgSheet({ orgToken, orgDisplayName }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [copied, setCopied] = useState(false);

  const open = searchParams.get("sheet") === "compartir-org";
  // The SSR branch used to hardcode `https://mimar.ar`, a domain that does not
  // resolve — so a share performed before hydration handed someone a dead link
  // for a shelter. It is a second spelling of an origin that already has one
  // source; `resolveSiteUrl()` is that source, and it is safe in a client
  // component because NEXT_PUBLIC_SITE_URL is inlined into the bundle at build.
  const url =
    typeof window !== "undefined"
      ? `${window.location.origin}/refugios/${orgToken}`
      : `${resolveSiteUrl()}/refugios/${orgToken}`;
  const shareText = `Conocé ${orgDisplayName} en miMAR. Tienen mascotas en adopción y servicios para la comunidad.`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable, ignore */
    }
  }

  async function nativeShare() {
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: orgDisplayName, text: shareText, url });
      } catch {
        /* user dismissed */
      }
    }
  }

  return (
    <Sheet
      id="compartir-org"
      title={`Compartir ${orgDisplayName}`}
      open={open}
      onClose={() => closeSheetNav(buildCloseSheetUrl(pathname, searchParams))}
      size="sm"
    >
      <div className="space-y-4">
        <p className="text-sm text-[var(--color-ln-ink-2)]">
          Compartí este link con quien quieras: vecinos, redes, grupos de WhatsApp.
        </p>

        <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] p-3 text-xs font-ln-mono break-all text-[var(--color-ln-ink)]">
          {url}
        </div>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={copy}
            className="flex w-full items-center justify-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--color-ln-azul)] text-white text-sm font-semibold px-4 py-2.5 hover:bg-[var(--color-ln-azul-700)] focus:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)] transition-colors"
          >
            {copied ? (
              <>
                <Icon name="check" size="sm" decorative /> Link copiado
              </>
            ) : (
              "Copiar link"
            )}
          </button>
          {typeof navigator !== "undefined" && "share" in navigator && (
            <button
              type="button"
              onClick={nativeShare}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] text-[var(--color-ln-ink)] text-sm font-medium px-4 py-2.5 hover:bg-[var(--color-ln-stripe)] focus:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-ln-celeste-050)] transition-colors"
            >
              Más opciones para compartir…
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}
