// PanoramaDemoDisclosure — the "Datos de demostración" notice for the Panorama
// console. Extracted from PanoramaShell so the suppression behaviour (D3) is
// unit-testable without rendering the client map console.
//
// When the GLOBAL demo banner is already shown (app/admin/layout.tsx, with
// NEXT_PUBLIC_DEMO_MODE=true), PanoramaShell passes hidden=true so /admin does
// not stack two identical disclosures. Under /gob (no global banner) the notice
// stays visible.

type Props = {
  /** Suppress the notice when a global demo banner already covers it. */
  hidden?: boolean;
};

export function PanoramaDemoDisclosure({ hidden = false }: Props) {
  if (hidden) return null;

  return (
    <p className="rounded-[var(--radius-md)] border border-ln-op-warn-bd bg-ln-op-warn-bg px-3 py-1.5 text-sm text-ln-op-ink-2">
      <span className="font-semibold">Datos de demostración.</span> El dataset cargado es sintético
      (densidad ponderada por Censo 2022); no representa casos reales.
    </p>
  );
}
