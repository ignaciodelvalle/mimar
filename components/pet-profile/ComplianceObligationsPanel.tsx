// ---------------------------------------------------------------------------
// ComplianceObligationsPanel — owner "comply-first" slice (WS-1, 2026-07-01)
// Spec: dim-interno:docs/superpowers-private/specs/2026-07-01-owner-compliance-first-slice-handoff.md §2
//
// Leads the pet profile's Resumen tab: the owner's legal obligations (rabies,
// sterilization, microchip, and — where the jurisdiction requires it — PPP
// attestation) as credential-style cards derived from the pet's events.
//
// Server component (no client JS). The antirrábica card grows a "Programar
// turno" action (por vencer / vencida) — a plain Link into the URL-driven
// intent-fork sheet — so the panel stays server-only. H1: a "Declarada · sin
// verificar" card carries a verify hint. H4: rendered as a responsive grid of
// bordered cards with a leading icon. No new color tokens (token ratchet).
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";

import { Icon } from "@/components/Icon";
import { LnBadge, type LnBadgeProps } from "@/components/ui/Badge";
import { LnLinkButton } from "@/components/ui/LinkButton";
import { LnVstamp } from "@/components/ui/StatusFlag";
import type {
  ComplianceState,
  ComplianceTone,
  ObligationCard,
  ObligationKey,
} from "@/lib/projections/pet-compliance";

// Map the semantic compliance tone onto an LnBadge variant. `reserved` (a booked
// turno) reads as informational; `neutral` is "sin registro / declarada".
const TONE_TO_BADGE: Record<ComplianceTone, NonNullable<LnBadgeProps["variant"]>> = {
  ok: "success",
  due: "warning",
  over: "danger",
  reserved: "info",
  neutral: "neutral",
};

// Leading credential icon per obligation (existing Icon.tsx names).
const ICON_FOR: Record<ObligationKey, string> = {
  rabies: "vacuna",
  sterilization: "esterilizacion",
  microchip: "microchip",
  ppp: "shield",
};

// Rabies uses the credential-style vaccine stamp where the tone maps cleanly;
// reserved / neutral fall back to LnBadge (the stamp has no such variants).
const VSTAMP_TONES = new Set<ComplianceTone>(["ok", "due", "over"]);

// Jurisdiction-tier disclosure lines (spec CS3/CS4). A `recommended` card gets
// a distinct softer treatment — the projection already clamped its tone so it
// can never carry "vencida"/overdue styling — and a `not_regulated` card is
// information only, never an obligation. Both are excluded from the
// "N de M al día" count by the projection; this line is what tells the owner
// WHY the card does not press. Noun-based phrasing so the copy stays
// gender-safe across "Vacuna antirrábica" (f) and "Microchip" (m).
// `optional` has its OWN line (T6 review MINOR 7): it used to borrow the
// `recommended` copy, so a rule the jurisdiction merely PERMITS was announced
// as a jurisdictional recommendation — a claim nobody made.
const TIER_NOTE: Record<"recommended" | "optional" | "not_regulated", string> = {
  recommended: "Recomendación de tu jurisdicción — no es una obligación legal.",
  optional: "Opcional en tu jurisdicción — no es una obligación legal.",
  not_regulated: "Solo informativo — no es una obligación en tu jurisdicción.",
};

// Currency-chip variant for the dual vaccine block (task #78 — the "0 de 4 ·
// DECLARADA" #4 fix). The chip shows the owner's REAL vaccine currency alongside
// the "registro needs a firma" nudge, so the card is dual + honest.
const CURRENCY_TO_BADGE: Record<"ok" | "due" | "over", NonNullable<LnBadgeProps["variant"]>> = {
  ok: "success",
  due: "warning",
  over: "danger",
};

/**
 * Whether this card's pill already carries what `card.detail` would repeat.
 *
 * Unified pill vocabulary (UI review, PO 2026-08-06): the pill carries the
 * DATUM, so a VIGENTE stamp says "· hasta 14/01/2027" and a verified microchip
 * row shows the chip number itself. Both of those facts USED to live only in
 * the muted `detail` line underneath ("Próxima 14/01/2027", the bare code) —
 * printing them twice, one line apart, is exactly the dedup the Cumplimiento
 * pass (PO 2026-07-18) removed everywhere else on this face.
 */
function detailIsInThePill(card: ObligationCard): boolean {
  if (card.key === "rabies") {
    return card.tone === "ok" && card.currencyKnown !== false && Boolean(card.currencyUntil);
  }
  if (card.key === "microchip") {
    return card.tone === "ok" && Boolean(card.detail);
  }
  return false;
}

/**
 * Whether the dual block's currency chip would repeat the card's own pill.
 *
 * The dual chip was added for the "0 de 4 · DECLARADA" case (task #78 #4): when
 * the main pill speaks the REGISTRY lens ("Declarada · sin verificar"), the chip
 * is the only place that states the dose's real vigencia, and it must stay.
 *
 * But when the main pill is already the vaccine-currency VSTAMP, both speak the
 * SAME lens with the SAME tone — so the card printed "VENCIDA" as its stamp and
 * "Vencida" again inside the green owner block two lines below. On a pet with a
 * single expired dose the profile said "vencida" three times in ~120px, one on
 * top of the other, plus the "Venció 11/02" line (PO 2026-08-11). Worse, the
 * repeat landed inside a green success-toned row with a check icon — a reassuring
 * container carrying an alarming chip.
 *
 * The row keeps ONE statement of currency: the stamp plus its "Venció …" date.
 */
function dualCurrencyIsInThePill(card: ObligationCard): boolean {
  if (card.key !== "rabies" || !card.dual?.currencyTone) return false;
  // Mirrors StatusBadge's branch order: `currencyKnown === false` renders the
  // "SIN DATO" stamp, which makes no currency claim, so the chip still informs.
  if (card.currencyKnown === false) return false;
  return VSTAMP_TONES.has(card.tone) && card.dual.currencyTone === card.tone;
}

function StatusBadge({ card }: { card: ObligationCard }) {
  // A dose on record with no next_due_at has UNKNOWN currency, and the stamp
  // has a variant that says so. This used to render `tone: "ok"` as "VIGENTE"
  // — a fabricated seal over "no sabemos", on the one screen whose whole
  // premise is that the document does not lie. The project had already written
  // the rule (LibretaSanitariaView.tsx:127-132) and built the variant
  // (StatusFlag.tsx "unknown" → "SIN DATO"); this panel just never asked.
  // External design review C5/#1, reproduced live: "Vacuna antirrábica
  // [VIGENTE] · Aplicada 14/01/2018".
  // A due date COMPUTED from the jurisdiction's cadence is a suggestion, not a
  // vigencia (pet-compliance `dueSource`): the vaccine stamp's words (VIGENTE /
  // POR VENCER / VENCIDA) would give it a weight no signed date backs, and SIN
  // DATO would hide the suggestion. The plain badge carries the projection's
  // own state ("Refuerzo sugerido" / "Refuerzo sugerido vencido" / "Declarada").
  if (card.key === "rabies" && card.dueSource === "rule") {
    return (
      <LnBadge variant={TONE_TO_BADGE[card.tone]} className="flex-shrink-0">
        {card.state}
      </LnBadge>
    );
  }
  if (card.key === "rabies" && card.currencyKnown === false) {
    return <LnVstamp variant="unknown" className="flex-shrink-0" />;
  }
  if (card.key === "rabies" && VSTAMP_TONES.has(card.tone)) {
    // "VIGENTE · HASTA 14/01/2027" when the next due date is on record; the
    // bare adjective when it is not (never a fabricated date). The due/over
    // stamps keep their own "Vence/Venció …" line below — only the affirmative
    // state was the one asking the reader to go looking for its expiry.
    return (
      <LnVstamp
        variant={card.tone as "ok" | "due" | "over"}
        detail={card.tone === "ok" && card.currencyUntil ? `hasta ${card.currencyUntil}` : null}
        className="flex-shrink-0"
      />
    );
  }
  // PRIVACY: the chip NUMBER is owner/professional-surface only. This panel is
  // mounted exclusively on authenticated pet surfaces (CredentialFace on
  // /mis-mascotas + the org pet read, TravelObligationsPanel) — never on /p or
  // /adoptar, where the microchip stays the boolean ("Microchip: Sí", plain
  // text, no pill) per PO-1 2026-08-05.
  if (card.key === "microchip" && card.tone === "ok" && card.detail) {
    return (
      <LnBadge variant="success" className="flex-shrink-0">
        {card.detail}
      </LnBadge>
    );
  }
  return (
    <LnBadge variant={TONE_TO_BADGE[card.tone]} className="flex-shrink-0">
      {card.state}
    </LnBadge>
  );
}

function ObligationCardView({
  card,
  petPublicToken,
  bare = false,
  pppExport = null,
}: {
  card: ObligationCard;
  petPublicToken: string;
  /** Inside the credential sheet: render as a borderless divider-separated row
   *  (no nested box) so the whole compliance section reads as one document. */
  bare?: boolean;
  /** See ComplianceObligationsPanel's `pppExport`. */
  pppExport?: ReactNode;
}) {
  const showTurnoAction = card.key === "rabies" && (card.tone === "due" || card.tone === "over");
  const isReserved = card.key === "rabies" && card.tone === "reserved";
  // PPP attestation register affordance — surfaced HERE (the canonical
  // obligation card) instead of a duplicate LnAlert row on the credential face.
  //
  // TWO STATES OPEN THIS DOOR SINCE T4-I1 / #753, and the second one is the
  // point: "Atestación requerida" (nothing on record) and "Declarada" (an
  // attestation exists but cites no inscription number and carries no
  // institutional signature, so it does not count — see
  // lib/domain/ppp-attestation.ts). That card's hint tells the person to add
  // the number, and this door is HOW they add it, since a fresh attestation
  // citing it is what clears the obligation. Leaving it shut there would print
  // an instruction with no way to follow it.
  //
  // `tone !== "ok"` and NOT a list of state literals: that is the same fact the
  // mobile owner face reads (`isAttestationDoorCard`, apps/mobile/src/pets/
  // owner-face-view-model.ts), so the two surfaces cannot drift, and a copy
  // edit to a Spanish state string cannot silently close a door on one of them.
  // "Faltan datos" (the indeterminado variant) is excluded by its own
  // `dataUnknown` flag — that dog is not yet KNOWN to be PPP, so it nudges
  // toward completing breed/weight via its hint instead.
  const showPppRegister = card.key === "ppp" && card.tone !== "ok" && !card.dataUnknown;
  // The RUPPPA export slot (L-11) belongs to a pet the regime APPLIES to — the
  // attested / attestation-required card — never to the "Faltan datos" nudge,
  // where the dog is not yet known to be PPP at all.
  const showPppExport = card.key === "ppp" && card.state !== "Faltan datos" && pppExport != null;

  return (
    <div
      data-section="compliance-card"
      data-obligation={card.key}
      className={
        bare
          ? "flex flex-col gap-2 py-3.5 first:pt-0 last:pb-0"
          : "flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-4"
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-8 flex-shrink-0 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--color-ln-celeste-100)] bg-[var(--color-ln-celeste-050)] text-[var(--color-ln-azul)]">
            <Icon name={ICON_FOR[card.key]} size="sm" decorative />
          </span>
          <p className="font-ln-sans text-md font-semibold leading-tight text-[var(--color-ln-ink)]">
            {card.label}
          </p>
        </div>
        <StatusBadge card={card} />
      </div>

      {card.detail && !detailIsInThePill(card) && (
        <p className="font-ln-mono text-xs text-[var(--color-ln-mute)]">{card.detail}</p>
      )}

      {/* DUAL honest vaccine state (task #78 / #4): what the owner HAS (dose on
          record + its currency) above what the official REGISTRY still needs (a
          matriculated vet signature) — so a declared-but-vigente vaccine stops
          reading as a flat "you have nothing" contradiction. */}
      {card.dual && (
        <div className="mt-0.5 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-ln-ok-100)] bg-[var(--color-ln-ok-050)] px-3 py-2.5">
            <Icon
              name="check"
              size="sm"
              decorative
              className="flex-shrink-0 text-[var(--color-ln-ok)]"
            />
            <span className="text-xs font-medium leading-relaxed text-[var(--color-ln-ink)]">
              {card.dual.ownerLabel}
            </span>
            {card.dual.currencyLabel &&
              card.dual.currencyTone &&
              !dualCurrencyIsInThePill(card) && (
                <LnBadge
                  variant={CURRENCY_TO_BADGE[card.dual.currencyTone]}
                  className="flex-shrink-0"
                >
                  {card.dual.currencyLabel}
                </LnBadge>
              )}
          </div>
          <p className="flex items-start gap-2 rounded-[var(--radius-lg)] border border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-025)] px-3 py-2.5 text-xs leading-relaxed text-[var(--color-ln-warn)]">
            <Icon name="info" size="sm" decorative className="mt-px flex-shrink-0" />
            <span>{card.dual.registryLine}</span>
          </p>
        </div>
      )}

      {card.requirementTier && (
        <p className="font-ln-sans text-xs italic leading-relaxed text-[var(--color-ln-mute)]">
          {TIER_NOTE[card.requirementTier]}
        </p>
      )}

      <p className="font-ln-sans text-xs leading-relaxed text-[var(--color-ln-faint)]">
        {card.legalFootnote}
      </p>

      {showTurnoAction && (
        <LnLinkButton
          href={`/mis-mascotas/${petPublicToken}?sheet=turno-antirrabica`}
          className="mt-1 w-fit"
        >
          Programar turno
        </LnLinkButton>
      )}

      {showPppRegister && (
        <LnLinkButton
          href={`/mis-mascotas/${petPublicToken}/eventos/atestar-raza-peligrosa`}
          className="mt-1 w-fit"
        >
          Registrar atestación
        </LnLinkButton>
      )}

      {showPppExport && <div data-slot="ppp-export">{pppExport}</div>}

      {isReserved && (
        <p className="mt-1 font-ln-sans text-xs text-[var(--color-ln-ink-2)]">
          Cuando el veterinario la aplique, se registra como evento y el estado pasa a Al día solo.
        </p>
      )}

      {card.hint && (
        <p className="mt-1 flex items-start gap-2 rounded-[var(--radius-lg)] border border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-025)] px-3 py-2.5 text-xs leading-relaxed text-[var(--color-ln-warn)]">
          <Icon name="info" size="sm" decorative className="mt-px flex-shrink-0" />
          <span>{card.hint}</span>
        </p>
      )}
    </div>
  );
}

// Compliance grid + summary. `bare` (used inside the credential sheet) drops
// the own outer bordered box AND renders no header at all: the sheet's labeled
// hairline divider owns the section LABEL, and the caller's summary row owns
// the "N de M al día" COUNTER (cumplimiento dedup, PO 2026-07-18 — this header
// used to repeat both, so "Estado de cumplimiento" + the counter showed twice
// or three times on one profile).
export function ComplianceObligationsPanel({
  state,
  petPublicToken,
  bare = false,
  pppExport = null,
}: {
  state: ComplianceState;
  petPublicToken: string;
  bare?: boolean;
  /**
   * The RUPPPA export affordance for the PPP card, built by the page from
   * lib/domain/ppp-export-eligibility.ts (L-11). A SLOT rather than a flag so
   * this server component never imports the server action — the caller
   * decides eligibility, this only places it. Null → nothing.
   */
  pppExport?: ReactNode;
}) {
  if (state.cards.length === 0) return null;

  // Bare (inside the sheet): borderless obligation ROWS separated by hairlines
  // — one continuous document, no card-in-card. Standalone: bordered cards.
  const grid = bare ? (
    <div className="divide-y divide-[var(--color-ln-line-2)]">
      {state.cards.map((card) => (
        <ObligationCardView
          key={card.key}
          card={card}
          petPublicToken={petPublicToken}
          bare
          pppExport={pppExport}
        />
      ))}
    </div>
  ) : (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {state.cards.map((card) => (
        <ObligationCardView
          key={card.key}
          card={card}
          petPublicToken={petPublicToken}
          pppExport={pppExport}
        />
      ))}
    </div>
  );

  if (bare) {
    return <section data-section="compliance">{grid}</section>;
  }

  const header = (
    <div className="mb-3 flex items-center justify-between gap-3">
      <div>
        <p className="font-ln-mono text-xs uppercase tracking-wide text-[var(--color-ln-mute)]">
          Cumplimiento
        </p>
        <h2 className="mt-0.5 font-ln-serif text-base font-semibold text-[var(--color-ln-ink)]">
          Estado de cumplimiento
        </h2>
      </div>
      <LnBadge variant={TONE_TO_BADGE[state.worstTone]} className="flex-shrink-0">
        {state.summary.label}
      </LnBadge>
    </div>
  );

  return (
    <section
      data-section="compliance"
      className="rounded-[var(--radius-card)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-4"
    >
      {header}
      {grid}
    </section>
  );
}
