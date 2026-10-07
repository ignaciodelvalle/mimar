// The finder's plan-B list — the cards and the empty state (P4; design note
// docs/superpowers/specs/2026-10-p4-receptoras-cercanas.md §5).
//
// Renders ONLY the public-safe projection (NearbyOrgCard): a name, a type, a
// locality, a coarse distance, the capacity status and the contact the org
// chose to publish. No hooks and no server imports: both the /encontre form
// (client) and /encontre-un-animal (client island) render it.

import Link from "next/link";

import {
  INTAKE_CAPACITY_LABELS,
  type IntakeCapacityStatus,
} from "@/src/modules/organizations/domain/found-animal-intake";
import {
  NEARBY_RADIUS_KM,
  type NearbyFallback,
  type NearbyOrgCard,
} from "@/src/modules/organizations/domain/nearby-help";

const CAPACITY_TONE: Readonly<Record<IntakeCapacityStatus, string>> = {
  recibimos:
    "border-[var(--color-ln-ok-100)] bg-[var(--color-ln-ok-050)] text-[var(--color-ln-ok)]",
  consultar:
    "border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-050)] text-[var(--color-ln-warn)]",
  sin_lugar:
    "border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] text-[var(--color-ln-mute)]",
};

function capacityTone(label: string): string {
  const status = (Object.keys(INTAKE_CAPACITY_LABELS) as IntakeCapacityStatus[]).find(
    (s) => INTAKE_CAPACITY_LABELS[s] === label,
  );
  return status ? CAPACITY_TONE[status] : CAPACITY_TONE.sin_lugar;
}

function OrgCard({ card }: { card: NearbyOrgCard }) {
  return (
    <li
      className="space-y-1.5 rounded-lg border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-3"
      data-testid="nearby-org"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-[var(--color-ln-ink)]">{card.displayName}</p>
        <span className="shrink-0 text-xs text-[var(--color-ln-mute)]">{card.distanceLabel}</span>
      </div>
      <p className="text-xs text-[var(--color-ln-mute)]">
        {card.typeLabel}
        {card.locality ? ` · ${card.locality}` : ""}
      </p>
      {card.capacityLabel && (
        <span
          className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${capacityTone(card.capacityLabel)}`}
        >
          {card.capacityLabel}
        </span>
      )}
      {card.contact && (
        <p className="text-xs text-[var(--color-ln-ink-2)]">
          {card.contact.label}:{" "}
          {card.contact.href ? (
            <a
              href={card.contact.href}
              className="font-medium text-[var(--color-ln-azul)] underline underline-offset-2"
              rel="noopener noreferrer"
              target={card.contact.href.startsWith("https://") ? "_blank" : undefined}
            >
              {card.contact.value}
            </a>
          ) : (
            <span className="font-medium">{card.contact.value}</span>
          )}
        </p>
      )}
      {card.hours && <p className="text-xs text-[var(--color-ln-mute)]">Horarios: {card.hours}</p>}
      {card.profileHref && (
        <Link
          href={card.profileHref}
          className="inline-block text-xs text-[var(--color-ln-azul)] underline underline-offset-2"
        >
          Ver su perfil
        </Link>
      )}
    </li>
  );
}

/** A list of organization cards, nearest first (the order the server sent). */
export function NearbyOrgList({ cards, label }: { cards: NearbyOrgCard[]; label: string }) {
  return (
    <ul className="space-y-2" aria-label={label}>
      {cards.map((card) => (
        <OrgCard key={`${card.displayName}-${card.distanceLabel}`} card={card} />
      ))}
    </ul>
  );
}

/** Nobody receives within the radius: the jurisdiction cascade's answer. */
export function NearbyFallbackNotice({ fallback }: { fallback: NearbyFallback }) {
  const lead = `No encontramos organizaciones que reciban animales encontrados a menos de ${NEARBY_RADIUS_KM} km.`;
  return (
    <div className="space-y-2 text-sm text-[var(--color-ln-ink-2)]" data-testid="nearby-fallback">
      <p>{lead}</p>
      {fallback.kind === "municipal_service" && (
        <>
          <p>Probá con el servicio municipal de tu zona:</p>
          <NearbyOrgList cards={[fallback.card]} label="Servicio municipal" />
        </>
      )}
      {fallback.kind === "local_government" && (
        <p>
          Consultá en el área de zoonosis o de bienestar animal de{" "}
          <strong className="font-medium">{fallback.name}</strong>: suelen orientar sobre dónde
          llevar un animal encontrado.
        </p>
      )}
      {fallback.kind === "general" && (
        <p>
          Consultá en el área de zoonosis o de bienestar animal de tu municipio, o preguntá en una
          veterinaria cercana: suelen saber quién recibe animales en la zona.
        </p>
      )}
    </div>
  );
}
