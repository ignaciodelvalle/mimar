import Link from "next/link";

/**
 * Denuncias hub — public entry point for the welfare-report portal.
 *
 * Sub-routes:
 *   /denuncias/nueva   — file a new report (anonymous-friendly)
 *   /denuncias/buscar  — look up an existing report by reference code
 *
 * The (public) route-group layout already renders AppHeader + AppFooter;
 * this page does not add them again.
 */
export default function DenunciasPage() {
  return (
    <div className="bg-[var(--color-ln-paper)]">
      <div className="mx-auto max-w-2xl px-4 py-12 md:px-6">
        {/* Header */}
        <header className="mb-10 space-y-3">
          <p
            className="text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]"
            style={{ fontFamily: "var(--font-ln-mono)" }}
          >
            Portal de bienestar animal
          </p>
          <h1
            className="text-4xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]"
            style={{ fontFamily: "var(--font-ln-serif)" }}
          >
            Denuncias
          </h1>
          <p className="max-w-prose text-base leading-relaxed text-[var(--color-ln-ink-2)]">
            Reportá situaciones de maltrato, abandono o negligencia animal. Cada denuncia queda
            registrada con un código de seguimiento y es derivada a la autoridad correspondiente.
            Podés denunciar de forma anónima.
          </p>
        </header>

        {/* Entry points */}
        <div className="flex flex-col gap-4">
          {/* Primary CTA */}
          <Link
            href="/denuncias/nueva"
            className="group flex items-start gap-4 rounded-[var(--radius-md)] border border-[var(--color-ln-azul)] bg-[var(--color-ln-celeste-050)] px-5 py-5 no-underline transition-colors hover:bg-[var(--color-ln-celeste-100)]"
          >
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-ln-azul)] text-white">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </div>
            <div>
              <p className="text-md font-semibold text-[var(--color-ln-azul)]">
                Hacer una denuncia
              </p>
              <p className="mt-0.5 text-md text-[var(--color-ln-ink-2)]">
                Reportá maltrato, abandono o negligencia. Recibís un código de seguimiento al
                enviar.
              </p>
            </div>
          </Link>

          {/* Secondary CTA */}
          <Link
            href="/denuncias/buscar"
            className="group flex items-start gap-4 rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] px-5 py-5 no-underline transition-colors hover:border-[var(--color-ln-line-strong)] hover:bg-[var(--color-ln-stripe)]"
          >
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-white text-[var(--color-ln-ink-2)]">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </div>
            <div>
              <p className="text-md font-semibold text-[var(--color-ln-ink)]">
                Consultar estado de una denuncia
              </p>
              <p className="mt-0.5 text-md text-[var(--color-ln-ink-2)]">
                Ingresá el código de seguimiento que recibiste al enviar tu denuncia.
              </p>
            </div>
          </Link>
        </div>

        {/* Legal note */}
        <aside className="mt-10 rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-5 py-4">
          <p className="text-md leading-relaxed text-[var(--color-ln-mute)]">
            <strong className="font-semibold text-[var(--color-ln-ink-2)]">Aviso:</strong> Las
            denuncias registradas en este portal son derivadas a las autoridades competentes
            conforme a la Ley 14.346. La integración con canales gubernamentales está en desarrollo
            — tu denuncia queda guardada y será enviada cuando esté disponible.
          </p>
        </aside>
      </div>
    </div>
  );
}
