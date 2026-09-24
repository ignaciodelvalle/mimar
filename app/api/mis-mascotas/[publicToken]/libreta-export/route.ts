// Libreta sanitaria export — server-side on-the-fly HTML/PDF (Item 14.3).
//
// Returns a print-ready HTML document that the browser can save as PDF via
// its native print dialog. No headless browser required; no file persisted
// (pet_attachments deferred). Structure mirrors the on-screen libreta:
// identity header → health status summary → sections by type → chronology.
//
// Auth: LIVENESS via requireLiveUser(), then OWNER-ONLY via this handler's own
// ownerships join. Two separate questions, answered by two separate things:
//
//   - requireLiveUser() (lib/infra/live-user.ts) answers "may this caller still
//     act at all": maintenance kill-switch → 503, no session → 401, erased
//     account (profiles.deleted_at, Ley 25.326 art. 16) → 401. A DEACTIVATED
//     institutional account PASSES, on purpose: this is a read, and the repo's
//     written policy (lib/infra/auth-guards.ts, after the 2026-07-04
//     ERR_TOO_MANY_REDIRECTS incident) is "reads stay open so the user can see
//     why; writes stop" — a deactivated shelter still holds the animals in its
//     custody and their sanitary record. requireLiveUser is the non-redirecting,
//     result-shaped guard, which is what a route handler needs — a redirect()
//     here would be a response the caller never asked for.
//   - the `pets ⋈ ownerships` join below answers "is this caller the titular of
//     THIS pet": pinned to `role = 'owner'` and `ended_at is null`, so a
//     caretaker/foster is refused with 404. That is deliberately NARROWER than
//     requirePetAccess; widening the libreta export to non-owner roles is a
//     product decision, not a refactor, so the query is left untouched.
//
// Until 2026-08-21 the liveness half did not exist: the handler resolved
// identity on a bare `supabase.auth.getUser()`, which answers WHO and never
// WHETHER THEY MAY STILL ACT, so a titular who had exercised ARCO supresión
// could still download the complete libreta with an unexpired JWT (PENDIENTES
// L-3). The regression test is __tests__/libreta-export-route.test.ts.
// Empty libreta: returns the HTML with an empty-state section (no broken output).
//
// URL: GET /api/mis-mascotas/[publicToken]/libreta-export
// Response: text/html; charset=utf-8, rendered inline (no Content-Disposition —
// this is an HTML print view, not a file download; do not claim a .pdf
// filename for HTML content). The page auto-triggers window.print() so the
// user produces the PDF via the browser's own print-to-PDF, not the server.

import { and, desc, eq, isNull, or } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";

import { db, ownerships, petEvents, pets, profiles } from "@/db";
import type { EventType } from "@/db/schema";
import { overlayAmendments } from "@/lib/infra/amendment";
import { notReportedClause } from "@/lib/infra/content-reports";
import {
  LIBRETA_GROUPS,
  LIBRETA_GROUP_LABELS,
  groupLibretaEvents,
  libretaSanitariaClause,
} from "@/lib/infra/libreta-sanitaria";
import { requireLiveUser } from "@/lib/infra/live-user";
import {
  eventTypeLabel,
  formatDate,
  formatDateTimeLegal,
  formatWeightKg,
  sexLabel,
  speciesLabel,
} from "@/lib/utils/format";

export const dynamic = "force-dynamic";

function htmlEscape(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extractEventSummary(event: {
  eventType: string;
  occurredAt: Date;
  payload: unknown;
  notes: string | null;
}): string {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const parts: string[] = [];

  // Vaccine
  if (typeof p.vaccine_name === "string") parts.push(p.vaccine_name);
  if (typeof p.brand === "string") parts.push(`Marca: ${p.brand}`);
  if (typeof p.lot_number === "string") parts.push(`Lote: ${p.lot_number}`);
  if (typeof p.next_due_at === "string") parts.push(`Próx. dosis: ${formatDate(p.next_due_at)}`);

  // Weight — event payload stores `kg` as a string (weight_recorded schema,
  // lib/events/event-schemas.ts), NOT `weight_kg` (that's the denormalized
  // pets.estimated_weight_kg column name, a different field entirely). The
  // old `weight_kg` check here never matched, so the PDF silently dropped
  // every weight entry (state-honesty audit, 2nd layer).
  // es-AR comma: the libreta sanitaria is a citizen-facing document and the
  // payload stores the weight as a toFixed(2) string ("12.50").
  if (typeof p.kg === "string" && p.kg) {
    parts.push(formatWeightKg(p.kg) ?? `${p.kg} kg`);
  }

  // Medication
  if (typeof p.drug_name === "string") parts.push(p.drug_name);
  if (typeof p.dose === "string") parts.push(`Dosis: ${p.dose}`);

  // Vet visit
  if (typeof p.vet_name === "string") parts.push(`Vet: ${p.vet_name}`);
  if (typeof p.clinic_name === "string") parts.push(`Clínica: ${p.clinic_name}`);

  // Notes
  if (event.notes) parts.push(event.notes);

  if (typeof p.reason === "string") parts.push(`Motivo: ${p.reason}`);
  if (typeof p.notes === "string") parts.push(p.notes);

  return parts.join(" · ") || "Sin detalles";
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ publicToken: string }> },
) {
  const { publicToken } = await params;

  // Liveness first. The body text is the one this route already returned for
  // 401 — an unauthorized caller learns nothing new from a finer message, and
  // WHICH refusal happened is carried by the status code, not by the prose.
  const live = await requireLiveUser();
  if (!live.ok && live.reason !== "DEACTIVATED") {
    // MAINTENANCE: the platform is not serving anyone — not the caller's fault.
    // NO_SESSION | ACCOUNT_ERASED: no usable identity.
    return new NextResponse("No autorizado", { status: live.reason === "MAINTENANCE" ? 503 : 401 });
  }
  // Only ok or DEACTIVATED reach here; DEACTIVATED always carries a user. Fail
  // CLOSED rather than assert that with a cast (same stance as auth-guards.ts).
  if (!live.user) {
    return new NextResponse("No autorizado", { status: 401 });
  }
  const user = live.user;

  // Verify ownership.
  const [pet] = await db
    .select()
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(pets.publicToken, publicToken),
        // Art. 16 (Ley 25.326): a soft-deleted pet reads as NEVER REGISTERED.
        // requireLiveUser() above closes the ERASED SUBJECT's own path (their
        // profile is soft-deleted → 401), but the erasure soft-deletes the pet
        // while leaving OTHER live 'owner' rows on it intact — a surviving live
        // co-owner would otherwise export the full Tier-2 libreta of a pet that
        // must read as gone. Defense in depth, and it folds the erased pet into
        // the SAME 404 a non-owned token returns (no existence oracle).
        isNull(pets.deletedAt),
        eq(ownerships.ownerUserId, user.id),
        eq(ownerships.role, "owner"),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);

  if (!pet) {
    return new NextResponse("No encontrado", { status: 404 });
  }

  const petRow = pet.pets;

  // Owner name for the header. requireLiveUser() already loaded the cached
  // profile on the success arm (request-cache selects displayName), so the
  // common path pays no second round-trip; a tolerated DEACTIVATED refusal does
  // not carry it, so that arm falls back to one read.
  const cachedName = live.ok ? live.profile?.displayName : undefined;
  const ownerName =
    cachedName ??
    (
      await db
        .select({ displayName: profiles.displayName })
        .from(profiles)
        .where(eq(profiles.id, user.id))
        .limit(1)
    )[0]?.displayName ??
    "";

  // Load libreta events. event_amended is NOT itself a libreta type (it's a
  // correction pointer — lib/infra/libreta-sanitaria.ts NON_LIBRETA_EVENT_TYPES)
  // but must be fetched alongside so overlayAmendments below can project
  // corrected values onto the events it targets; groupLibretaEvents drops the
  // event_amended rows themselves (libretaGroupForEvent has no case for them).
  const rawEvents = await db
    .select()
    .from(petEvents)
    .where(
      and(
        eq(petEvents.petId, petRow.id),
        or(libretaSanitariaClause(), eq(petEvents.eventType, "event_amended")),
        // `note_added` is a libreta type, so a reported lost-feed message would
        // otherwise be exported into the owner's own downloadable record.
        notReportedClause(),
      ),
    )
    .orderBy(desc(petEvents.occurredAt));

  // Mirror the on-screen libreta's data path (get-libreta-face-data.ts): apply
  // the amendment overlay so a corrected vaccine/weight/etc. prints with its
  // CURRENT value, not the as-typed pre-correction one (H7).
  const events = overlayAmendments(rawEvents);

  const grouped = groupLibretaEvents(events);
  const generatedAt = formatDateTimeLegal(new Date());
  const petName = htmlEscape(petRow.name);
  const ownerEsc = htmlEscape(ownerName);

  // Build sections HTML.
  let sectionsHtml = "";
  for (const groupKey of LIBRETA_GROUPS) {
    const groupEvents = grouped[groupKey];
    if (!groupEvents || groupEvents.length === 0) continue;
    const label = htmlEscape(LIBRETA_GROUP_LABELS[groupKey]);
    sectionsHtml += `
      <section class="section">
        <h2 class="section-title">${label}</h2>
        <table class="event-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Tipo</th>
              <th>Detalle</th>
            </tr>
          </thead>
          <tbody>
            ${groupEvents
              .map((e) => {
                const date = formatDate(e.occurredAt);
                const type = htmlEscape(eventTypeLabel(e.eventType as EventType));
                const detail = htmlEscape(
                  extractEventSummary({
                    eventType: e.eventType,
                    occurredAt: new Date(e.occurredAt),
                    payload: e.payload,
                    notes: e.notes,
                  }),
                );
                return `<tr><td>${date}</td><td>${type}</td><td>${detail}</td></tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </section>`;
  }

  if (!sectionsHtml) {
    sectionsHtml = `
      <section class="section empty-state">
        <p>Esta libreta no tiene eventos registrados aún.</p>
      </section>`;
  }

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Libreta sanitaria — ${petName}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: 'Georgia', 'Times New Roman', serif;
      font-size: 11pt;
      color: #1a2030;
      background: #fff;
      margin: 0;
      padding: 2cm 2.5cm;
    }
    .cover {
      border-bottom: 2px solid #1a2030;
      padding-bottom: 18pt;
      margin-bottom: 24pt;
    }
    .cover h1 {
      font-size: 22pt;
      font-weight: 700;
      margin: 0 0 6pt;
      letter-spacing: -0.02em;
    }
    .cover .meta {
      font-family: 'Courier New', monospace;
      font-size: 9pt;
      color: #4a5568;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin-top: 4pt;
    }
    .cover .owner-line {
      margin-top: 8pt;
      font-size: 10pt;
      color: #2d3748;
    }
    .section {
      page-break-inside: avoid;
      margin-bottom: 20pt;
    }
    .section-title {
      font-size: 12pt;
      font-weight: 700;
      border-bottom: 1px solid #cbd5e0;
      padding-bottom: 4pt;
      margin: 0 0 8pt;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-family: 'Courier New', monospace;
      font-size: 9pt;
      color: #2d3748;
    }
    .event-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 10pt;
    }
    .event-table th {
      text-align: left;
      font-size: 8pt;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #718096;
      border-bottom: 1px solid #e2e8f0;
      padding: 4pt 6pt;
    }
    .event-table td {
      padding: 5pt 6pt;
      border-bottom: 1px solid #f0f4f8;
      vertical-align: top;
    }
    .event-table td:first-child {
      white-space: nowrap;
      font-family: 'Courier New', monospace;
      font-size: 9pt;
      color: #4a5568;
      width: 80pt;
    }
    .event-table td:nth-child(2) {
      width: 120pt;
      font-weight: 600;
    }
    .empty-state {
      color: #718096;
      font-style: italic;
      padding: 16pt;
      border: 1px dashed #cbd5e0;
      border-radius: 4pt;
    }
    footer {
      margin-top: 32pt;
      border-top: 1px solid #e2e8f0;
      padding-top: 10pt;
      font-family: 'Courier New', monospace;
      font-size: 7.5pt;
      color: #a0aec0;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      display: flex;
      justify-content: space-between;
    }
    @media print {
      body { padding: 1.5cm 2cm; }
      .section { page-break-inside: avoid; }
      a { text-decoration: none; color: inherit; }
    }
  </style>
</head>
<body>
  <header class="cover">
    <div class="meta">Libreta Sanitaria Digital · miMAR</div>
    <h1>${petName}</h1>
    <div class="meta">${htmlEscape(speciesLabel(petRow.species))} ${petRow.breed ? `· ${htmlEscape(petRow.breed)}` : ""} · ${htmlEscape(sexLabel(petRow.sex))}</div>
    ${ownerEsc ? `<div class="owner-line">Dueño/a: <strong>${ownerEsc}</strong></div>` : ""}
  </header>

  <main>
    ${sectionsHtml}
  </main>

  <footer>
    <span>Generada por miMAR · ${htmlEscape(generatedAt)}</span>
    <span>Documento no persistido · generado al vuelo</span>
  </footer>

  <script>window.addEventListener('load', () => window.print());</script>
</body>
</html>`;

  // No Content-Disposition: this response is HTML rendered inline for the
  // browser's print-to-PDF flow, not a downloadable file — claiming a
  // ".pdf" filename here would misrepresent the actual content type.
  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
