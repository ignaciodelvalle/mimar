"use client";

// Board view for the animal pipeline (Wave 3 Item 18).
//
// Renders PetCardData grouped into ordered pipeline columns derived from
// custody states already modeled in the DB. Cards are read-only in v1;
// clicking a card navigates to the pet profile. Draggable cards deferred to v2.
//
// Intentionally receives the same props as OrgMascotasBulkList so the parent
// can switch views without re-fetching data.

import Link from "next/link";

import { groupIntoPipelineColumns } from "@/lib/infra/pet-pipeline";
import { pluralizeEs, speciesLabel } from "@/lib/utils/format";
import type { PetCardData } from "./OrgMascotasBulkList";

// ─── Column color palette ─────────────────────────────────────────────────────
// Each column gets a distinct visual identity to orient staff quickly.
// Colors use design tokens only — no arbitrary hex (lint:tokens).

type ColumnStyle = {
  header: string;
  headerText: string;
  border: string;
  bg: string;
  countBadge: string;
};

const COLUMN_STYLES: Record<string, ColumnStyle> = {
  ingreso: {
    header: "bg-ln-op-stripe",
    headerText: "text-ln-op-ink-2",
    border: "border-ln-op-line",
    bg: "bg-ln-op-page",
    countBadge: "bg-ln-op-line text-ln-op-mute",
  },
  evaluacion: {
    header: "bg-ln-op-warn-bg",
    headerText: "text-ln-op-warn",
    border: "border-ln-op-warn-bd",
    bg: "bg-ln-op-page",
    countBadge: "bg-ln-op-warn-bg text-ln-op-warn",
  },
  disponible: {
    header: "bg-ln-op-ok-bg",
    headerText: "text-ln-op-ok",
    border: "border-ln-op-ok-bd",
    bg: "bg-ln-op-page",
    countBadge: "bg-ln-op-ok-bg text-ln-op-ok",
  },
  en_adopcion: {
    header: "bg-ln-op-viol-bg",
    headerText: "text-ln-op-viol",
    border: "border-ln-op-viol-bd",
    bg: "bg-ln-op-page",
    countBadge: "bg-ln-op-viol-bg text-ln-op-viol",
  },
  transito: {
    header: "bg-ln-op-blue-bg",
    headerText: "text-ln-op-azul",
    border: "border-ln-op-blue-bd",
    bg: "bg-ln-op-page",
    countBadge: "bg-ln-op-blue-bg text-ln-op-azul",
  },
  otros: {
    header: "bg-ln-op-stripe",
    headerText: "text-ln-op-mute",
    border: "border-ln-op-line",
    bg: "bg-ln-op-page",
    countBadge: "bg-ln-op-line text-ln-op-mute",
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Species labels come from the shared es-AR map (@/lib/utils/format) so the
// board covers every species (conejo/cobayo/hurón) instead of leaking the raw
// English enum through a local, incomplete dog/cat/other map.

function calcAge(dob: string): string {
  const birth = new Date(dob);
  const now = new Date();
  const months =
    (now.getFullYear() - birth.getFullYear()) * 12 + (now.getMonth() - birth.getMonth());
  if (months < 12) return `${Math.max(0, months)}m`;
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  return remMonths === 0 ? `${years}a` : `${years}a${remMonths}m`;
}

// ─── Card ─────────────────────────────────────────────────────────────────────

function PipelineCard({
  card,
  orgToken,
}: {
  card: PetCardData;
  orgToken: string;
}) {
  const ageInfo = card.dateOfBirth
    ? `${card.birthDateIsEstimated ? "~" : ""}${calcAge(card.dateOfBirth)}`
    : null;

  return (
    <Link
      href={`/mis-mascotas/${card.publicToken}`}
      className={[
        "block rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-3 space-y-1",
        "hover:border-ln-op-azul hover:shadow-sm transition-shadow",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ln-op-azul",
      ].join(" ")}
      aria-label={`Ver perfil de ${card.name}`}
    >
      <p className="text-md font-semibold text-ln-op-ink truncate">{card.name}</p>
      <p className="text-sm text-ln-op-mute truncate">
        {speciesLabel(card.species)}
        {card.breed ? ` · ${card.breed}` : ""}
        {ageInfo ? ` · ${ageInfo}` : ""}
      </p>
      <p className="text-xs text-ln-op-mute font-ln-mono truncate">{card.publicToken}</p>
    </Link>
  );
}

// ─── Column ───────────────────────────────────────────────────────────────────

function PipelineColumn({
  label,
  columnKey,
  cards,
  orgToken,
}: {
  label: string;
  columnKey: string;
  cards: PetCardData[];
  orgToken: string;
}) {
  const style = COLUMN_STYLES[columnKey] ?? COLUMN_STYLES.ingreso;

  return (
    <section
      aria-label={`Columna ${label}`}
      className={[
        "flex flex-col rounded-[var(--radius-lg)] border min-w-[220px] max-w-[260px] flex-shrink-0 overflow-hidden",
        style.border,
      ].join(" ")}
    >
      {/* Column header */}
      <div
        className={[
          "flex items-center justify-between px-3 py-2 border-b",
          style.header,
          style.border,
        ].join(" ")}
      >
        <h2 className={`text-sm font-bold uppercase tracking-wider ${style.headerText}`}>
          {label}
        </h2>
        <span
          className={`text-xs font-ln-mono font-bold px-1.5 py-px rounded-full ${style.countBadge}`}
          aria-label={`${cards.length} ${pluralizeEs(cards.length, "animal")}`}
        >
          {cards.length}
        </span>
      </div>

      {/* Card list — scrollable when many animals */}
      <ul
        className={["flex-1 overflow-y-auto p-2 space-y-2 max-h-[70vh]", style.bg].join(" ")}
        aria-label={`Animales en ${label}`}
      >
        {cards.length === 0 ? (
          <li className="text-sm text-ln-op-mute text-center py-4 italic list-none">
            Sin animales
          </li>
        ) : (
          cards.map((card) => (
            <li key={card.petId} className="list-none">
              <PipelineCard card={card} orgToken={orgToken} />
            </li>
          ))
        )}
      </ul>
    </section>
  );
}

// ─── Board ────────────────────────────────────────────────────────────────────

type Props = {
  cards: PetCardData[];
  fosteredPetIds: string[];
  orgToken: string;
};

/**
 * OrgMascotasPipelineBoard — board view for the mascotas page.
 *
 * Groups PetCardData into pipeline columns derived from existing custody states.
 * Receives the same cards/fosteredPetIds as OrgMascotasBulkList for zero
 * additional data-fetching on toggle.
 *
 * v1: read-only columns; click navigates to pet profile.
 * v2 (deferred): draggable cards to move between columns.
 */
export function OrgMascotasPipelineBoard({ cards, fosteredPetIds, orgToken }: Props) {
  const fosteredSet = new Set(fosteredPetIds);
  const columns = groupIntoPipelineColumns(cards, fosteredSet);

  if (cards.length === 0) {
    return (
      <p className="text-md text-ln-op-mute">
        Todavía no hay animales registrados a nombre de la organización.
      </p>
    );
  }

  return (
    <section
      className="flex gap-3 overflow-x-auto pb-4"
      aria-label="Tablero de pipeline de animales"
    >
      {columns.map((col) => (
        <PipelineColumn
          key={col.key}
          label={col.label}
          columnKey={col.key}
          cards={col.cards}
          orgToken={orgToken}
        />
      ))}
    </section>
  );
}
