// /admin/moderacion — ABSORBED into the Denuncias hub as the "Moderación"
// stage (fix, adversarial-admin 2026-07-23: this route was left as a
// standalone page during the F1 fusion (2026-07-22) that folded /gob/
// moderacion into /gob/denuncias?etapa=moderacion — stale chrome, duplicated
// query logic, and a comment referencing a /gob/moderacion redirect that
// already existed. Admin already has full access to /gob/denuncias
// (requireAdminOrGovtOrRedirect covers admin universally, includeEscalated
// included via the hub's own moderation predicate), so there is no
// admin-specific body worth keeping — unlike /admin/directorio's genuine
// national-scope divergence. This route now only redirects, preserving every
// query param, into /gob/denuncias?etapa=moderacion.
//
// /admin/moderacion/[id] is UNCHANGED — the nested detail route doesn't move.

import { redirect } from "next/navigation";

import { buildDenunciasHubRedirectUrl } from "@/lib/ui/denuncias-hub-redirect";

export default async function AdminModeracionRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  redirect(buildDenunciasHubRedirectUrl(sp, "moderacion"));
}
