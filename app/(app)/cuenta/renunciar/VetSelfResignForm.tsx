"use client";

// Client component — vet self-resignation form (Slice 3d, §7.8).
// Destructive action: warning-first design (cognitive-doc-design pattern).
// On submit: calls vetSelfResignAction → redirects to /cuenta with success banner.

import { useRouter } from "next/navigation";
import { useState } from "react";

import { vetSelfResignAction } from "@/app/actions/profile-self-service";
import { LnCheckbox } from "@/components/ui/Field";
import { UNKNOWN_ERROR_FALLBACK } from "@/lib/ui/error-fallback";

export function VetSelfResignForm() {
  const router = useRouter();

  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!confirmed) return;
    setError(null);
    setLoading(true);

    try {
      const result = await vetSelfResignAction({ reason: reason.trim() || undefined });

      if ("error" in result) {
        setError(result.error);
        setLoading(false);
        return;
      }

      // Success — redirect to /cuenta; the page banner is a URL param so it
      // survives the router navigation without extra state management.
      router.push("/cuenta?banner=resignation_confirmed");
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

      {/* Warning — consequence list (warning-first design) */}
      <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-warn-050)] p-5 space-y-3">
        <p className="text-sm font-semibold text-[var(--color-ln-warn)]">
          Estas son las consecuencias de renunciar:
        </p>
        <ul className="space-y-1.5">
          {[
            "Perderás la posibilidad de escribir eventos como veterinario/a.",
            "Tu matrícula quedará registrada pero marcada como NO verificada.",
            "Tus mascotas propias siguen siendo tuyas.",
            "Para volver a tener el rol vet, vas a tener que solicitarlo de cero y ser aprobado/a nuevamente.",
          ].map((item) => (
            <li key={item} className="flex items-start gap-2 text-sm text-[var(--color-ln-warn)]">
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
          Motivo <span className="text-xs font-normal text-[var(--color-ln-mute)]">(opcional)</span>
        </label>
        <textarea
          id="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="Contanos por qué renunciás…"
          className="w-full text-sm rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-3 py-2 outline-none focus:border-[var(--color-ln-azul)] focus:shadow-[0_0_0_3px_var(--color-ln-celeste-050)] resize-none"
        />
      </div>

      {/* Confirm checkbox */}
      <LnCheckbox checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)}>
        Entiendo y confirmo que quiero renunciar a mi rol de veterinario/a.
      </LnCheckbox>

      {/* Action buttons */}
      <div className="flex gap-3 pt-2">
        <button
          type="submit"
          disabled={!confirmed || loading}
          className="px-5 py-2 text-sm bg-[var(--color-ln-seal)] text-white rounded-[var(--radius-pill)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? "Procesando..." : "Renunciar"}
        </button>
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
