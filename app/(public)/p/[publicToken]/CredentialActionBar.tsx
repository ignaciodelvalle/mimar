"use client";

// CredentialActionBar — sticky primary CTA on the public credential, mobile
// only (<sm). Cursor citizen review P3: "QR scan success needs one verb:
// contactar / reportar avistaje / llamar emergencia. Content without action
// fails in the street." The bar surfaces the RIGHT verb for the pet's state —
// it never adds a new flow, only pins an action that already exists on the
// page (or a sibling route) to the thumb zone.
//
// State → verb (all resolution happens SERVER-SIDE in page.tsx; this island
// only ever receives pre-gated, disclosure-safe props — no PII decision is
// made on the client):
//   • lost              → finder form ("La tengo conmigo") when the owner
//                         allows it, else the sighting form ("La vi cerca de
//                         acá"); plus a secondary "Llamar" when — and only
//                         when — the phone is disclosed AND no custody
//                         dispute is open (D2).
//   • active + tier 2   → "Ver resumen médico" (scroll to the streamed
//                         medical section) — low urgency, ghost treatment.
//   • active, tier 0    → NO bar (PO 2026-07-24: a sticky "¿La encontraste?"
//                         on a pet nobody is looking for invites false
//                         reports and dilutes genuinely-lost urgency — the
//                         found form stays reachable inline on the page).
//   • deceased          → page renders NO bar (memorial, no street action).
//   • custody dispute   → neutral "Tengo información sobre esta mascota"
//                         (PO 2026-07-24): opens + scrolls to the dispute-tip
//                         form, whose submission goes to the reviewing
//                         authority ONLY — never a relay to either party
//                         (D2 hardening, red-team 2026-07, still holds:
//                         no finder/sighting/phone CTA ever renders here).
//
// Plain <a> ON PURPOSE for the finder/sighting navigation (lint:hard-nav):
// one-shot anonymous finder routes must hard-navigate — a next/link soft nav
// (which LnButton's href mode renders) stalls 2-4s on this crisis path. See
// components/pet-profile/PublicLostSections.tsx. The scroll/reveal actions
// use LnButton (citizen buttons fence — no raw button elements).
//
// ≥sm the bar is hidden entirely: the desktop page keeps its inline actions.

import { Icon } from "@/components/Icon";
import { LnButton } from "@/components/ui/Button";
import { scrollIntoViewRespectingMotion } from "@/lib/ui/reduced-motion-scroll";

/** Scroll target: the Tier-2 medical section wrapper in page.tsx. */
export const MEDICAL_SECTION_ID = "resumen-medico";
/** Anchor id of the "¿Encontraste a esta mascota?" <details> in page.tsx. */
export const REPORT_SECTION_ID = "reportar-hallazgo";
/** Scroll+reveal target: the dispute-tip <details> in page.tsx (disputed pets). */
export const DISPUTE_SECTION_ID = "informacion-disputa";

export type CredentialActionBarProps =
  | {
      mode: "lost";
      /** Pre-resolved finder route: /encontre when the owner allows the finder
       * form, else /sighting. Always a valid target for a lost pet. */
      primaryHref: string;
      /** Sex-aware verb matching the in-card CTA row (foundPossessivePhrase /
       * sightingPhrase) so the bar and the card never disagree. */
      primaryLabel: string;
      /** tel: href — null unless disclosePhoneWhenLost AND no open custody
       * dispute (D2). Resolved server-side; null means "render no call CTA". */
      phoneHref: string | null;
    }
  | { mode: "medical" }
  | {
      /** Custody-disputed pet: neutral tip for the reviewing authority —
       * opens + scrolls to the dispute-tip form. Never a relay. */
      mode: "dispute";
    };

/** Open (when it's a <details>) and scroll to an in-page section. */
function revealSection(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el instanceof HTMLDetailsElement) el.open = true;
  scrollIntoViewRespectingMotion(el, { block: "start" });
}

export function CredentialActionBar(props: CredentialActionBarProps) {
  return (
    <nav
      aria-label="Acción principal"
      data-section="sticky-action-bar"
      // `no-print`: a fixed bottom bar prints on top of the credential on every
      // page. credential-print.css hides it (print-surfaces audit 2026-08-04).
      className="no-print fixed inset-x-0 bottom-0 z-40 border-t border-ln-line-strong bg-ln-card px-4 pt-3 sm:hidden"
      // Tailwind can't express the env() addition; safe-area keeps the bar
      // above the iOS home indicator (390px-first requirement).
      style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
    >
      <div className="mx-auto flex max-w-[460px] items-stretch gap-2">
        {props.mode === "lost" && (
          <>
            <a
              href={props.primaryHref}
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-ln-azul px-5 text-sm font-semibold text-white no-underline hover:bg-ln-azul-700"
            >
              <Icon name="ubicacion" size="sm" decorative />
              {props.primaryLabel}
            </a>
            {props.phoneHref && (
              <a
                href={props.phoneHref}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-ln-ok px-5 text-sm font-semibold text-white no-underline hover:bg-ln-ok/90"
              >
                <Icon name="telefono" size="sm" decorative />
                Llamar
              </a>
            )}
          </>
        )}
        {props.mode === "medical" && (
          <LnButton
            variant="ghost"
            size="lg"
            block
            className="min-h-11"
            onClick={() => revealSection(MEDICAL_SECTION_ID)}
          >
            Ver resumen médico
          </LnButton>
        )}
        {props.mode === "dispute" && (
          <LnButton
            variant="primary"
            size="lg"
            block
            className="min-h-11"
            onClick={() => revealSection(DISPUTE_SECTION_ID)}
          >
            Tengo información sobre esta mascota
          </LnButton>
        )}
      </div>
    </nav>
  );
}
