// Two page-local banners, moved out of
// app/(app)/mis-mascotas/[publicToken]/page.tsx — VERBATIM, no behaviour
// change (custodia-temporal C9, 2026-08-20).
//
// WHY THEY MOVED. The profile page crossed the 1500-line fence when the
// caretaker cockpit landed. These two were the honest thing to cut: they are
// presentational components with no page state, they already sit inside
// <PetAlertStrip> alongside LostCaseBlock and PregnancyInProgressCard — both of
// which live in this directory — and the page's own header calls them
// "PRESERVED", i.e. carried along by a redesign rather than owned by it.
//
// They keep their docblocks word for word. The rabies one in particular records
// a PO decision (2026-08-17) about a button that must never come back; that
// paragraph is the reason the component looks under-powered, and losing it in a
// move would invite someone to "fix" it.

import Link from "next/link";

import { formatDateShort, pluralizeEs } from "@/lib/utils/format";
import { resolveObservationWindowDays } from "@/src/modules/surveillance/domain/rabies-observation";

import { ConvertFosterButton } from "@/app/(app)/mis-mascotas/[publicToken]/_components/ConvertFosterButton";

// ---------------------------------------------------------------------------
// Banners — PRESERVED
// ---------------------------------------------------------------------------

type RabiesObservationBannerProps = {
  pet: { name: string; publicToken: string };
  events: Array<{ id: string; eventType: string; occurredAt: Date | string; payload: unknown }>;
  /**
   * Display name of the organization that opened the observation, when a THIRD
   * PARTY opened it (D1). Null/undefined for an owner-reported bite — the
   * banner then names nobody rather than inventing an opener.
   */
  openedByOrgName?: string | null;
};

/**
 * Owner-facing observation banner.
 *
 * 2026-08-17: the "Confirmar fin de observación" button is GONE. It called
 * ownerCloseRabiesObservationAction, which wrote outcome='negative' on the
 * State's own record — an owner declaring that the animal which bit somebody was
 * clinically clear, gated only on the window having elapsed and on that same
 * owner not having self-reported a symptom. What replaces it is not another
 * button: it is the truth that the owner cannot close this, and the instruction
 * for who can (PO decision, engram roadmap/decisiones-legales-flujos-2026-08-17).
 *
 * The window is read from the started event's `observation_days` (the value
 * actually resolved for this jurisdiction). Older observations have no such
 * field, and the copy then quotes only the deadline DATE rather than inventing
 * the national 10.
 *
 * 2026-08-23 (D1): "you cannot close this, here is who can" used to render ONLY
 * once the window had elapsed. That put the sentence on day 11 of a 10-day
 * observation — while the day someone disputes an observation opened in error
 * is day 1. The PO ruled out an in-product dispute channel on the explicit
 * condition that the owner can SEE where they stand; so the sentence now shows
 * for the whole observation, and the reporting organization is named when a
 * third party opened it. This banner deliberately carries no control: naming
 * the opener is the route out, and the route runs outside the product.
 */
export function RabiesObservationBanner({
  pet,
  events,
  openedByOrgName,
}: RabiesObservationBannerProps) {
  const startedEvent = events.find((e) => e.eventType === "rabies_observation_started");
  const startedPayload = (startedEvent?.payload ?? {}) as Record<string, unknown>;
  const observationUntilRaw = startedPayload.observation_until as string | undefined;
  const observationUntil = observationUntilRaw ? new Date(observationUntilRaw) : null;
  const windowDays = resolveObservationWindowDays(startedPayload.observation_days);

  const biteEvent = events.find(
    (e) =>
      e.eventType === "incident_reported" &&
      (e.payload as Record<string, unknown> | null)?.incident_type === "bite_inflicted",
  );
  const biteDate = biteEvent ? new Date(biteEvent.occurredAt) : null;

  const periodClosed =
    observationUntil !== null &&
    Number.isFinite(observationUntil.getTime()) &&
    observationUntil <= new Date();

  return (
    <section className="rounded-[var(--radius-sm)] border border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-050)] px-4 py-3.5 space-y-[10px]">
      <p className="font-semibold text-md text-[var(--color-ln-warn)]">Vigilancia por mordedura</p>
      <p className="text-md text-[var(--color-ln-warn)]">
        {biteDate
          ? `Por la mordedura del ${formatDateShort(biteDate)}, `
          : "Por una mordedura reportada recientemente, "}
        {pet.name} está en observación obligatoria
        {windowDays === null ? "" : ` de ${windowDays} ${pluralizeEs(windowDays, "día")}`}.
        {observationUntil && ` Cierre estimado: ${formatDateShort(observationUntil)}.`}
      </p>
      <p className="text-sm text-[var(--color-ln-warn)]">
        Si {pet.name} muestra salivación excesiva, agresividad inusual, parálisis o cambios bruscos
        de comportamiento, consultá al veterinario de inmediato.
      </p>
      {openedByOrgName && (
        <p className="text-sm text-[var(--color-ln-warn)]">
          La mordedura la reportó <strong>{openedByOrgName}</strong>. Si discrepás con el reporte,
          planteáselo a esa organización o a la autoridad sanitaria de tu municipio.
        </p>
      )}
      <p className="text-sm text-[var(--color-ln-warn)]">
        {periodClosed ? "El período ya se cumplió. El cierre" : "El cierre de la observación"} lo
        registra un veterinario matriculado o la autoridad sanitaria de tu localidad: no podés
        cerrarla vos, porque el resultado de la observación es un dato clínico.
        {periodClosed ? " Pedíselo a tu veterinario o a la autoridad sanitaria." : ""}
      </p>
    </section>
  );
}

/**
 * The titular's adoption sponsorship, on the credential (rehome-by-titular
 * WU5, task 5.8). Rendered only for a PENDING request or an ACTIVE
 * sponsorship — the page gates the push on the state, so an empty node never
 * adds a divider to the alert strip. Both lead to the one surface where the
 * titular acts (/buscar-hogar); nothing here is a control.
 */
export function RehomeSponsorshipBanner({
  petName,
  petPublicToken,
  state,
}: {
  petName: string;
  petPublicToken: string;
  state: { kind: "pending"; orgDisplayName: string } | { kind: "active"; orgDisplayName: string };
}) {
  return (
    <section className="rounded-[var(--radius-sm)] border border-[var(--color-ln-celeste-100)] bg-[var(--color-ln-celeste-050)] px-4 py-3.5 space-y-[10px]">
      <p className="text-md text-[var(--color-ln-ink-2)]">
        {state.kind === "pending" ? (
          <>
            Le pediste a <strong>{state.orgDisplayName}</strong> que acompañe la adopción de{" "}
            {petName}. Todavía no respondió; mientras tanto nada cambia.
          </>
        ) : (
          <>
            <strong>{state.orgDisplayName}</strong> acompaña la adopción de {petName}. Sigue
            viviendo con vos; podés dar de baja el acompañamiento cuando quieras.
          </>
        )}
      </p>
      <Link
        href={`/mis-mascotas/${petPublicToken}/buscar-hogar`}
        className="inline-block rounded-[var(--radius-sm)] border border-[var(--color-ln-celeste-100)] px-2.5 py-1.5 text-md text-[var(--color-ln-azul)] no-underline hover:bg-white transition-colors"
      >
        {state.kind === "pending" ? "Ver el pedido" : "Ver el acompañamiento"}
      </Link>
    </section>
  );
}

export function TransitBanner({
  petName,
  petPublicToken,
  canManageFosterActions,
}: {
  petName: string;
  petPublicToken: string;
  /** True only for an org-linked `role='foster'` row — see call site. */
  canManageFosterActions: boolean;
}) {
  return (
    <section className="rounded-[var(--radius-sm)] border border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-050)] px-4 py-3.5 space-y-[10px]">
      <p className="text-md text-[var(--color-ln-warn)]">
        Estás cuidando a <strong>{petName}</strong> en tránsito. La libreta sanitaria que armes acá
        viaja con la mascota.
      </p>
      {canManageFosterActions && (
        <div className="flex flex-wrap gap-2">
          <ConvertFosterButton petPublicToken={petPublicToken} petName={petName} />
          <Link
            href={`/mis-mascotas/${petPublicToken}/buscar-hogar`}
            className="rounded-[var(--radius-sm)] border border-[var(--color-ln-warn-100)] px-2.5 py-1.5 text-md text-[var(--color-ln-warn)] no-underline hover:bg-white transition-colors"
          >
            Buscar nuevo hogar
          </Link>
        </div>
      )}
    </section>
  );
}
