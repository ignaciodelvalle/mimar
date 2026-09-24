// LostLastSeenCard — flat "Última vez visto" section for the lost-case
// block: unified section header (serif title + mono edit link, same pattern
// as LostDisclosureCard), an optional static-first map when the last-seen
// point has coordinates, and a plain-text caption. QA 2026-08-03 redesign:
// this used to render its own bordered card INSIDE an LnCard wrapper with a
// second heading, a floating "Editar" pill, an inset caption box, a share
// helper sentence and a copy-link button — boxes inside boxes, plus two more
// edit/share affordances than the block needs (LostShareCard owns sharing).
//
// When the last-seen point has GPS coordinates, a STATIC-FIRST embed
// (components/maps/StaticFirstMap) paints as a static preview and only pulls
// the maplibre-gl chunk + live tiles after the owner explicitly activates it
// (map-QOL P3). This is the OWNER surface, so the point renders at exact
// precision.
//
// Sightings are reported by finders via the public credential (/p/{token}).

import Link from "next/link";

import { Icon } from "@/components/Icon";
import { StaticFirstMap } from "@/components/maps/StaticFirstMap";
import { AR_TIME_ZONE } from "@/lib/utils/format";

interface Props {
  /** Pretty address line, e.g. "Plaza Italia". Null when never reported. */
  placeName: string | null;
  /** Municipality, e.g. "La Plata". */
  localityLabel: string | null;
  /** When the displayed location was reported (episode.lastSeenAt). */
  at: Date;
  /** Optional owner note: "Salió por la puerta del frente, llevaba collar rojo" */
  note?: string | null;
  /** Page to edit the last-seen location (LocationFields). */
  editHref: string;
  /**
   * Precise latitude (numeric string from Drizzle). When present together
   * with lastSeenLng, renders the static-first mini-map.
   */
  lastSeenLat?: string | null;
  /** Precise longitude. */
  lastSeenLng?: string | null;
}

export function LostLastSeenCard({
  placeName,
  localityLabel,
  at,
  note,
  editHref,
  lastSeenLat,
  lastSeenLng,
}: Props) {
  const lat = lastSeenLat ? Number(lastSeenLat) : null;
  const lng = lastSeenLng ? Number(lastSeenLng) : null;
  const hasCoords = lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng);
  const hasPlace = placeName !== null && placeName.trim() !== "";

  return (
    <section aria-labelledby="lp-loc-h">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3
          id="lp-loc-h"
          className="m-0 flex items-center gap-1.5 font-ln-serif text-md font-semibold"
          style={{ color: "var(--color-ln-ink)" }}
        >
          <span className="text-[var(--color-ln-mute)]">
            <Icon name="ubicacion" size="sm" decorative />
          </span>
          Última vez visto
        </h3>
        <Link
          href={editHref}
          className="font-ln-mono text-xs tracking-[.04em] no-underline hover:underline"
          style={{ color: "var(--color-ln-azul)" }}
        >
          Editar →
        </Link>
      </div>

      {hasCoords && (
        <div className="mb-2 overflow-hidden rounded-lg border border-ln-line">
          <StaticFirstMap
            lat={lat as number}
            lng={lng as number}
            label={placeName ?? "Última ubicación"}
            precision="exact"
            heightClassName="h-40"
          />
        </div>
      )}

      {hasPlace || hasCoords ? (
        <>
          <p className="m-0 text-sm text-ln-ink-2">
            <span className="font-semibold text-ln-ink">
              {placeName ?? "Punto marcado en el mapa"}
            </span>
            {localityLabel && <span className="text-ln-mute"> · {localityLabel}</span>}
            <span className="text-ln-mute"> · {formatWhen(at)}</span>
          </p>
          {note && <p className="mt-1 text-sm italic text-ln-mute">"{note}"</p>}
        </>
      ) : (
        <p className="m-0 text-sm text-ln-mute">
          Todavía no cargaste dónde se perdió.{" "}
          <Link
            href={editHref}
            className="font-medium text-[var(--color-ln-azul)] no-underline hover:underline"
          >
            Agregar ubicación
          </Link>
        </p>
      )}
    </section>
  );
}

function formatWhen(d: Date): string {
  return d.toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: AR_TIME_ZONE,
  });
}
