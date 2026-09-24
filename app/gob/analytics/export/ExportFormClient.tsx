"use client";

// Client wrapper for the analytics export form.
// Surfaces the signedUrl returned by generateExportAction using useActionState.
// On error, shows the error message inline.
//
// P1-6 fix: hidden inputs must reflect the LIVE URL state that the PeriodPicker
// updates client-side, not the SSR snapshot passed as props. We read period/from/to
// from useSearchParams() so a PeriodPicker change is immediately mirrored into the
// form before submission.

import { useSearchParams } from "next/navigation";
import { useActionState } from "react";

import { JurisdictionSwitcher } from "@/components/gob/JurisdictionSwitcher";
import { PeriodPicker } from "@/components/gob/PeriodPicker";
import { LnButton } from "@/components/ui/Button";
import { LnCheckbox } from "@/components/ui/Field";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { type GenerateExportResult, generateExportAction } from "./actions";
import { EXPORT_DEFAULT_PRESET } from "./export-period";

type ExportState =
  | { status: "idle" }
  | { status: "ok"; signedUrl: string; emailSent: boolean }
  | { status: "error"; error: string };

const initialState: ExportState = { status: "idle" };

async function submitAction(_prev: ExportState, formData: FormData): Promise<ExportState> {
  const result: GenerateExportResult = await generateExportAction(formData);
  if (result.ok) {
    return { status: "ok", signedUrl: result.signedUrl, emailSent: result.emailSent };
  }
  return { status: "error", error: result.error };
}

export function ExportFormClient({
  allowedProvinces,
  localities,
  period: ssrPeriod,
  from: ssrFrom,
  to: ssrTo,
  province: ssrProvince,
  locality: ssrLocality,
}: {
  allowedProvinces: Array<{ code: string; name: string }>;
  localities: Array<{ slug: string; name: string }>;
  period: string;
  from: string;
  to: string;
  province: string;
  locality: string;
}) {
  // forms/react19-reset-data-loss-inventory: "slice" and "format" are
  // uncontrolled checkbox/radio groups whose defaultChecked (bare boolean or
  // absent) is STATIC — a rejected submit falls each back to that fixed
  // value, discarding whichever slices/format were actually picked.
  const { boundAction, keptChecked } = useKeptFields<ExportState>(submitAction);
  const [state, dispatch, pending] = useActionState(boundAction, initialState);
  // Read live URL state so the hidden inputs always match the currently-selected
  // period AND jurisdiction, even after the PeriodPicker/JurisdictionSwitcher
  // update the URL client-side (full document nav — see JurisdictionSwitcher's
  // own design note). Previously only period/from/to were mirrored here, so
  // narrowing the province/locality via the switcher visibly updated the form
  // but silently had NO effect on the generated export (view↔export honesty
  // gap, Fase C 2026-07-21 — fixed alongside the server action).
  const searchParams = useSearchParams();
  const period = searchParams.get("period") ?? ssrPeriod;
  const from = searchParams.get("from") ?? ssrFrom;
  const to = searchParams.get("to") ?? ssrTo;
  const province = searchParams.get("province") ?? ssrProvince;
  const locality = searchParams.get("locality") ?? ssrLocality;

  return (
    <form action={dispatch} className="space-y-6">
      {/* Hidden inputs carrying PeriodPicker + JurisdictionSwitcher state
          from the LIVE URL (useSearchParams). These update reactively when the
          PeriodPicker/JurisdictionSwitcher change the URL so the export
          matches the displayed charts AND the selected jurisdiction. */}
      <input type="hidden" name="period" value={period} />
      {from && <input type="hidden" name="from" value={from} />}
      {to && <input type="hidden" name="to" value={to} />}
      {province && <input type="hidden" name="province" value={province} />}
      {locality && <input type="hidden" name="locality" value={locality} />}

      {/* Period selector */}
      <section className="space-y-2">
        <h2 className="text-md font-medium text-ln-op-ink">Periodo</h2>
        <PeriodPicker defaultPreset={EXPORT_DEFAULT_PRESET} />
      </section>

      {/* Jurisdiction selector */}
      <section className="space-y-2">
        <h2 className="text-md font-medium text-ln-op-ink">Jurisdiccion</h2>
        <JurisdictionSwitcher allowedProvinces={allowedProvinces} localities={localities} />
      </section>

      {/* Data slices */}
      <fieldset className="space-y-2">
        <legend className="text-md font-medium text-ln-op-ink">Datos a incluir</legend>
        <div className="space-y-2 pt-1">
          <LnCheckbox name="slice" value="pets" defaultChecked={keptChecked("slice", true, "pets")}>
            Mascotas (anonimizado)
          </LnCheckbox>
          <LnCheckbox
            name="slice"
            value="events"
            defaultChecked={keptChecked("slice", false, "events")}
          >
            Eventos
          </LnCheckbox>
          <LnCheckbox
            name="slice"
            value="cases"
            defaultChecked={keptChecked("slice", false, "cases")}
          >
            Casos
          </LnCheckbox>
          <LnCheckbox
            name="slice"
            value="organizations"
            defaultChecked={keptChecked("slice", false, "organizations")}
          >
            Organizaciones
          </LnCheckbox>
        </div>
      </fieldset>

      {/* Format */}
      <fieldset className="space-y-2">
        <legend className="text-md font-medium text-ln-op-ink">Formato</legend>
        <div className="flex flex-col gap-2 pt-1">
          <label className="flex items-center gap-2 text-md cursor-pointer">
            <input
              type="radio"
              name="format"
              value="csv"
              defaultChecked={keptChecked("format", true, "csv")}
              className="accent-ln-op-azul"
            />
            CSV
          </label>
          <label className="flex items-center gap-2 text-md cursor-pointer">
            <input
              type="radio"
              name="format"
              value="json"
              defaultChecked={keptChecked("format", false, "json")}
              className="accent-ln-op-azul"
            />
            JSON
          </label>
          {/* Deshabilitado a propósito, no por olvido (decisión del PO
              2026-08-04, principio P1): una opción deshabilitada está bien
              cuando la cosa hace falta de verdad pero no la podemos hacer
              ahora. Lo que se corrige es la PROMESA: "próximamente" anunciaba
              una fecha que nadie fijó. "Todavía no disponible" dice lo mismo
              sin comprometer un plazo. Mismo idioma que ADR-17c. */}
          <label
            className="flex items-center gap-2 text-md opacity-50"
            title="Formato columnar para procesamiento analítico. Todavía no está construido."
          >
            <input
              type="radio"
              name="format"
              value="parquet"
              defaultChecked={keptChecked("format", false, "parquet")}
              disabled
            />
            Parquet — todavía no disponible
          </label>
        </div>
      </fieldset>

      <LnButton type="submit" disabled={pending}>
        {pending ? "Generando…" : "Generar exportación"}
      </LnButton>

      {/* Error state */}
      {state.status === "error" && (
        <p className="text-md font-medium text-ln-op-danger" role="alert">
          {state.error}
        </p>
      )}

      {/* Success state: show download link */}
      {state.status === "ok" && (
        <div className="space-y-3 rounded-lg border border-ln-op-line bg-ln-op-card p-4">
          <p className="text-md font-medium text-ln-op-ink">Exportación lista</p>
          <a
            href={state.signedUrl}
            download
            className="inline-flex items-center gap-1 text-md font-medium text-ln-op-azul underline underline-offset-2 hover:opacity-80"
          >
            Descargar exportación →
          </a>
          <p className="text-sm text-ln-op-mute">
            Este link vence en 24 horas (Ley 25.326 de Proteccion de Datos Personales).
            {state.emailSent
              ? " También te enviamos el link por email."
              : " No se envió por email — RESEND_API_KEY no está configurado."}
          </p>
        </div>
      )}
    </form>
  );
}
