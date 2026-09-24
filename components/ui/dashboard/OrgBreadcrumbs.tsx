"use client";

// Dynamic breadcrumb for the org portal topbar.
// Reads the current pathname to reflect the active section instead of
// always showing the static "Panel" label.

import { usePathname } from "next/navigation";
import { OpCrumbs } from "./OpCrumbs";

const SEGMENT_LABELS: Record<string, string> = {
  agenda: "Agenda",
  mascotas: "Mascotas",
  intake: "Ingresos",
  transitos: "Tránsitos",
  voluntarios: "Voluntarios",
  transferencias: "Transferencias",
  checkins: "Check-ins",
  casos: "Casos",
  servicios: "Servicios",
  // "Operaciones" matches the nav-rail label for this section (nav-presets.ts),
  // which groups adoption operations under that name.
  adopciones: "Postulaciones",
  miembros: "Miembros",
  cobertura: "Cobertura",
  configuracion: "Configuración",
  mordedura: "Mordeduras",
  // Must match the nav-rail label (nav-presets.ts) — QA 2026-07-03 caught the
  // same module named "Maltrato" (rail) / "Bienestar" (breadcrumb) at once.
  maltrato: "Maltrato",
  pets: "Mascotas",
  // #815 audit finding #3 — censo/page.tsx generates ?species= links whose
  // section wasn't in this map, so the topbar fell back to "Panel" while the
  // sidebar highlighted "Censo".
  censo: "Censo",
  admin: "Admin",
};

// Two-segment overrides — checked before the flat SEGMENT_LABELS fallback.
// "admin" alone is ambiguous (only one subroute exists today, /admin/permisos,
// but the flat map can't express "admin/<subpath>"); this keeps the topbar
// accurate without a broader nested-breadcrumb rework (#815 audit finding #4).
const NESTED_SEGMENT_LABELS: Record<string, string> = {
  "admin/permisos": "Permisos",
};

type Props = {
  orgToken: string;
};

export function OrgBreadcrumbs({ orgToken }: Props) {
  const pathname = usePathname();
  // Extract the segment after /org/[orgToken]/
  const base = `/org/${orgToken}/`;
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : "";
  const segments = rest.split("/");
  const firstSegment = segments[0] ?? "";
  const twoSegmentKey = segments.length > 1 ? `${segments[0]}/${segments[1]}` : "";
  const sectionLabel =
    NESTED_SEGMENT_LABELS[twoSegmentKey] ?? SEGMENT_LABELS[firstSegment] ?? "Panel";

  const crumbs =
    sectionLabel === "Panel"
      ? [{ label: "Panel" }]
      : [{ label: "Panel", href: `/org/${orgToken}` }, { label: sectionLabel }];

  return <OpCrumbs items={crumbs} />;
}
