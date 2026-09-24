"use client";

import { useState, useTransition } from "react";

import { eraseMySubjectDataAction, exportMySubjectDataAction } from "@/app/actions/subject-rights";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import { type SubjectRightsSection, subjectRightsSections } from "@dim/contract/reference";

export function PrivacyActions() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState(false);
  // Ver mis datos — PO decision 13A: alongside the raw JSON download (which
  // stays complete and untouched, see `exportSubjectDataFor`), the page shows
  // a human-readable "what do you have on me" summary. `sections` is null
  // until the first successful export; it is NOT re-derived from `exported`
  // alone so a failed re-fetch after a first success does not keep showing a
  // stale list next to a fresh error.
  const [sections, setSections] = useState<SubjectRightsSection[] | null>(null);
  const [showErase, setShowErase] = useState(false);
  const [eraseReason, setEraseReason] = useState("");

  function handleExport() {
    setError(null);
    setExported(false);
    startTransition(async () => {
      const result = await exportMySubjectDataAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const json = JSON.stringify(result.data, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const filename = `mimar-mis-datos-${new Date().toISOString().slice(0, 10)}.json`;
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      // Computed from the SAME `result.data` the download used — the readable
      // list and the file on disk are two views of one response, never two
      // requests that could disagree.
      setSections(subjectRightsSections(result.data));
      setExported(true);
    });
  }

  function handleErase() {
    setError(null);
    startTransition(async () => {
      const result = await eraseMySubjectDataAction(eraseReason);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Post-erase the session is dead: a soft push("/") + router.refresh()
      // races the auth teardown (and router.refresh() is banned anyway — it
      // rides the same client-router transition machinery as the silent-drop
      // defect; see lib/ui/full-page-action-nav.ts). One full document
      // navigation lands on "/" with a fresh, unauthenticated SSR pass.
      navigateAfterActionSuccess("/");
    });
  }

  return (
    <div className="space-y-6">
      {error && (
        <p
          className="rounded-[var(--radius-sm)] border border-[var(--color-ln-seal)]/40 bg-[var(--color-ln-err-050)] px-4 py-3 text-sm text-[var(--color-ln-seal)]"
          role="alert"
        >
          {error}
        </p>
      )}

      <section className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] p-5 space-y-3">
        <div>
          <h2 className="text-base font-semibold text-[var(--color-ln-ink)]">
            Descargar mis datos
          </h2>
          <p className="text-sm text-[var(--color-ln-mute)] mt-1">
            Bajás un JSON con tu perfil, tus mascotas, sus identificaciones y los eventos sanitarios
            asociados. Ley 25.326, art. 14 (derecho de acceso).
          </p>
        </div>
        <button
          type="button"
          onClick={handleExport}
          disabled={pending}
          className="rounded-[var(--radius-pill)] bg-[var(--color-ln-azul)] px-4 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-ln-azul-700)] disabled:opacity-50 transition-colors"
        >
          {pending ? "Generando…" : "Descargar JSON"}
        </button>
        {exported && (
          <output className="block text-sm text-[var(--color-ln-ok)]">
            Datos descargados correctamente.
          </output>
        )}
        {exported && sections && sections.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-ln-ink)]">
              Un resumen de lo que guardamos sobre vos
            </h3>
            <p className="mt-1 text-xs text-[var(--color-ln-mute)]">
              El JSON que descargaste tiene todo, completo.
            </p>
            <dl className="mt-2 divide-y divide-[var(--color-ln-line)] text-sm">
              {sections.map((section) => (
                <div key={section.key} className="flex items-center justify-between py-1.5">
                  <dt className="text-[var(--color-ln-ink-2)]">{section.label}</dt>
                  <dd className="text-[var(--color-ln-mute)]">{section.summary}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </section>

      <section className="rounded-[var(--radius-sm)] border border-[var(--color-ln-seal)]/30 bg-[var(--color-ln-err-050)]/30 p-5 space-y-3">
        <div>
          <h2 className="text-base font-semibold text-[var(--color-ln-ink)]">Eliminar mi cuenta</h2>
          <p className="text-sm text-[var(--color-ln-ink-2)] mt-1">
            Soft-delete con hash de PII. Tu cuenta queda fuera del sistema; los eventos sanitarios
            de tus mascotas se conservan como historial de salud del animal (ver nota debajo). Ley
            25.326, art. 16 (derecho de supresión).
          </p>
        </div>
        {showErase ? (
          <div className="space-y-3">
            <label
              className="block text-sm font-medium text-[var(--color-ln-ink)]"
              htmlFor="erase-reason"
            >
              Motivo (mínimo 5 caracteres)
            </label>
            <textarea
              id="erase-reason"
              rows={2}
              maxLength={500}
              value={eraseReason}
              onChange={(e) => setEraseReason(e.target.value)}
              className="w-full rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-3 py-2 text-sm text-[var(--color-ln-ink)] outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)]"
              placeholder="Ya no uso miMAR / migración a otra plataforma / …"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowErase(false)}
                className="flex-1 rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-3 py-2 text-sm font-medium text-[var(--color-ln-ink)] hover:bg-[var(--color-ln-stripe)] transition-colors"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleErase}
                disabled={pending || eraseReason.trim().length < 5}
                className="flex-1 rounded-[var(--radius-pill)] bg-[var(--color-ln-seal)] px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 transition-colors"
              >
                {pending ? "Procesando…" : "Confirmar borrado"}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowErase(true)}
            className="rounded-[var(--radius-pill)] border border-[var(--color-ln-seal)]/40 bg-[var(--color-ln-card)] px-4 py-2.5 text-sm font-medium text-[var(--color-ln-seal)] hover:bg-[var(--color-ln-err-050)]/50 transition-colors"
          >
            Quiero eliminar mi cuenta
          </button>
        )}
      </section>
    </div>
  );
}
