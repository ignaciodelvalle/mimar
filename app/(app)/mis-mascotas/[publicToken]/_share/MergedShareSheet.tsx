"use client";

// MergedShareSheet — one "Compartir" sheet (design ADR-7) fusing:
//   1. the public QR link (copy-to-clipboard)
//   2. ShareLibretaSheet (expiring share link)
//   3. Tier2PublicView (temporary medical-view toggle)
//   4. SharesManager — active/revocable share links (ADR-14, owner-only).
//      LibretaFace lost this + its footer "Compartir libreta" link; it now
//      self-fetches via getActiveLibretaSharesAction on mount, since this
//      sheet is a sibling of PetDetailTabsPanel (no shared client state).
//
// `compartir-libreta` and `mostrar-tier2` are kept as deep-link aliases that
// route into this same sheet (SheetMounter wiring) for demo-safety /
// backward-compat with existing links.

import { deepLinkUrl } from "@dim/contract/links";
import { useCallback, useEffect, useState } from "react";

import { SharesManager } from "@/app/(app)/mis-mascotas/[publicToken]/libreta/SharesManager";
import { getActiveLibretaSharesAction } from "@/app/actions/libreta-share";
import { Icon } from "@/components/Icon";
import type { LibretaShareToken } from "@/db";
import { lostShareMessage } from "@/lib/utils/format";
import { ShareLibretaSheet } from "../_share-libreta/ShareLibretaSheet";
import { Tier2PublicView } from "../_tier2-public/Tier2PublicView";

type CreateShareResult = { error: string } | { shareToken: string };

type Tier2Props = {
  isActive: boolean;
  isPermanent: boolean;
  activeUntil: Date | null;
  enableAction: (formData: FormData) => Promise<void>;
  revokeAction: () => Promise<void>;
};

type Props = {
  petPublicToken: string;
  petName: string;
  /** Pet sex ('male' | 'female' | 'unknown') — flexes the lost share copy. */
  petSex: string | null;
  createShareAction: (
    input: Pick<{ expiresInDays: number | null; label: string | null }, "expiresInDays" | "label">,
  ) => Promise<CreateShareResult>;
  tier2: Tier2Props;
  /** Owner-only: SharesManager never renders for org viewers (ADR-14). */
  isOwner: boolean;
  /**
   * Task #43 (share-first lost flow): surfaces a WhatsApp shortcut when the
   * pet is currently lost. This generic "Compartir" sheet has no access to
   * the owner's disclosure prefs (unlike LostShareCard's server-templated
   * shareText in LostCaseBlock), so its copy stays deliberately generic —
   * it never names the owner or mentions contact details.
   */
  isLost: boolean;
};

function SectionHeading({ children }: { children: string }) {
  return (
    <p className="text-xs uppercase tracking-wider font-semibold text-[var(--color-ln-mute)]">
      {children}
    </p>
  );
}

export function MergedShareSheet({
  petPublicToken,
  petName,
  petSex,
  createShareAction,
  tier2,
  isOwner,
  isLost,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [shares, setShares] = useState<LibretaShareToken[] | null>(null);

  // Re-fetch the owner's active share links. Runs on mount AND after either
  // create surface (ShareLibretaSheet / SharesManager) reports a successful
  // generate, so "Enlaces activos" reflects the new link immediately instead
  // of staying frozen at its mount-time snapshot (staging regression O-3).
  //
  // We re-query rather than lean on revalidatePath(): this list is
  // client-fetched via a server action, not RSC props, so router.refresh() /
  // revalidatePath() never touch it (and Next 15.5's revalidatePath-in-
  // transition defect makes that path unreliable anyway).
  const refreshShares = useCallback(() => {
    if (!isOwner) return;
    getActiveLibretaSharesAction(petPublicToken).then((result) => {
      setShares(result.ok ? result.shares : []);
    });
  }, [petPublicToken, isOwner]);

  useEffect(() => {
    refreshShares();
  }, [refreshShares]);

  function handleCopyPublicLink() {
    const url = deepLinkUrl(window.location.origin, "credential", { publicToken: petPublicToken });
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function handleShareWhatsApp() {
    const url = deepLinkUrl(window.location.origin, "credential", { publicToken: petPublicToken });
    // Generic copy on purpose — see the `isLost` prop doc comment: this
    // sheet has no disclosure prefs to gate on, unlike LostShareCard. The
    // wording flexes by the pet's recorded sex (ciclo-perdido sweep fix #2).
    const text = lostShareMessage(petName, petSex);
    const waUrl = `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`;
    window.open(waUrl, "_blank", "noopener");
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <SectionHeading>Link público</SectionHeading>
        <p className="text-sm text-[var(--color-ln-ink-2)]">
          Cualquiera con este link ve la credencial pública de {petName}.
        </p>
        {/* Task #43: WhatsApp shortcut when the pet is lost — the channel
            that actually moves finder tips, ahead of the plain copy-link. */}
        {isLost && (
          <button
            type="button"
            onClick={handleShareWhatsApp}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-[var(--color-ln-ok)] px-3 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90"
          >
            <Icon name="mensaje" size="sm" decorative />
            Compartir por WhatsApp
          </button>
        )}
        <button
          type="button"
          onClick={handleCopyPublicLink}
          className="w-full rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-3 py-2 text-xs font-medium text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)]"
        >
          {copied ? "¡Copiado!" : "Copiar link público"}
        </button>
      </section>

      <hr className="border-[var(--color-ln-line)]" />

      {/* Share type 1 — private libreta link. Its "Vencimiento" (expiry) radio
          is the ONLY duration control shown by default; the Tier-2 duration is
          gated behind the expander below so the two windows are never stacked
          side by side (adversarial-citizen C2, 2026-07-06: two duration blocks
          in one panel were easy to confuse). */}
      <section className="space-y-2">
        <SectionHeading>Compartir con vencimiento</SectionHeading>
        <p className="text-sm text-[var(--color-ln-ink-2)]">
          Link privado a la libreta sanitaria — vos elegís cuándo vence.
        </p>
        <ShareLibretaSheet
          petPublicToken={petPublicToken}
          petName={petName}
          createShareAction={createShareAction}
          onShareCreated={refreshShares}
        />
      </section>

      <hr className="border-[var(--color-ln-line)]" />

      {/* Share type 2 — Tier-2 public medical view. Progressive disclosure: the
          duration radios only appear once the owner opts in (task C2). While
          Tier 2 is ACTIVE the status/revoke card renders directly (no expander)
          so the owner can see and revoke it without a hidden click. */}
      <section className="space-y-2">
        {tier2.isActive ? (
          <>
            <SectionHeading>Mostrar libreta médica (Tier 2)</SectionHeading>
            <Tier2PublicView
              petPublicToken={petPublicToken}
              petName={petName}
              isActive={tier2.isActive}
              isPermanent={tier2.isPermanent}
              activeUntil={tier2.activeUntil}
              enableAction={tier2.enableAction}
              revokeAction={tier2.revokeAction}
            />
          </>
        ) : (
          <details className="group">
            <summary className="flex cursor-pointer list-none flex-col gap-1 [&::-webkit-details-marker]:hidden">
              <span className="flex items-center gap-1.5 text-xs uppercase tracking-wider font-semibold text-[var(--color-ln-mute)]">
                <span
                  aria-hidden="true"
                  className="inline-block transition-transform group-open:rotate-90"
                >
                  ▸
                </span>
                Mostrar libreta médica (Tier 2)
              </span>
              <span className="text-sm text-[var(--color-ln-ink-2)]">
                Exponé temporalmente la info médica en el QR público. Elegí la duración al
                activarlo.
              </span>
            </summary>
            <div className="mt-3">
              <Tier2PublicView
                petPublicToken={petPublicToken}
                petName={petName}
                isActive={tier2.isActive}
                isPermanent={tier2.isPermanent}
                activeUntil={tier2.activeUntil}
                enableAction={tier2.enableAction}
                revokeAction={tier2.revokeAction}
              />
            </div>
          </details>
        )}
      </section>

      {/* ADR-14: SharesManager (active/revocable links) folded in here —
          LibretaFace lost its own copy + footer "Compartir libreta" link. */}
      {isOwner && (
        <>
          <hr className="border-[var(--color-ln-line)]" />
          <section className="space-y-2">
            <SectionHeading>Enlaces activos</SectionHeading>
            {shares === null ? (
              <p className="text-xs text-[var(--color-ln-mute)]">Cargando enlaces…</p>
            ) : (
              <SharesManager
                petPublicToken={petPublicToken}
                shares={shares}
                onShareCreated={refreshShares}
              />
            )}
          </section>
        </>
      )}
    </div>
  );
}
