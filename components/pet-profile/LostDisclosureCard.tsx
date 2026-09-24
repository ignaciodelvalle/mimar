"use client";

// LostDisclosureCard — the owner-facing surface for the 5 disclosure
// toggles that already exist on `pets`:
//   - disclose_first_name_when_lost
//   - disclose_phone_when_lost
//   - disclose_email_when_lost
//   - disclose_last_location_when_lost
//   - allow_finder_form_when_lost
//
// Toggles persist via the existing `setPetDisclosurePrefsAction` (or
// equivalent — wire by the page). Below the toggles, a small public
// preview card shows the resulting view.
//
// This intentionally duplicates the disclosure list from the existing
// MarkLostForm — once both surfaces live, that form's toggles can be
// replaced by importing this component.
//
// wave-3 D2 (design-system audit finding 2): the 5 rows used to hand-roll
// their own toggle switch (px values copied from Toggle.tsx internals),
// duplicating LnToggle's amber variant, which was purpose-built for
// disclosure/lost-mode settings per its own docblock. Now a "use client"
// component using LnToggleGroup directly — this DROPS the previous
// no-JS-required <form action={...}> submit-per-row model in favor of a
// client onChange calling `toggleAction` directly. This is safe: the LostCaseBlock
// doc comment (this component's only caller) already anticipated exactly
// this alternative ("or the action must be pre-bound and passed down as a
// prop") — `toggleAction` IS a pre-bound Server Action
// (setPetDisclosurePrefsAction.bind(null, publicToken)), fully callable
// from a client event handler. LostCaseBlock itself stays a Server
// Component (for LostScanFeed's server-only db import, unrelated to this).

import Link from "next/link";

import { Icon } from "@/components/Icon";
import { LnToggleGroup } from "@/components/ui/Toggle";
import { notifyActionError, notifySaved } from "@/lib/ui/action-feedback";

export type DisclosurePrefs = {
  discloseFirstNameWhenLost: boolean;
  disclosePhoneWhenLost: boolean;
  discloseEmailWhenLost: boolean;
  discloseLastLocationWhenLost: boolean;
  allowFinderFormWhenLost: boolean;
  /**
   * KEY 1 of the two-key public-contact model (`pets.disclose_caretaker_contact_when_lost`,
   * migration 0193). Explicitly NOT a reuse of `disclosePhoneWhenLost`: that
   * one governs the TITULAR's own number, and folding the two together would
   * mean turning your own phone on silently publishes a third party's.
   */
  discloseCaretakerContactWhenLost: boolean;
};

interface Props {
  prefs: DisclosurePrefs;
  /** Server-action bound by the page, one update per change. */
  toggleAction: (key: keyof DisclosurePrefs, next: boolean) => Promise<void>;
  /** Public credential URL — preview opens it in a new tab. */
  publicHref: string;
  /** Owner first name as it'd show on the public page. */
  ownerFirstName: string;
  /**
   * A5 (PO decision 2026-08-04) — this pet came out of a shelter, so a
   * found-pet report ALSO alerts that shelter.
   *
   * The alert is not a preference and has no toggle: the PO chose "always",
   * knowing the cost. Disclosure is the mitigation, which is why this is a
   * STATEMENT under the toggles rather than a sixth row — a row would promise a
   * choice the titular does not have. Resolved with the same predicate the
   * notifier uses (lib/infra/origin-shelter-alert.ts), so it never claims an
   * alert that will not fire.
   */
  alertsOriginShelter: boolean;
  /**
   * KEY 2 of the two-key public-contact model: the active caretaker's display
   * name when they consented at invitation accept, `null` in every other case
   * (no caretaker, or a caretaker who declined).
   *
   * NULL HIDES THE ROW ENTIRELY, and that is the whole point. A switch that
   * cannot change what the public sees is a lie in the shape of a control — the
   * titular flips it, gets "Preferencia actualizada", and the credential still
   * shows nothing, with no way to learn why. The PO accepted the cost of the
   * two-key model (a caretaker who declines cannot be published); not rendering
   * the row is how that cost is communicated.
   */
  caretakerConsentName?: string | null;
}

// Row descriptions double as the concrete preview of what the public sees
// (QA 2026-08-03: the old standalone `Hoy verán "Lo busca X"` footer line
// was easy to misread out of context — the preview now lives on the option
// it belongs to; the name row interpolates the real first name at render).
const ROWS: Array<{
  key: keyof DisclosurePrefs;
  label: string;
  description: string;
}> = [
  {
    key: "discloseFirstNameWhenLost",
    label: "Tu nombre",
    description: "El público ve quién busca a la mascota.",
  },
  {
    key: "disclosePhoneWhenLost",
    label: "Tu teléfono",
    description: "Aparece un botón directo de llamada.",
  },
  {
    key: "discloseEmailWhenLost",
    label: "Tu email",
    description: "Link mailto: en la credencial pública.",
  },
  {
    key: "discloseLastLocationWhenLost",
    label: "Última ubicación",
    description: "Muestra el mapa con el pin donde se perdió.",
  },
  {
    key: "allowFinderFormWhenLost",
    label: "Formulario de finder",
    description: "Permite avisar sin necesitar tu contacto.",
  },
];

export function LostDisclosureCard({
  prefs,
  toggleAction,
  publicHref,
  ownerFirstName,
  alertsOriginShelter,
  caretakerConsentName = null,
}: Props) {
  // The caretaker row is appended, never woven in: the five original rows keep
  // their order and their copy, so an owner with no caretaker sees exactly the
  // surface they saw before.
  const rows: typeof ROWS = caretakerConsentName
    ? [
        ...ROWS,
        {
          key: "discloseCaretakerContactWhenLost",
          label: "Contacto de tu cuidador/a",
          description: `${caretakerConsentName} aceptó que su contacto aparezca. Se muestra solo mientras dure el cuidado y la mascota esté perdida.`,
        },
      ]
    : ROWS;

  return (
    <section aria-labelledby="lp-discl-h">
      <div className="mb-3 flex items-baseline justify-between">
        <h3
          id="lp-discl-h"
          className="m-0 flex items-center gap-1.5 font-ln-serif text-md font-semibold"
          style={{ color: "var(--color-ln-ink)" }}
        >
          <span className="text-[var(--color-ln-mute)]">
            <Icon name="shield" size="sm" decorative />
          </span>
          Qué se muestra al público
        </h3>
        <Link
          href={publicHref}
          target="_blank"
          rel="noreferrer"
          className="font-ln-mono text-xs tracking-[.04em] no-underline hover:underline"
          style={{ color: "var(--color-ln-azul)" }}
        >
          Ver como público →
        </Link>
      </div>

      <LnToggleGroup
        items={rows.map((row) => ({
          key: row.key,
          label: row.label,
          description:
            row.key === "discloseFirstNameWhenLost" && prefs.discloseFirstNameWhenLost
              ? `El público ve "Lo busca ${ownerFirstName}".`
              : row.description,
          checked: prefs[row.key],
          variant: "amber",
        }))}
        onChange={(key, next) => {
          // No local optimistic state here (checked mirrors the `prefs` prop
          // directly) and toggleAction has no error surface of its own — the
          // toast is the ONLY feedback the owner gets that a toggle landed
          // (mutation-feedback convention, lib/ui/action-feedback.ts).
          toggleAction(key as keyof DisclosurePrefs, next)
            .then(() => notifySaved("Preferencia actualizada"))
            .catch(() => notifyActionError("No se pudo guardar. Probá de nuevo."));
        }}
      />

      {/* Permanence (closing report M8, 2026-08-22). The gap this closes is
          SILENCE, not an over-promise: nothing here ever claimed the data was
          unreachable, and nothing told the owner what publishing costs either.
          Turning a toggle off changes the live page instantly — and reaches
          nothing anyone already copied, screenshotted or archived.

          Always rendered, including with every toggle off: it is what the owner
          needs to read BEFORE turning one on. Plain and short on purpose — an
          alarming warning on the surface built for finding a lost dog would push
          people away from the thing that brings the dog back. */}
      <p
        data-testid="lost-disclosure-permanence"
        className="mt-3 text-xs leading-snug"
        style={{ color: "var(--color-ln-mute)" }}
      >
        Lo que publicás en la credencial es público mientras esté activo: cualquiera puede verlo,
        copiarlo o guardarlo. Si después lo apagás, la página deja de mostrarlo al instante, pero no
        podemos borrar las copias que ya se hayan hecho.
      </p>

      {/* A5 disclosure. Sober and specific: WHAT the shelter learns, and the
          limit — the finder's contact stays with the titular. Only rendered for
          pets that actually have an origin shelter, so it is never an abstract
          warning about something that cannot happen here. */}
      {alertsOriginShelter && (
        <p className="mt-3 text-xs leading-snug" style={{ color: "var(--color-ln-mute)" }}>
          Esta mascota salió de un refugio. Si alguien reporta haberla encontrado, ese refugio
          también recibe el aviso, con la zona del hallazgo. No se le comparte el contacto de quien
          la encontró: esos datos son solo para vos.
        </p>
      )}
    </section>
  );
}
