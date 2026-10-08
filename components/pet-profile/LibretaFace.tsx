"use client";

// LibretaFace — Face 2 of the pet profile's two-face redesign (client).
// pet-document-redesign ADR-10: ONE consolidated timeline, no lens chips.
// Owners see everything; org/vet viewers see only the libreta-sanitaria
// whitelist (the audience predicate — see libreta-lens.ts). Renders the
// PRÓXIMO future ledger, a "— hoy —" divider, then past events (reusing
// EventTimelineList so H3 curated detail + provenance/amendment badges
// render verbatim). VacunasStatusBadges is always on (ADR-10). Share
// management moved out entirely (ADR-14) — see MergedShareSheet
// (`?sheet=compartir`); this face keeps the immutability note, a compact
// owner-only Emergencia block (wave-3 P3, PO decision #645 point 3 — moved
// off CredentialFace), and the keepsake ExportLibretaButton in its footer.

import Link from "next/link";

import { Icon } from "@/components/Icon";
import { AsientoCard } from "@/components/pet-profile/AsientoCard";
import { ExportLibretaButton } from "@/components/pet-profile/ExportLibretaButton";
import { FutureLedgerList } from "@/components/pet-profile/FutureLedgerList";
import { LibretaFilterChips } from "@/components/pet-profile/LibretaFilterChips";
import { SheetTriggerLink } from "@/components/pet-profile/SheetTriggerLink";
import { VacunasStatusBadges } from "@/components/pet-profile/VacunasStatusBadges";
import type {
  ResolvedEmergencyContacts,
  ResolvedEmergencyPair,
} from "@/lib/domain/emergency-contacts";
import { libretaChipCounts } from "@/lib/infra/libreta-sanitaria";
import type { LibretaFaceData } from "@/src/modules/pets/application/tab-data/types";
import { useState } from "react";
import {
  collapseTripPaperTicks,
  toAsientoView,
  tripPapersContext,
  tripPapersGroupLabel,
  tripPapersTickKey,
  tripPapersTickLabel,
} from "./asiento-fields";
import { pastEventMatchesAudience } from "./libreta-lens";
import { groupPastByVisit } from "./libreta-visit-groups";

// Resolved pet-level-override-with-account-fallback contacts (owner-ia-redesign
// P2). Resolution happens in the RSC (lib/domain/emergency-contacts.ts); this
// face just renders each row and labels it "de tu cuenta" when it fell back.
export type LibretaFaceEmergencyContacts = ResolvedEmergencyContacts;

type Props = {
  data: LibretaFaceData;
  petPublicToken: string;
  /**
   * Owners see the full consolidated timeline; org/vet viewers see only the
   * libreta-sanitaria-relevant subset (ADR-10). No user-facing toggle.
   */
  isOwner: boolean;
  /**
   * Owner-only vet/emergency contact rows. `null`/`undefined` (org viewers,
   * or a fetch that yielded no profile row) renders no Emergencia block at
   * all — pass an object (even with every field `null`) to show the "Agregar
   * datos de emergencia" prompt for an owner who hasn't filled these in yet.
   */
  emergencyContacts?: LibretaFaceEmergencyContacts | null;
};

export function LibretaFace({ data, petPublicToken, isOwner, emergencyContacts }: Props) {
  const audience = isOwner ? "owner" : "org";

  // Future items are never filtered by audience (matches the old lens
  // system's behavior for both "todo" and "oficial" — only the removed
  // "vacunas" lens filtered future items).
  const future = data.future;
  const past = data.past.filter((row) => pastEventMatchesAudience(row.eventType, audience));

  // Per-type narrowing of the ONE consolidated timeline (B3 redefined). The
  // chips are derived from `past` AFTER the audience filter, so an org viewer
  // never sees a chip for a category the lens already removed, and a selection
  // can never resolve to zero rows. See LibretaFilterChips for the full
  // rationale (why not all 14, why the count is on the chip, why no empty
  // state). No new query: every row already carries `eventType`.
  const [selectedTypes, setSelectedTypes] = useState<ReadonlySet<string>>(() => new Set<string>());
  const chipCounts = libretaChipCounts(past);
  const visiblePast =
    selectedTypes.size === 0 ? past : past.filter((row) => selectedTypes.has(row.eventType));

  function toggleType(type: string) {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  const isEmpty = future.length === 0 && past.length === 0;
  // Compute `now` ONCE at mount and thread the SAME value into every relative
  // renderer (toAsientoView → formatRelative). A bare `const now = new Date()`
  // recomputes on every re-render (e.g. a ?tab= change re-renders this face),
  // so a card sitting on a day boundary could silently flip "hace 2 días" →
  // "hace 3 días" between renders. Freezing it with a lazy useState makes the
  // face's relative labels deterministic for the mount's lifetime and keeps
  // the initial render pure (the F1 `now`-subclass residual: the initial tree
  // must not depend on a value that drifts between renders). The absolute
  // dates are already tz-pinned (AR_TIME_ZONE) for the sibling #418 subclass.
  const [now] = useState(() => new Date());
  // From the WHOLE read, not the chip-filtered slice: a papers tick names its
  // trip even when the "Viaje" rows are filtered out of view.
  const trips = tripPapersContext(data.past);
  // `title` overrides the projection's own — only a collapsed run of papers
  // ticks passes one ("… · 3 cambios · Chile").
  const renderAsiento = (row: (typeof visiblePast)[number], title?: string) => (
    <AsientoCard
      key={row.id}
      view={{
        ...toAsientoView(row, petPublicToken, data.viewer, now, trips),
        ...(title === undefined ? {} : { title }),
      }}
      eventHref={`/mis-mascotas/${petPublicToken}/eventos/${row.id}`}
      // A weight asiento's sparkline shows the TRAILING 12-MONTH
      // curve ending at its own date — every weigh-in in the year
      // before this record (chronological), not just prev+current,
      // and never future weigh-ins the owner logged later (a past
      // record must not depend on data that didn't exist yet).
      weightSamples={
        row.eventType === "weight_recorded"
          ? data.weightSamples.filter((s) => {
              const t = s.date.getTime();
              const end = new Date(row.occurredAt).getTime();
              return t <= end && t >= end - 365 * 86_400_000;
            })
          : undefined
      }
    />
  );

  return (
    <div className="ln-sec">
      {/* Libreta head — name + token only. Species/sex already live on the
          front under the name; repeating "perro · hembra" here crowded the
          dorso without adding a fact the reader lacked. */}
      <div className="ln-lib-head">
        <h2>{data.identity.name}</h2>
        <span className="ln-lib-code">{data.identity.publicToken}</span>
      </div>

      <div className="mt-4">
        <VacunasStatusBadges summary={data.summary} />
      </div>

      {isEmpty ? (
        <p className="mt-5 text-sm text-[var(--color-ln-mute)]">
          Sin eventos ni cuidados programados todavía.
        </p>
      ) : (
        <>
          {future.length > 0 && (
            <div className="mt-1">
              <FutureLedgerList items={future} petPublicToken={petPublicToken} />
            </div>
          )}

          {future.length > 0 && past.length > 0 && (
            // Directional "hoy" divider: a bare "— hoy —" read as a date tag for
            // the future item directly above it (QA round 2 2026-07-03 #7: a
            // 2027 reminder appeared labeled "HOY"). Arrows disambiguate which
            // side is upcoming and which is history.
            <div className="ln-hoy">próximo ↑ · hoy · historia ↓</div>
          )}

          {past.length > 0 && (
            <>
              <div className="ln-ledlbl">
                Asientos · {visiblePast.length}{" "}
                {visiblePast.length === 1 ? "registro" : "registros"}
              </div>
              <LibretaFilterChips
                counts={chipCounts}
                totalCount={past.length}
                selected={selectedTypes}
                onToggle={toggleType}
                onClear={() => setSelectedTypes(new Set<string>())}
              />
              <div className="ln-asientos">
                {/* vet-visit-record: the records one vet wrote in one atención
                    read as one block, titled "Atención · fecha · modalidad";
                    everything else renders one by one, as before. */}
                {/* Trip papers ticks: consecutive "Lo tengo" ticks of one
                    trip on one day draw as ONE row (presentation only — each
                    tick is still its own event). See asiento-fields.ts. */}
                {collapseTripPaperTicks(groupPastByVisit(visiblePast, data.visits), (entry) =>
                  entry.kind === "event" ? tripPapersTickKey(entry.row, trips) : null,
                ).map((collapsed) => {
                  if (collapsed.kind === "papers") {
                    const head = collapsed.entries[0];
                    if (head?.kind !== "event") return null;
                    const target = (head.row.payload as { target_event_id?: string } | null)
                      ?.target_event_id;
                    const country = target ? (trips.get(target)?.country ?? null) : null;
                    const ticks = collapsed.entries.flatMap((e) =>
                      e.kind === "event" ? [e.row] : [],
                    );
                    // Drawn as one row, but EVERY tick keeps its door: the
                    // disclosure lists each one's own detail page.
                    return (
                      <div key={`papers-${head.row.id}`} data-section="libreta-papeles">
                        {renderAsiento(head.row, tripPapersGroupLabel(ticks.length, country))}
                        <details className="px-1 pb-2 text-sm">
                          <summary className="cursor-pointer font-semibold text-[var(--color-ln-azul)]">
                            Ver cada cambio
                          </summary>
                          <ul className="mt-1 space-y-1">
                            {ticks.map((row, i) => (
                              <li key={row.id}>
                                <Link
                                  href={`/mis-mascotas/${petPublicToken}/eventos/${row.id}`}
                                  prefetch={false}
                                  className="text-[var(--color-ln-azul)] no-underline hover:underline"
                                >
                                  {tripPapersTickLabel(i, ticks.length)} →
                                </Link>
                              </li>
                            ))}
                          </ul>
                        </details>
                      </div>
                    );
                  }
                  const entry = collapsed.entry;
                  return entry.kind === "event" ? (
                    renderAsiento(entry.row)
                  ) : (
                    <section
                      key={`visit-${entry.visitId}`}
                      aria-label={entry.header}
                      data-section="libreta-atencion"
                      className="ln-atencion"
                    >
                      <p className="px-1 font-ln-mono text-xs uppercase tracking-[.06em] text-[var(--color-ln-mute)]">
                        {entry.header}
                      </p>
                      {entry.rows.map((row) => renderAsiento(row))}
                    </section>
                  );
                })}
              </div>
            </>
          )}

          {data.pastTruncated && (
            // perf/scale review 2026-07-04 — `past` is bounded (PAST_EVENTS_WINDOW)
            // for long-lived pets; this note keeps that cap honest instead of
            // silently hiding older history.
            <p className="mt-3 text-xs text-[var(--color-ln-mute)]">
              Mostrando los eventos más recientes. Imprimí la libreta completa para ver todo el
              historial.
            </p>
          )}
        </>
      )}

      {emergencyContacts && (
        <div className="mt-5">
          <EmergenciaBlock contacts={emergencyContacts} petPublicToken={petPublicToken} />
        </div>
      )}

      <footer className="ln-libfoot font-ln-mono text-xs uppercase tracking-[.04em] text-[var(--color-ln-faint)]">
        <span className="ln-fspace" />
        <ExportLibretaButton petPublicToken={petPublicToken} />
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EmergenciaBlock — compact vet + emergency contact info, tap-to-call.
// Owner-only (see Props.emergencyContacts). Renders the per-pet override with
// account fallback (owner-ia-redesign P2): each row is honestly tagged "de tu
// cuenta" when it fell back to the account default. Shows a quiet "Agregar
// datos de emergencia" prompt when neither level carries any contact.
// ---------------------------------------------------------------------------

function ContactRow({
  pair,
  fallbackLabel,
}: { pair: ResolvedEmergencyPair; fallbackLabel: string }) {
  if (!pair) return null;
  const label = pair.name ?? fallbackLabel;
  const fromAccount = pair.source === "account";
  const inner = (
    <>
      <span className="flex items-center gap-1.5 text-[var(--color-ln-mute)]">
        {label}
        {fromAccount && (
          <span className="text-xs text-[var(--color-ln-faint)]">(de tu cuenta)</span>
        )}
      </span>
      {pair.phone && (
        <span className="flex items-center gap-1.5 font-medium text-[var(--color-ln-azul)]">
          <Icon name="telefono" size="sm" decorative />
          {pair.phone}
        </span>
      )}
    </>
  );
  const rowClass =
    "flex items-center justify-between gap-3 py-2 text-sm no-underline first:pt-0 last:pb-0";
  return pair.phone ? (
    <a href={`tel:${pair.phone}`} className={rowClass}>
      {inner}
    </a>
  ) : (
    <div className={rowClass}>{inner}</div>
  );
}

function EmergenciaBlock({
  contacts,
  petPublicToken,
}: {
  contacts: LibretaFaceEmergencyContacts;
  petPublicToken: string;
}) {
  const { vet, emergency } = contacts;
  const hasAnyContact = Boolean(vet || emergency);
  // pet-document-redesign ADR-13 (Phase 5): the edit entry point is the
  // narrow in-profile `?sheet=emergencia` sheet — same destination for both
  // the "add" prompt (no data) and the "edit" affordance (has data). The sheet
  // now writes the PET-LEVEL override (owner-ia-redesign P2).
  const editHref = `/mis-mascotas/${petPublicToken}?sheet=emergencia`;

  return (
    // Borderless, hairline-topped section (not a nested box) so it coheres with
    // the rest of the ledger inside the certificate sheet.
    <div
      data-section="libreta-emergencia"
      className="border-t border-[var(--color-ln-line-2)] pt-4"
    >
      <p className="mb-1.5 font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-faint)]">
        Emergencia
      </p>
      {hasAnyContact && (
        <div className="divide-y divide-[var(--color-ln-line-2)]">
          <ContactRow pair={vet} fallbackLabel="Veterinario" />
          <ContactRow pair={emergency} fallbackLabel="Contacto de emergencia" />
        </div>
      )}
      <SheetTriggerLink
        href={editHref}
        className={[
          "inline-block text-xs text-[var(--color-ln-mute)] no-underline hover:underline",
          hasAnyContact ? "mt-2" : "",
        ].join(" ")}
      >
        {hasAnyContact ? "Editar →" : "Agregar datos de emergencia →"}
      </SheetTriggerLink>
    </div>
  );
}
