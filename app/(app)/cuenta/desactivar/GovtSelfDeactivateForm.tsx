"use client";

// Client component — govt self-deactivation form (Slice 3d, §7.5).
// Destructive action: warning-first design (cognitive-doc-design pattern).
// Coverage state shown explicitly per-locality before any confirm/submit.
// On submit: calls govtSelfDeactivateAction → redirects to /cuenta.

import { useRouter } from "next/navigation";
import { useState } from "react";

import { govtSelfDeactivateAction } from "@/app/actions/profile-self-service";
import { LnCheckbox } from "@/components/ui/Field";
import { UNKNOWN_ERROR_FALLBACK } from "@/lib/ui/error-fallback";

type LocalityRow = {
  province: string;
  locality: string;
  otherActiveGovtCount: number;
};

export function GovtSelfDeactivateForm({ localities }: { localities: LocalityRow[] }) {
  const router = useRouter();

  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasUncoveredLocality = localities.some((l) => l.otherActiveGovtCount === 0);
  const canProceed = !hasUncoveredLocality;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!confirmed || !canProceed) return;
    setError(null);
    setLoading(true);

    try {
      const result = await govtSelfDeactivateAction({ reason: reason.trim() || undefined });

      if ("error" in result) {
        setError(result.error);
        setLoading(false);
        return;
      }

      router.push("/cuenta?banner=govt_deactivated");
    } catch (err) {
      setError(err instanceof Error ? err.message : UNKNOWN_ERROR_FALLBACK);
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Error banner */}
      {error && (
        <div
          role="alert"
          className="rounded-[var(--radius-sm)] bg-[var(--color-ln-err-050)] border border-[var(--color-ln-seal)] px-4 py-3"
        >
          <p className="text-sm text-[var(--color-ln-seal)]">{error}</p>
        </div>
      )}

      {/* My localities — coverage status per row */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-[var(--color-ln-ink)]">
          Mis localidades actualmente asignadas
        </h2>

        {localities.length === 0 ? (
          <p className="text-sm text-[var(--color-ln-mute)]">No tenés localidades asignadas.</p>
        ) : (
          <ul className="space-y-2">
            {localities.map((loc) => {
              const covered = loc.otherActiveGovtCount > 0;
              return (
                <li
                  key={`${loc.province}/${loc.locality}`}
                  className={`flex items-center justify-between rounded-[var(--radius-sm)] border px-4 py-3 ${
                    covered
                      ? "border-[var(--color-ln-ok)] bg-[var(--color-ln-ok-050)]"
                      : "border-[var(--color-ln-seal)] bg-[var(--color-ln-err-050)]"
                  }`}
                >
                  <span className="text-sm text-[var(--color-ln-ink-2)]">
                    {loc.province} / {loc.locality}
                  </span>
                  {covered ? (
                    <span className="text-xs font-medium text-[var(--color-ln-ok)]">
                      {loc.otherActiveGovtCount === 1
                        ? "1 otro govt activo"
                        : `${loc.otherActiveGovtCount} otros govts activos`}
                    </span>
                  ) : (
                    <span className="text-xs font-medium text-[var(--color-ln-seal)]">
                      Solo vos cubrís esta localidad
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Block banner — shown when at least one locality would be uncovered */}
      {hasUncoveredLocality && (
        <div
          role="alert"
          className="rounded-[var(--radius-sm)] border border-[var(--color-ln-seal)] bg-[var(--color-ln-err-050)] px-5 py-4 space-y-2"
        >
          <p className="text-sm font-semibold text-[var(--color-ln-seal)]">
            No podés desactivarte todavía.
          </p>
          <p className="text-sm text-[var(--color-ln-seal)]">
            Una o más localidades quedarían sin govt si te desactivás. Pedile a tu administrador que
            asigne otro govt a esas localidades antes de continuar.
          </p>
        </div>
      )}

      {/* Proceed section — only shown when coverage is OK */}
      {canProceed && (
        <>
          {/* Confirmation text */}
          <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-warn-050)] p-5 space-y-2">
            <p className="text-sm font-semibold text-[var(--color-ln-warn)]">
              Si confirmás la desactivación:
            </p>
            <ul className="space-y-1.5">
              {[
                "Tu cuenta va a quedar desactivada.",
                "Tus localidades pasan a los otros govts activos que ya las cubren.",
                "Los pedidos pendientes en tus localidades van a la cola de los otros govts o, como fallback, a la del admin.",
                "Tu usuario en el sistema se conserva (no se borra) pero no vas a poder acceder a esta sección.",
              ].map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-2 text-sm text-[var(--color-ln-warn)]"
                >
                  <span aria-hidden className="mt-0.5 shrink-0">
                    •
                  </span>
                  {item}
                </li>
              ))}
            </ul>
          </div>

          {/* Motivo (optional) */}
          <div>
            <label
              htmlFor="reason"
              className="block text-sm font-medium text-[var(--color-ln-ink-2)] mb-1"
            >
              Motivo{" "}
              <span className="text-xs font-normal text-[var(--color-ln-mute)]">(opcional)</span>
            </label>
            <textarea
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Contanos por qué desactivás tu cuenta…"
              className="w-full text-sm rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-3 py-2 outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)] resize-none"
            />
          </div>

          {/* Confirm checkbox */}
          <LnCheckbox checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)}>
            Entiendo y confirmo que quiero desactivar mi cuenta de operador govt.
          </LnCheckbox>
        </>
      )}

      {/* Action buttons */}
      <div className="flex gap-3 pt-2">
        {canProceed && (
          <button
            type="submit"
            disabled={!confirmed || loading}
            className="px-5 py-2 text-sm bg-[var(--color-ln-seal)] text-white rounded-[var(--radius-pill)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? "Procesando..." : "Desactivar cuenta"}
          </button>
        )}
        <a
          href="/cuenta"
          className="px-5 py-2 text-sm border border-[var(--color-ln-line-strong)] rounded-[var(--radius-pill)] hover:bg-[var(--color-ln-stripe)] transition-colors"
        >
          Cancelar
        </a>
      </div>
    </form>
  );
}
