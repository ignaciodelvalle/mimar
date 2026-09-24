// Portal base resolution for the shared work surfaces (portal-follows-viewer,
// 2026-07-02). The cola/usuarios/organizaciones/reglas/servicios pages render
// under BOTH /admin and /gob (thin wrapper routes share one implementation);
// their internal links must stay inside whichever portal the viewer is
// browsing, so an admin is never silently teleported into /gob chrome.
//
// The middleware stamps every request with `x-portal-base` derived from the
// pathname prefix. Server components read it here; client components should
// receive the base as a prop from their server parent instead of re-deriving.

import { headers } from "next/headers";

export type PortalBase = "/admin" | "/gob";

export async function portalBase(): Promise<PortalBase> {
  const value = (await headers()).get("x-portal-base");
  return value === "/admin" ? "/admin" : "/gob";
}
