// Street actions under the public credential — never inside the paper.
// Same law as the owner PetActionRow (PO 2026-10-01): the card is the animal;
// the verbs sit below it.
//
//   active   → one tile that opens the found form
//   lost     → Lo tengo (heavier) · Lo vi · Llamar; email / caretaker as lines
//   dispute  → only "Tengo información" (authority, never a relay), with the
//              routing notice VISIBLE, not folded inside the closed details
//   deceased → nothing (memorial)
//
// Two honest lines ride with the lost row (restored 2026-10-06 — the redesign
// dropped them with their tests; they lived in PublicLostSections on main):
//   - phone hidden but an aviso path exists → say WHY there is no "Llamar"
//     and point at the avisos. Rendered on the null-phone prop, so it never
//     reveals whether a phone EXISTS, only that we do not show one.
//   - no phone, no email, no finder form, no sighting form → say there is no
//     channel, instead of an empty row. A disputed pet never reaches the lost
//     mode (the page sends it to `dispute`), so this cannot mislead there.

import { Icon } from "@/components/Icon";
import { DISPUTE_TIP_INTRO } from "@/lib/ui/dispute-copy";

export const PHONE_PRIVACY_NOTE =
  "Por privacidad no mostramos el teléfono del dueño: completá uno de estos avisos y le llega al instante.";
export const NO_CHANNELS_WARNING = "Esta mascota no tiene canales de contacto habilitados.";
import { foundPossessivePhrase, normalizePhoneForTel, sightingPhrase } from "@/lib/utils/format";

import { DISPUTE_SECTION_ID, REPORT_SECTION_ID } from "./CredentialActionBar";
import { DisputeTipForm } from "./DisputeTipForm";
import { FoundPetForm } from "./FoundPetForm";

function foundTileLabel(sex: string | null): string {
  if (sex === "male") return "¿Lo encontraste?";
  if (sex === "female") return "¿La encontraste?";
  return "¿Encontraste a esta mascota?";
}

export type PublicCredentialActionsProps =
  | { mode: "found"; publicToken: string; petSex: string | null }
  | {
      mode: "lost";
      petSex: string | null;
      finderFormHref: string | null;
      sightingFormHref: string | null;
      ownerPhoneE164: string | null;
      ownerEmail: string | null;
      ownerFirstName: string | null;
      caretakerContact: { firstName: string | null; phoneE164: string | null } | null;
    }
  | { mode: "dispute"; publicToken: string };

export function PublicCredentialActions(props: PublicCredentialActionsProps) {
  if (props.mode === "found") {
    return (
      <details id={REPORT_SECTION_ID} className="group mt-3 scroll-mt-24 no-print">
        <summary className="ln-act list-none">
          <Icon name="ubicacion" size="sm" decorative />
          {foundTileLabel(props.petSex)}
        </summary>
        <div className="mt-3">
          <FoundPetForm publicToken={props.publicToken} />
        </div>
      </details>
    );
  }

  if (props.mode === "dispute") {
    return (
      <div data-section="found-form-disputed" className="mt-3 no-print">
        {/* Visible BEFORE the finder opens anything: where the message lands
            is the one thing they must know (PO 2026-07-30, dispute-copy.ts). */}
        <p data-section="lost-custody-dispute-notice" className="mb-2 text-sm text-ln-ink-2">
          {DISPUTE_TIP_INTRO}
        </p>
        <details id={DISPUTE_SECTION_ID} className="group scroll-mt-24">
          <summary className="ln-act list-none">
            <Icon name="ubicacion" size="sm" decorative />
            Tengo información
          </summary>
          <div className="mt-3">
            <DisputeTipForm publicToken={props.publicToken} />
          </div>
        </details>
      </div>
    );
  }

  const phoneHref = props.ownerPhoneE164
    ? `tel:${normalizePhoneForTel(props.ownerPhoneE164) ?? props.ownerPhoneE164}`
    : null;
  const caretakerTel = props.caretakerContact?.phoneE164
    ? `tel:${normalizePhoneForTel(props.caretakerContact.phoneE164) ?? props.caretakerContact.phoneE164}`
    : null;
  const hasAvisoPath = Boolean(props.finderFormHref || props.sightingFormHref);
  const hasTiles = Boolean(hasAvisoPath || phoneHref);
  const hasNoChannel = !hasTiles && !props.ownerEmail && !caretakerTel;

  return (
    <div data-section="public-actions" className="no-print">
      {hasTiles ? (
        <div data-section="lost-cta-row" className="ln-actionbar mt-3">
          {props.finderFormHref && (
            <a href={props.finderFormHref} className="ln-act ln-act--primary">
              <Icon name="ubicacion" size="sm" decorative />
              {foundPossessivePhrase(props.petSex)}
            </a>
          )}
          {props.sightingFormHref && (
            <a href={props.sightingFormHref} className="ln-act">
              <Icon name="ojo" size="sm" decorative />
              {sightingPhrase(props.petSex)}
            </a>
          )}
          {phoneHref && (
            <a href={phoneHref} className="ln-act">
              <Icon name="telefono" size="sm" decorative />
              Llamar
            </a>
          )}
        </div>
      ) : null}
      {!props.ownerPhoneE164 && hasAvisoPath ? (
        <p data-section="lost-phone-privacy-note" className="mt-2 text-xs text-ln-ink-2">
          {PHONE_PRIVACY_NOTE}
        </p>
      ) : null}
      {hasNoChannel ? (
        <p
          data-section="lost-no-channels"
          className="mt-3 rounded-lg bg-[var(--color-ln-warn-050)] px-3 py-2 text-xs text-ln-warn"
        >
          {NO_CHANNELS_WARNING}
        </p>
      ) : null}
      {props.ownerEmail && (
        <p className="mt-2 text-sm text-ln-ink-2">
          <a
            href={`mailto:${props.ownerEmail}`}
            className="text-ln-ink-2 underline-offset-2 hover:underline"
          >
            {props.ownerFirstName ? `Escribirle a ${props.ownerFirstName}` : "Escribir por email"}
          </a>
        </p>
      )}
      {caretakerTel && (
        <p className="mt-2 text-sm text-ln-ink-2">
          <a
            href={caretakerTel}
            data-section="lost-caretaker-call"
            className="text-ln-ink-2 underline-offset-2 hover:underline"
          >
            Llamar a {props.caretakerContact?.firstName ?? "quien la cuida"}
          </a>
        </p>
      )}
    </div>
  );
}
