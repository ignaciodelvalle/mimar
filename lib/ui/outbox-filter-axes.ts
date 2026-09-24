// outbox-filter-axes — shared OpFilterBar axis definitions for the outbox SLA
// monitor twins (/gob/outbox + /admin/outbox, #26 D3 lineage: the WHERE-clause
// builder in lib/infra/outbox-query.ts already lives in ONE place so the two
// surfaces can't silently diverge; this gives their FILTER UI the same
// treatment). status/target_kind/breach are IDENTICAL between the two pages
// (same param names, same options, same labels) — only the Provincia axis
// differs (govt: assigned provinces only; admin: every province) and stays
// defined per-page.

import type { OpFilterAxis } from "@/components/ui/dashboard";
import {
  OUTBOX_STATUS_VALUES,
  OUTBOX_TARGET_KIND_LABEL,
  OUTBOX_TARGET_KIND_VALUES,
  buildStatusLabel,
} from "@/components/ui/dashboard/OutboxTable";
import type { OutboxStatus } from "@/db";
import type { OutboxPresetId } from "@/lib/infra/outbox-query";

/** es-AR label of each preset, for the "Vista" axis and the page headers. */
export const OUTBOX_PRESET_LABEL: Record<OutboxPresetId, string> = {
  eno: "Cola ENO (aviso legal)",
};

/**
 * Builds the preset/status/target_kind/breach axes shared by both outbox
 * pages. The "Vista" axis leads: it is the ONE control that changes what the
 * list IS (the legal-notification queue vs the whole bandeja) rather than
 * narrowing it, and its param (`?preset=`) is also the deep-link alias the
 * nav uses (lib/infra/outbox-query.ts, Presets).
 */
export function buildOutboxDomainAxes(filters: {
  status?: string;
  target_kind?: string;
  breach?: string;
  preset?: OutboxPresetId | null;
}): OpFilterAxis[] {
  return [
    {
      id: "preset",
      label: "Vista",
      paramKey: "preset",
      options: (Object.keys(OUTBOX_PRESET_LABEL) as OutboxPresetId[]).map((id) => ({
        value: id,
        label: OUTBOX_PRESET_LABEL[id],
      })),
      current: filters.preset ?? null,
      allLabel: "Toda la bandeja",
    },
    {
      id: "status",
      label: "Estado",
      paramKey: "status",
      options: OUTBOX_STATUS_VALUES.map((s) => ({
        value: s,
        label: buildStatusLabel(s as OutboxStatus),
      })),
      current: filters.status ?? null,
      allLabel: "Todos los estados",
    },
    {
      id: "target_kind",
      label: "Destino",
      paramKey: "target_kind",
      options: OUTBOX_TARGET_KIND_VALUES.map((k) => ({
        value: k,
        label: OUTBOX_TARGET_KIND_LABEL[k],
      })),
      current: filters.target_kind ?? null,
      allLabel: "Todos los destinos",
    },
    {
      id: "breach",
      label: "SLA",
      paramKey: "breach",
      options: [
        { value: "yes", label: "Solo incumplimientos SLA" },
        { value: "no", label: "Solo dentro de SLA" },
      ],
      current: filters.breach ?? null,
      allLabel: "Todos (breach o no)",
    },
  ];
}
