"use server";

// v1: sync generation in the server action. Builds the file, uploads to
// Supabase Storage, sends the signed URL via Resend, logs to audit_log.
//
// v2: extract to a job table + worker if request timeouts become an issue
// at scale (the expected analyst volume is low, one export per session).

import { Resend } from "resend";

import { auditLog, db } from "@/db";
import {
  type ExportPeriod,
  fetchCasesForExport,
  fetchEventsForExport,
  fetchOrganizationsForExport,
  fetchPetsForExport,
} from "@/lib/analytics/govt-dashboards";
import {
  EXPORT_SCHEMA_VERSION,
  type ExportSlice,
  anonymizeRows,
  rowsToCsv,
} from "@/lib/analytics/govt-exports";
import { resolveJurisdictionScope } from "@/lib/analytics/jurisdiction-scope";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { resolveMailSender } from "@/lib/infra/outbound-channels";
import { UnknownExportPeriodError, resolveExportPeriod } from "./export-period";

export type GenerateExportResult =
  | { ok: true; signedUrl: string; emailSent: boolean }
  | { ok: false; error: string };

const BUCKET_NAME = "analytics-exports";

// parsePeriod used to live here as a hand-rolled branch set that recognised
// "1y" (emitted by nothing) and silently defaulted "trailing12m" / "ytd" to 30
// days — mislabelling both the file AND the audit row. It now lives in
// ./export-period.ts, shares the canonical vocabulary, and throws on an
// unrecognised value. See that module's header (RA-2 F11).

export async function generateExportAction(formData: FormData): Promise<GenerateExportResult> {
  try {
    // 1. Auth gate.
    const { profile, jurisdictions, user, supabase } = await requireAdminOrGovtOrRedirect();
    const actor = { role: profile.role } as const;

    const hasAccess =
      profile.role === "admin" || (profile.role === "govt" && jurisdictions.length > 0);
    if (!hasAccess) {
      return { ok: false, error: "No tenés permisos para generar exports." };
    }

    // 2. Parse form inputs.
    const rawSlices = formData.getAll("slice") as string[];
    const requestedSlices = rawSlices.filter(
      (s): s is ExportSlice =>
        s === "pets" || s === "events" || s === "cases" || s === "organizations",
    );
    if (requestedSlices.length === 0) {
      return { ok: false, error: "Seleccioná al menos un tipo de datos para exportar." };
    }

    const rawFormat = formData.get("format");
    const format = rawFormat === "json" ? "json" : "csv";

    // Throws UnknownExportPeriodError on a value outside the canonical
    // vocabulary — caught below and surfaced to the operator. It must NEVER
    // fall back to an arbitrary window: the resolved since/until is persisted
    // verbatim into the audit_log row further down (RA-2 F11).
    const period: ExportPeriod = resolveExportPeriod(formData);

    // 2b. Jurisdiction filter — identical logic to app/gob/analytics/export/page.tsx
    // (export honors the active filter, Fase C 2026-07-21). Previously this action
    // ignored any province/locality narrowed via the form's JurisdictionSwitcher and
    // always exported the operator's FULL jurisdiction assignment (govt) / the
    // entire nation (admin) — a view↔export honesty gap: the switcher visibly
    // updated but had no effect on what was actually exported. filteredJurisdictions
    // narrows the govt case (assignments ∩ selection); adminSelectedProvince/Locality
    // carry the admin drill-down (admin has no assignments to narrow).
    const rawProvince = formData.get("province");
    const rawLocality = formData.get("locality");
    const { filteredJurisdictions, adminSelectedProvince, adminSelectedLocality } =
      await resolveJurisdictionScope({
        role: profile.role,
        jurisdictions,
        params: {
          province: typeof rawProvince === "string" ? rawProvince : undefined,
          locality: typeof rawLocality === "string" ? rawLocality : undefined,
        },
      });
    const adminProvince = adminSelectedProvince ?? undefined;
    const adminLocality = adminSelectedLocality ?? undefined;

    // 3. Fetch rows per requested slice.
    const sliceData: Partial<
      Record<ExportSlice, { rows: Record<string, unknown>[]; rejected: number }>
    > = {};

    if (requestedSlices.includes("pets")) {
      const raw = await fetchPetsForExport(
        actor,
        filteredJurisdictions,
        period,
        adminProvince,
        adminLocality,
      );
      sliceData.pets = anonymizeRows("pets", raw) as {
        rows: Record<string, unknown>[];
        rejected: number;
      };
    }
    if (requestedSlices.includes("events")) {
      const raw = await fetchEventsForExport(
        actor,
        filteredJurisdictions,
        period,
        adminProvince,
        adminLocality,
      );
      sliceData.events = anonymizeRows("events", raw) as {
        rows: Record<string, unknown>[];
        rejected: number;
      };
    }
    if (requestedSlices.includes("cases")) {
      const raw = await fetchCasesForExport(
        actor,
        filteredJurisdictions,
        period,
        adminProvince,
        adminLocality,
      );
      sliceData.cases = anonymizeRows("cases", raw) as {
        rows: Record<string, unknown>[];
        rejected: number;
      };
    }
    if (requestedSlices.includes("organizations")) {
      const raw = await fetchOrganizationsForExport(
        actor,
        filteredJurisdictions,
        adminProvince,
        adminLocality,
      );
      sliceData.organizations = anonymizeRows("organizations", raw) as {
        rows: Record<string, unknown>[];
        rejected: number;
      };
    }

    // 4. Build the output file content.
    let fileContent: string;
    const ext = format;

    if (format === "csv") {
      // One section per slice, separated by a comment line.
      const sections: string[] = [];
      for (const slice of requestedSlices) {
        const data = sliceData[slice];
        if (!data) continue;
        sections.push(`# slice: ${slice}`);
        sections.push(rowsToCsv(data.rows));
      }
      fileContent = sections.join("\r\n");
    } else {
      // JSON: { pets: [...], events: [...], ... }
      const obj: Record<string, Record<string, unknown>[]> = {};
      for (const slice of requestedSlices) {
        const data = sliceData[slice];
        if (data) obj[slice] = data.rows;
      }
      fileContent = JSON.stringify(obj, null, 2);
    }

    // 5. Upload to Supabase Storage.
    // supabase comes from the auth guard session (requireAdminOrGovtOrRedirect).

    // Verify bucket exists before uploading.
    const { data: buckets, error: bucketsError } = await supabase.storage.listBuckets();
    if (bucketsError) {
      return {
        ok: false,
        error: `Error al verificar el bucket de Storage: ${bucketsError.message}`,
      };
    }
    const bucketExists = buckets?.some((b) => b.name === BUCKET_NAME);
    if (!bucketExists) {
      return {
        ok: false,
        error:
          "Bucket 'analytics-exports' no configurado. Pedile al ops team que lo cree en Supabase Storage.",
      };
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = `${user.id}/${timestamp}.${ext}`;
    const fileBuffer = Buffer.from(fileContent, "utf-8");

    const { error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(filePath, fileBuffer, {
        contentType: format === "csv" ? "text/csv; charset=utf-8" : "application/json",
        upsert: false,
      });

    if (uploadError) {
      return { ok: false, error: `Error al subir el archivo: ${uploadError.message}` };
    }

    // 6. Generate signed URL (24h TTL).
    const TTL_SECONDS = 60 * 60 * 24;
    const { data: signedData, error: signedError } = await supabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(filePath, TTL_SECONDS);

    if (signedError || !signedData?.signedUrl) {
      return { ok: false, error: "Error al generar el link de descarga." };
    }

    const signedUrl = signedData.signedUrl;

    // 7. Send email via Resend. Skip if RESEND_API_KEY is not configured.
    // Resolve the user's email from the Supabase auth session (the auth guard
    // only returns `user.id` — fetch the full user object for the email address).
    const {
      data: { user: authUser },
    } = await supabase.auth.getUser();
    const recipientEmail = authUser?.email;

    let emailSent = false;
    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey && recipientEmail) {
      try {
        const resend = new Resend(resendKey);
        const { error: emailError } = await resend.emails.send({
          from: resolveMailSender(process.env),
          to: recipientEmail,
          subject: "Tu export de analytics está listo",
          html: `
            <p>Hola,</p>
            <p>Tu export de analytics está listo para descargar.</p>
            <p>
              <strong>Slices incluidos:</strong> ${requestedSlices.join(", ")}<br>
              <strong>Formato:</strong> ${format.toUpperCase()}
            </p>
            <p>
              <a href="${signedUrl}">Descargar export</a>
            </p>
            <p>
              <em>Este link vence en 24 horas por razones de seguridad (Ley 25.326 de Protección de Datos Personales).</em>
            </p>
            <p>Si no solicitaste este export, ignorá este mensaje.</p>
          `,
        });
        if (emailError) {
          // Non-fatal: log and continue. The user can copy the URL from the page.
          console.warn("[generateExportAction] Resend email error:", emailError);
        } else {
          emailSent = true;
        }
      } catch (emailErr) {
        console.warn("[generateExportAction] Resend threw:", emailErr);
      }
    } else {
      console.warn("[generateExportAction] RESEND_API_KEY not set — skipping email send.");
    }

    // 8. Insert audit_log row.
    const rowCounts: Record<string, number> = {};
    const rejectedCounts: Record<string, number> = {};
    for (const slice of requestedSlices) {
      rowCounts[slice] = sliceData[slice]?.rows.length ?? 0;
      rejectedCounts[slice] = sliceData[slice]?.rejected ?? 0;
    }

    await db.insert(auditLog).values({
      actorUserId: profile.id,
      action: "analytics_export_generated",
      payload: {
        schema_version: EXPORT_SCHEMA_VERSION,
        includes: requestedSlices,
        format,
        period: {
          since: period.since?.toISOString() ?? null,
          until: period.until?.toISOString() ?? null,
        },
        jurisdiction: {
          province: adminProvince ?? null,
          locality: adminLocality ?? null,
          filtered_jurisdiction_count: filteredJurisdictions.length,
        },
        file_path: filePath,
        row_counts: rowCounts,
        rejected_counts: rejectedCounts,
      },
    });

    return { ok: true, signedUrl, emailSent };
  } catch (err) {
    // A drifted period vocabulary is a NAMED failure, not an "unexpected
    // error" — the whole point of RA-2 F11 is that this case must be loud.
    // No file is produced and no audit row is written, so nothing false is
    // persisted.
    if (err instanceof UnknownExportPeriodError) {
      console.error("[generateExportAction] unknown period preset:", err.received);
      return {
        ok: false,
        error:
          "No pudimos interpretar el período seleccionado. Elegí uno de los períodos del selector y volvé a intentar.",
      };
    }
    console.error("[generateExportAction] unexpected error:", err);
    return {
      ok: false,
      error: "Ocurrió un error inesperado al generar el export. Intentá de nuevo.",
    };
  }
}
