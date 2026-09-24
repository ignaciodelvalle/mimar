// NovedadesCard — session-start "Novedades" orientation feed, shared by the
// /gob and /admin operator HOMEs (viz-suite Wave 1, plan dim-interno:docs/plans/viz-suite.md).
//
// The page fetches the feed (fetchNovedadesFeed) and passes it in, so this
// stays render-only and inherits the page's data-load budget. Ledger-style
// rows — es-AR event label + jurisdiction + relative time + a per-item link
// to the surface that handles that event type, labeled by its ACTUAL
// capability class (queue vs map — lib/metrics/novedades-feed-links.ts).
//
// Client component (Epic D): a `collapsible` variant adds a Mostrar/Ocultar
// toggle so the /admin home can DEMOTE the feed below the operational cockpit
// without removing it. The feed serialises cleanly across the RSC boundary
// (plain rows + a Date), and the watermark server action is referenced, not
// invoked, so making this a client island costs only the toggle's state.
//
// The watermark advances ONLY via the explicit "Marcar como visto" button (a
// form posting markNovedadesSeenAction) — never on render, so a refresh cannot
// clear the feed. The button is a pure text-link control, matching the
// documented text-link exception to the OpButton chrome primitive.

"use client";

import Link from "next/link";
import { useState } from "react";

import { markNovedadesSeenAction } from "@/app/actions/novedades";
import { Icon } from "@/components/Icon";
import { LnEmptyState } from "@/components/ui/EmptyState";
import { LnListRow } from "@/components/ui/ListRow";
import { OpCard, OpCardBody, OpCardHead } from "@/components/ui/dashboard";
import type { NovedadesGroupedFeed } from "@/lib/metrics/novedades-feed";
import {
  feedDestinationLabel,
  feedGroupLabel,
  feedQueueHref,
} from "@/lib/metrics/novedades-feed-links";
import { relativeTime } from "@/lib/utils/format";

function formatJurisdiction(province: string | null, locality: string | null): string {
  if (province && locality) return `${locality}, ${province}`;
  if (province) return province;
  return "Sin localidad";
}

export function NovedadesCard({
  feed,
  collapsible = false,
  defaultCollapsed = false,
}: {
  feed: NovedadesGroupedFeed;
  /** When true, render a Mostrar/Ocultar toggle so the feed can be demoted. */
  collapsible?: boolean;
  /** Initial collapsed state (only meaningful when `collapsible`). */
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(collapsible ? defaultCollapsed : false);
  const { groups, sinceWatermark, scopeEmpty } = feed;

  // First visit (no watermark) shows the last 7 days and says so; otherwise the
  // window is "desde tu última visita".
  const subtitle = sinceWatermark ? "desde tu última visita" : "Últimos 7 días";

  // H17 (external red-team 2026-07-30) — the empty state names WHICH emptiness
  // it is instead of asserting "no news" in every case.
  //
  // `scopeEmpty` means the feed short-circuited before running any query (a
  // govt actor with zero jurisdictions in scope). "Sin novedades" would then be
  // a statement about the world made by a screen that never looked — the
  // no-signal reading LnEmptyState's `nature` prop exists for. Note the
  // asymmetry that makes this worth carrying: a MEASURED zero here is genuinely
  // reassuring, so painting both the same colour is what destroys the signal.
  const emptyState = scopeEmpty
    ? {
        icon: "alerta" as const,
        title: "No se pudo calcular: tu usuario no tiene jurisdicciones asignadas",
        description:
          "El feed no consultó ningún alcance, así que esto no significa que no haya novedades. Pedile a un administrador que te asigne jurisdicciones.",
        nature: "no-signal" as const,
      }
    : {
        icon: "circle-dot" as const,
        title: sinceWatermark
          ? "Sin novedades desde tu última visita"
          : "Sin novedades en los últimos 7 días",
        description: sinceWatermark
          ? "Se consultó tu alcance y no hubo eventos nuevos desde que marcaste el feed como visto."
          : "Se consultó tu alcance y no hubo eventos en la ventana de 7 días.",
        nature: "measured-zero" as const,
      };

  const actions = (
    <div className="flex items-center gap-3">
      {groups.length > 0 ? (
        <form action={markNovedadesSeenAction}>
          <button type="submit" className="text-sm text-ln-op-azul hover:underline">
            Marcar como visto
          </button>
        </form>
      ) : null}
      {collapsible ? (
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          className="inline-flex items-center gap-1 text-sm text-ln-op-azul hover:underline"
        >
          {collapsed ? "Mostrar" : "Ocultar"}
          <Icon name={collapsed ? "chevron-down" : "chevron-up"} size={14} decorative />
        </button>
      ) : null}
    </div>
  );

  return (
    <OpCard>
      <OpCardHead
        title={
          <>
            Novedades <span className="text-sm font-normal text-ln-op-mute">{subtitle}</span>
          </>
        }
        actions={actions}
      />
      {collapsed ? null : (
        <OpCardBody className="p-0">
          {groups.length === 0 ? (
            <div className="px-4 py-3">
              <LnEmptyState
                icon={emptyState.icon}
                title={emptyState.title}
                description={emptyState.description}
                nature={emptyState.nature}
              />
            </div>
          ) : (
            <ul className="divide-y divide-ln-op-line-2">
              {groups.map((group) => (
                <li key={group.key}>
                  {/* The count badge lives inside `children`, not the `icon`
                      slot: it's nested one level deeper (gap-2 from the label
                      stack) than LnListRow's own icon/content/trailing gap-3,
                      so folding it into `icon` would widen that inner gap and
                      break pixel-parity with the pre-migration row. */}
                  <LnListRow
                    align="center"
                    className="justify-between px-4 py-2.5 odd:bg-ln-op-stripe"
                    trailing={
                      <Link
                        href={feedQueueHref(group.eventType)}
                        className="shrink-0 text-sm text-ln-op-azul hover:underline no-underline"
                      >
                        {/* Label DERIVED from the destination's capability
                            class (C2 — novedades-feed-links.ts registry), not
                            hardcoded "Ver en su cola" — 4 of 5 event types
                            land on /gob/vigilancia, a MAP, not a queue. */}
                        {feedDestinationLabel(group.eventType)}
                      </Link>
                    }
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {/* Count badge: the map doubles as a status board. Groups
                          with >1 subject get the count so 18 incidents no longer
                          read as one row (Cowork M2).
                          T4.15 (2026-08-01): the bare number reads as an event
                          count, but the query counts DISTINCT pet_id
                          (novedades-feed.ts fetchNovedadesGroupedFeed) — animals
                          affected, not events (a pet with 2 events in the group
                          still counts once). Name it so it never reads as
                          disagreeing with an event total elsewhere on the board. */}
                      {group.count > 1 ? (
                        <span
                          className="shrink-0 rounded-full bg-ln-op-warn-bg px-2 py-0.5 text-xs font-semibold tabular-nums text-ln-op-warn"
                          title={`${group.count} animales afectados`}
                          aria-label={`${group.count} animales afectados`}
                        >
                          {group.count}
                        </span>
                      ) : null}
                      <div className="min-w-0">
                        <p className="text-md text-ln-op-ink">{feedGroupLabel(group.eventType)}</p>
                        <p className="truncate text-sm text-ln-op-mute">
                          {formatJurisdiction(group.province, group.locality)} ·{" "}
                          {relativeTime(group.latestRecordedAt)}
                        </p>
                      </div>
                    </div>
                  </LnListRow>
                </li>
              ))}
            </ul>
          )}
        </OpCardBody>
      )}
    </OpCard>
  );
}
