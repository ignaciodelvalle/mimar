"use client";

// The entry point for GET /gob/senasa/export (pilot T1-P7). The route existed
// with nothing in app/ or components/ linking to it, so a govt operator could
// only reach the SENASA padrón by typing its URL.
//
// It lives on /gob/analytics/export because that is where an operator looks for
// exports, and that page already applies the route's exact access rule (admin,
// or govt with at least one assignment) — so the link shows to precisely the
// people the route would serve.
//
// SAME INPUTS AS THE FORM ABOVE IT. The route reads period/from/to and
// province/locality; this link carries them from the LIVE URL, the state the
// page's PeriodPicker and JurisdictionSwitcher write, for the same reason
// ExportFormClient does (its P1-6 note): the server snapshot goes stale the
// moment the picker changes the URL client-side. A plain <a> rather than
// next/link: the target is a file download, not a page.

import { useSearchParams } from "next/navigation";

export type SenasaExportParams = {
  period: string;
  from: string;
  to: string;
  province: string;
  locality: string;
};

/** The route URL for a scope + period, omitting empty values. */
export function senasaExportHref(p: SenasaExportParams): string {
  const qs = new URLSearchParams();
  for (const key of ["period", "from", "to", "province", "locality"] as const) {
    if (p[key]) qs.set(key, p[key]);
  }
  qs.set("format", "csv");
  return `/gob/senasa/export?${qs.toString()}`;
}

export function SenasaExportLink(ssr: SenasaExportParams) {
  const sp = useSearchParams();
  const live: SenasaExportParams = {
    period: sp.get("period") ?? ssr.period,
    from: sp.get("from") ?? ssr.from,
    to: sp.get("to") ?? ssr.to,
    province: sp.get("province") ?? ssr.province,
    locality: sp.get("locality") ?? ssr.locality,
  };

  return (
    <a href={senasaExportHref(live)} download className="text-md text-ln-op-azul hover:underline">
      Descargar padrón SENASA (CSV) →
    </a>
  );
}
