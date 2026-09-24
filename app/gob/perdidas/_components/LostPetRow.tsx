import Link from "next/link";

import { OpCodeBadge, OpPill } from "@/components/ui/dashboard";
import type { LostPetRow as LostPetRowData } from "@/lib/analytics/govt-dashboards";
import { lostTimeLabel } from "@/lib/infra/lost-listing";
import { formatDate, speciesLabel } from "@/lib/utils/format";

type LostPetRowProps = {
  pet: LostPetRowData;
  /** CAS-XXXX-XXXX code of the pet's lost_pet_episode case, when one exists.
   *  Rendered as a link to the case detail inside the operator shell. */
  caseCode?: string;
  /**
   * PO decision 4 ("Pérdidas: ubicación legible + scope operativo",
   * 2026-07-23): true when the CURRENT view is narrowed to a single
   * operative jurisdiction (a province/locality filter active — where
   * dispatch actually happens) — see isNarrowedToOperativeJurisdiction
   * (lib/ui/view-scope-caption.ts), resolved ONCE by the page from the
   * SAME ctx/filter its queries already use. False at a national/
   * multi-province view: the row then renders WITHOUT owner-identifying
   * fields (pet + locality + days only) — presentation minimization on top
   * of the fetcher's existing scope security, not a scope change.
   */
  showOwnerDetail: boolean;
};

const STATUS_LABEL: Record<string, string> = {
  lost: "Perdida",
  active: "Activa",
  deceased: "Fallecida",
};

type PillTone = "danger" | "ok" | "neutral";

const STATUS_TONE: Record<string, PillTone> = {
  // pet-state-header R7.1 tone alignment: perdida is the ALERTA (err/red)
  // family on every surface (credential band, owner row). `open` (amber) is
  // case-workflow semantics — wrong axis for a pet's situation.
  lost: "danger",
  active: "ok",
  deceased: "neutral",
};

/** OpenStreetMap URL for a last-seen point — never rendered as visible text
 *  (that would re-expose the exact coords the legible-locality copy replaces;
 *  see the map-affordance link below). */
function osmUrl(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
}

/**
 * Legible location line (PO decision 4a, 2026-07-23): the row's PRIMARY
 * location signal is always the human-readable locality/barrio, never the
 * raw decimal coordinates — those move to a map-affordance link with no
 * coordinate numbers in its visible text. When there is no locality on file
 * but a last-seen point exists, the link itself IS the location ("ubicación
 * aproximada en el mapa"); when neither exists, say so honestly instead of
 * a bare "—, —".
 */
function LocationLine({ pet }: { pet: LostPetRowData }) {
  const hasCoords = pet.lastSeenLat != null && pet.lastSeenLng != null;

  if (pet.locality || pet.province) {
    return (
      <p className="text-sm text-ln-op-mute">
        {pet.locality ?? "—"}, {pet.province ?? "—"}
        {hasCoords && (
          <>
            {" · "}
            <a
              href={osmUrl(pet.lastSeenLat as number, pet.lastSeenLng as number)}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-ln-op-ink"
            >
              Ver en el mapa →
            </a>
          </>
        )}
      </p>
    );
  }

  if (hasCoords) {
    return (
      <p className="text-sm text-ln-op-mute">
        <a
          href={osmUrl(pet.lastSeenLat as number, pet.lastSeenLng as number)}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-ln-op-ink"
        >
          Ubicación aproximada en el mapa →
        </a>
      </p>
    );
  }

  return <p className="text-sm text-ln-op-mute">Ubicación no registrada</p>;
}

/**
 * "Perdida desde" column (queue-anatomy alignment, 2026-07-30).
 *
 * The row used to print ONLY the relative `lostTimeLabel` ("hace 3 días"), so
 * the operator could never read the actual date the pet was reported lost — and
 * two rows from the same afternoon were indistinguishable. The dominant operator
 * queue anatomy (components/ui/dashboard/CaseQueue.tsx) prints the ABSOLUTE date
 * via formatDate and carries elapsed time in a pill; this column adopts exactly
 * that pairing, so the record date is gained and the recency signal this queue
 * triages by is kept — in the shared pill primitive instead of loose grey text.
 *
 * The pill is deliberately `neutral`: elapsed time on a lost pet is a duration,
 * not a breach. There is no SLA on a pérdida, and inventing a red threshold here
 * would be new policy, not an alignment.
 */
function LostSince({ markedLostAt }: { markedLostAt: Date | null }) {
  if (!markedLostAt) return <p className="text-sm text-ln-op-mute">—</p>;
  const absolute = formatDate(markedLostAt);
  return (
    <div className="flex flex-col items-end gap-1">
      <time dateTime={markedLostAt.toISOString()} className="text-sm text-ln-op-mute tabular-nums">
        {absolute}
      </time>
      <span title={`Tiempo transcurrido desde la denuncia de pérdida (${absolute})`}>
        <OpPill tone="neutral">{lostTimeLabel(markedLostAt)}</OpPill>
      </span>
    </div>
  );
}

/**
 * Compact row for a single pet in the /gob/perdidas list panel.
 * Shows a status pill when the row is not in 'lost' status.
 *
 * `showOwnerDetail` (PO decision 4b): at a national/multi-province view the
 * row renders WITHOUT owner-identifying fields — pet + locality + days only
 * (case code, owner name, exact last-seen point, and the credential link all
 * stay hidden); the full detail row (this function's else-branch) appears
 * once the view is narrowed to a single operative jurisdiction.
 */
export function LostPetRow({ pet, caseCode, showOwnerDetail }: LostPetRowProps) {
  const statusLabel = STATUS_LABEL[pet.petStatus] ?? pet.petStatus;
  const statusTone: PillTone = STATUS_TONE[pet.petStatus] ?? "neutral";

  if (!showOwnerDetail) {
    return (
      // CSS-8: capped at 500 rows with no virtualization — content-visibility
      // skips off-screen rows.
      <li className="op-lazy-row rounded-[var(--radius-md)] border border-ln-op-line px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-md font-medium text-ln-op-ink">{pet.petName}</p>
              <OpPill tone="neutral">{speciesLabel(pet.species)}</OpPill>
              <OpPill tone={statusTone}>{statusLabel}</OpPill>
            </div>
            <p className="text-sm text-ln-op-mute">
              {pet.locality ?? "—"}, {pet.province ?? "—"}
            </p>
          </div>
          <div className="text-right whitespace-nowrap">
            <LostSince markedLostAt={pet.markedLostAt} />
          </div>
        </div>
      </li>
    );
  }

  return (
    // CSS-8: capped at 500 rows with no virtualization — content-visibility
    // skips off-screen rows.
    <li className="op-lazy-row rounded-[var(--radius-md)] border border-ln-op-line px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            {caseCode && (
              <Link
                href={`/gob/casos/${caseCode}`}
                className="no-underline"
                aria-label={`Ver caso ${caseCode}`}
              >
                <OpCodeBadge tone="blue">{caseCode}</OpCodeBadge>
              </Link>
            )}
            <p className="text-md font-medium text-ln-op-ink">{pet.petName}</p>
            <OpPill tone="neutral">{speciesLabel(pet.species)}</OpPill>
            <OpPill tone={statusTone}>{statusLabel}</OpPill>
          </div>
          <LocationLine pet={pet} />
          {pet.ownerDisplayName && (
            <p className="text-sm text-ln-op-mute">
              {"Dueño/a:"} {pet.ownerDisplayName}
            </p>
          )}
        </div>
        <div className="text-right space-y-1 whitespace-nowrap">
          <LostSince markedLostAt={pet.markedLostAt} />
          <Link
            href={`/p/${pet.petPublicToken}`}
            className="inline-block text-sm underline underline-offset-2 text-ln-op-mute hover:text-ln-op-ink"
          >
            Ver credencial
          </Link>
        </div>
      </div>
    </li>
  );
}
