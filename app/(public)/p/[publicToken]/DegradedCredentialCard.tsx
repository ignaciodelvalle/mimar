// Degraded public credential — rendered when the DB reads behind the QR page
// fail or exceed their time budget. The anonymous finder scanning a QR in the
// street must NEVER see a crash page: this card keeps the credential frame,
// says honestly that data could not be loaded, and — when the pet row itself
// resolved — keeps the critical lost-mode CTAs alive (aviso forms are separate
// routes with their own reads, so they can succeed even when this page's
// fan-out failed).
//
// Honesty rule: this state is visually DISTINCT (warn-toned band + explicit
// "DATOS INCOMPLETOS" stamp). It never fakes empty data as real data.

import { Icon } from "@/components/Icon";
import { foundPossessivePhrase, sightingPhrase } from "@/lib/utils/format";

export function DegradedCredentialCard({
  publicToken,
  petName = null,
  petSex = null,
  isLost = false,
  allowFinderForm = false,
}: {
  publicToken: string;
  /** Known only when the pet row resolved before the failure. */
  petName?: string | null;
  petSex?: string | null;
  /** Lost status known → keep the finder/sighting CTAs reachable. */
  isLost?: boolean;
  allowFinderForm?: boolean;
}) {
  return (
    // Landing shell (AppShell variant=landing) owns #main-content + min-height.
    <div className="min-h-screen bg-ln-paper font-ln-sans">
      {/* Guilloché band — kept so the page still reads as the credential. */}
      <div
        aria-hidden="true"
        className="h-[4px] flex-shrink-0 opacity-90"
        style={{
          background:
            "repeating-linear-gradient(90deg,var(--color-ln-azul) 0 2px,transparent 2px 4px),var(--color-ln-celeste)",
        }}
      />

      <div className="mx-auto max-w-[460px] px-4 py-6 pb-14">
        <div
          data-section="degraded-credential"
          className="overflow-hidden rounded-[var(--radius-input)] border border-ln-warn-100 bg-ln-card shadow-[var(--shadow-md)]"
        >
          {/* Warn-toned strip — visually distinct from the healthy card's band. */}
          <div aria-hidden="true" className="h-[8px] bg-ln-warn-050" />

          <div className="flex flex-wrap items-center gap-2 border-b border-ln-line-2 px-4 py-2.5">
            <div
              aria-hidden="true"
              className="grid h-[26px] w-[26px] flex-shrink-0 place-items-center rounded-full border-[1.5px] border-ln-azul bg-ln-celeste-050 font-ln-serif text-sm font-semibold text-ln-azul"
            >
              m
            </div>
            <div className="min-w-0 flex-1">
              <span className="font-ln-serif text-sm font-semibold text-ln-ink">miMAR</span>
              <span className="block font-ln-mono text-xs uppercase tracking-[.14em] text-ln-mute">
                Credencial pública
              </span>
            </div>
            <span className="rounded-full border border-ln-warn-100 bg-ln-warn-050 px-2 py-0.5 font-ln-mono text-xs font-semibold tracking-[.08em] text-ln-warn">
              DATOS INCOMPLETOS
            </span>
          </div>

          <div role="alert" className="px-4 py-5">
            {/* Always render a real h1 — even when the pet row itself failed
                to resolve, a screen-reader user landing on this fail-soft
                state still needs page orientation. */}
            <h1 className="m-0 font-ln-serif text-xl font-semibold text-ln-ink">
              {petName ?? "Credencial"}
            </h1>
            <p className="mt-2 text-md leading-[1.6] text-ln-ink-2">
              No pudimos cargar todos los datos. Reintentá en unos segundos.
            </p>

            <a
              href={`/p/${publicToken}`}
              className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-full border border-ln-line bg-ln-card px-5 text-sm font-semibold text-ln-ink hover:bg-ln-stripe"
            >
              Reintentar
            </a>
          </div>

          {/* Lost-mode CTAs — the aviso routes run their own reads, so they may
              work even while this page's data load is failing. Only rendered
              when the pet row resolved and told us the pet is lost. */}
          {isLost && (
            <div
              data-section="degraded-lost-ctas"
              className="border-t border-ln-line bg-ln-stripe px-4 py-3.5"
            >
              <p className="m-0 mb-2 text-sm font-semibold text-ln-ink">
                ¿{petName ? `Viste a ${petName}` : "Viste a esta mascota"}? Avisale al dueño:
              </p>
              <div className="flex flex-wrap gap-2">
                {allowFinderForm && (
                  <a
                    href={`/p/${publicToken}/encontre`}
                    className="inline-flex min-h-11 items-center gap-2 rounded-full bg-ln-azul px-5 text-sm font-semibold text-white hover:bg-ln-azul-700"
                  >
                    <Icon name="ubicacion" size="sm" decorative /> {foundPossessivePhrase(petSex)}
                  </a>
                )}
                <a
                  href={`/p/${publicToken}/sighting`}
                  className="inline-flex min-h-11 items-center gap-2 rounded-full border border-ln-line bg-ln-card px-5 text-sm font-semibold text-ln-ink hover:bg-ln-stripe"
                >
                  <Icon name="ojo" size="sm" decorative /> {sightingPhrase(petSex)}
                </a>
              </div>
            </div>
          )}

          <div className="px-4 py-3 text-center font-ln-mono text-xs leading-[1.7] tracking-[.02em] text-ln-faint">
            {/* See the note on the same footer in page.tsx: "· República
                Argentina" named the State as issuing authority and is gone. */}
            CREDENCIAL PÚBLICA · miMAR · Registro Nacional de Mascotas
            <br />
            {publicToken.toUpperCase()}
          </div>
        </div>
      </div>
    </div>
  );
}
