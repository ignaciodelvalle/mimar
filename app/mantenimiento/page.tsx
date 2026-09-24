// /mantenimiento — the destination a guard sends you to when the maintenance
// kill-switch stops your request (B52).
//
// WHY A ROUTE AND NOT JUST THE LAYOUT BRANCH
// ---------------------------------------------------------------------------
// The four portal layouts render <LnMaintenanceScreen/> / <OpMaintenanceScreen/>
// inline, and they still do: a NAVIGATION during a maintenance window keeps its
// URL and gets the portal's own chrome-free screen, with no round-trip.
//
// A SERVER ACTION cannot render anything. Before T1.2 that was the whole bug:
// requireUserOrRedirect happily resolved a session mid-window, the action wrote,
// and only the following render met the maintenance screen. Now the guard
// refuses — and a refusal that redirects needs somewhere honest to land. This is
// it. It is deliberately OUTSIDE every portal segment so it can never loop
// against the layout that just bounced the caller here.
//
// Unauthenticated by design: during maintenance the database may be exactly what
// is unavailable, so this page reads nothing.

import type { Metadata } from "next";

import { LnMaintenanceScreen } from "@/components/ui/MaintenanceScreen";
import { BRANDING } from "@/lib/ui/branding";

export const metadata: Metadata = {
  title: `En mantenimiento — ${BRANDING.appName}`,
};

// The kill-switch is an env var read at request time by the guards; caching this
// page would let it outlive the window it announces.
export const dynamic = "force-dynamic";

export default function MantenimientoPage() {
  return <LnMaintenanceScreen />;
}
