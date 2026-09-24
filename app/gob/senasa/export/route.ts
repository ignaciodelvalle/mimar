// GET /gob/senasa/export — SENASA / LSUCyF batch download for an authorized
// government operator.
//
// This is design D5 of dim-interno:docs/design/sdd/2026-07-07-senasa-lsucyf-batch-export.md,
// deliberately held out of that cycle and wired on 2026-09-11. Until today the
// whole pipeline had ZERO callers: the transform, the formatter registry and the
// keyset-paged query existed and nothing could reach them.
//
// WHAT IT CARRIES, AND WHY CSV
// ---------------------------------------------------------------------------
// The real SENASA on-the-wire format is open question #1 of that SDD and is NOT
// invented here. CSV is the interim carrier with a real job: today a funcionario
// re-types every dose into the legacy SENASA form by hand, and a spreadsheet
// they can read and cross-load is strictly better than that. When the
// homologation spec lands, the new formatter registers in SENASA_FORMATTERS and
// this file does not change — `?format=` already resolves through the registry.
//
// WHY IT MIRRORS /gob/campanas/export AND NOT /gob/analytics/export
// ---------------------------------------------------------------------------
// Same guard, same jurisdiction resolution, same period resolution, same direct
// synchronous download. It does NOT take the Storage-upload + signed-URL +
// email path, because that path exists to hand a large multi-slice file to an
// analyst asynchronously; this is one scoped file an operator asked for and is
// waiting on.
//
// BUT IT IS NOT AN AGGREGATE EXPORT, AND THAT CHANGES TWO THINGS
// ---------------------------------------------------------------------------
// The four dashboard exports ship suppressed by-province counts. This ships ONE
// ROW PER ANIMAL PER SANITARY EVENT. Consequences, both deliberate:
//
//   1. AUDIT — it writes `senasa_export_generated`, not
//      `gob_dashboard_export_generated`. Reusing the aggregate action would make
//      the trail claim aggregate data left the system. See `logSenasaExport`
//      and migration 0220.
//   2. STREAMED — the body is produced chunk by chunk from the query stage's
//      generator. `pet_events` is several times the size of `pets` (32k rows
//      locally), and `streamSenasaBatch`'s docblock is explicit that whoever
//      wired this route would be assumed to have honored that. Nothing in this
//      file ever holds the batch: peak memory is one page of rows plus one
//      chunk of canonical rows.
//
// K-ANONYMITY IS NOT APPLIED, AND THAT IS NOT AN OVERSIGHT. The suppression on
// the dashboards protects a COUNT from being read back to an individual. There
// is no count here to protect, and the row is an allowlist that physically
// cannot carry an owner: no name, no DNI, no contact, no coordinates, no free
// text — see `toSenasaCanonicalRow`, the privacy boundary (R2.1/D4).
//
// ACCESS: THE SAME GATE AS EVERY OTHER /gob EXPORT, ON PURPOSE.
// The one precedent that matters is /gob/analytics/export — the repo's other
// raw-row government export. It uses exactly this guard and exactly this
// capability check, and defends privacy in WHAT THE ROWS CONTAIN (a Zod
// allowlist) rather than in who may ask. This route follows that answer. Note
// what it does NOT use: `requireGobReadAccessOrRedirect`, the wider gate that
// also admits the country-wide read-only `national` role. Every export route in
// this portal uses the strict guard; a national-scope raw sanitary batch is
// precisely the widening those routes declined, and it is not introduced here.

import { type NextRequest, NextResponse } from "next/server";

import { resolveJurisdictionScope } from "@/lib/analytics/jurisdiction-scope";
import { resolveSenasaFormatter, senasaDocumentChunks } from "@/lib/analytics/senasa-export";
import { logSenasaExport, streamSenasaBatch } from "@/lib/analytics/senasa-export-query";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { buildProjectionContext, resolveAnalyticsPeriod } from "@/lib/metrics";

export async function GET(request: NextRequest): Promise<Response> {
  let profile: Awaited<ReturnType<typeof requireAdminOrGovtOrRedirect>>["profile"];
  let jurisdictions: Awaited<ReturnType<typeof requireAdminOrGovtOrRedirect>>["jurisdictions"];
  let user: Awaited<ReturnType<typeof requireAdminOrGovtOrRedirect>>["user"];

  try {
    ({ profile, jurisdictions, user } = await requireAdminOrGovtOrRedirect());
  } catch {
    return NextResponse.redirect(new URL("/iniciar-sesion", request.url));
  }

  // A govt operator with no assignments has an EMPTY mandate, not a universal
  // one. `streamSenasaBatch` already fails closed for that context (it returns
  // before issuing a query), so this check is the second of two independent
  // defenses, not the only one — and it is the one that says "denied" instead of
  // handing back an empty file that reads like "there is nothing in your
  // jurisdiction".
  const hasAccess =
    profile.role === "admin" || (profile.role === "govt" && jurisdictions.length > 0);
  if (!hasAccess) {
    return new NextResponse("Acceso denegado", { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const sp = {
    period: searchParams.get("period") ?? undefined,
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
  };

  // Jurisdiction filter — identical logic to the /gob dashboards, so the file
  // matches whatever province/locality selection produced the link.
  const { filteredJurisdictions, adminSelectedProvince, adminSelectedLocality } =
    await resolveJurisdictionScope({
      role: profile.role,
      jurisdictions,
      params: { province: searchParams.get("province"), locality: searchParams.get("locality") },
    });
  // Both undefined unless role === "admin" — same pattern as the dashboards.
  const adminProvince = adminSelectedProvince ?? undefined;
  const adminLocality = adminSelectedLocality ?? undefined;

  const period = resolveAnalyticsPeriod(sp);
  const actor = { role: profile.role } as const;
  const ctx = buildProjectionContext(actor, filteredJurisdictions, period, {
    adminProvince,
    adminLocality,
  });

  // Unknown ids fall back to the CSV baseline rather than 400ing — the registry
  // is the closed vocabulary, so an unrecognised `?format=` is a stale link, not
  // an attack surface.
  const formatter = resolveSenasaFormatter(searchParams.get("format"));

  // BEFORE the first byte. The row records the authorized disclosure of a
  // scope, which is fully known now; writing it after the stream drains would
  // lose it in exactly the case that matters — an interrupted download whose
  // sensitive rows had already crossed the wire. See logSenasaExport.
  await logSenasaExport(user.id, ctx, formatter.id);

  const encoder = new TextEncoder();
  const chunks = senasaDocumentChunks(streamSenasaBatch(ctx), formatter);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) {
        controller.close();
        return;
      }
      // A formatter may legitimately emit "" (an empty chunk, a no-op close);
      // enqueueing it is harmless and keeps this loop free of format knowledge.
      controller.enqueue(encoder.encode(next.value));
    },
    async cancel() {
      // The client hung up. Return the generator so the paging loop stops and
      // its database work is not carried on for a body nobody is reading.
      //
      // EXACTLY: it stops AFTER THE PAGE IN FLIGHT. If this lands while `pull()`
      // is awaiting `chunks.next()`, the generator queues the return behind that
      // in-flight `next()`, so the already-issued page query finishes first. The
      // bound is one extra page (SENASA_PAGE_SIZE rows), never a runaway loop —
      // which is the property worth stating, since "the loop stops" invites the
      // reader to assume the query was cancelled, and it was not.
      await chunks.return(undefined);
    },
  });

  const filename = `senasa-${new Date().toISOString().slice(0, 10)}.${formatter.fileExtension}`;
  // Same header set as csvDownloadResponse (lib/analytics/govt-dashboard-export.ts),
  // written out here because that helper takes a string body and this one is a
  // stream. no-store is not decorative: this body is raw per-animal data.
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": formatter.contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
