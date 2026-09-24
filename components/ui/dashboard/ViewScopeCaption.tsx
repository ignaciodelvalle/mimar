// ViewScopeCaption — C3 (ONE VIEWSCOPE, plan-maestro-integridad §C3).
//
// The page-level disclosure that closes the gap `lib/ui/scope-chrome.ts`
// deliberately leaves open: when a page's OWN filter narrows the view BELOW
// the operator's mandate (the shared layout badge), the operator needs an
// explicit "Vista: …" — otherwise the layout's mandate is the only scope
// claim on screen and a narrower view reads as if it WERE the mandate (the
// verified S3 confusion, one level down: a 5-locality govt viewing just one
// of them, or an admin drilled into a single province).
//
// Purely presentational — fed the ALREADY-computed string from
// `describeNarrowedView` (lib/ui/view-scope-caption.ts). Renders nothing when
// there is nothing to disclose (view === mandate), so an unfiltered page never
// grows a redundant second scope line.

export function ViewScopeCaption({ scope }: { scope: string | null }) {
  if (!scope) return null;

  return (
    <p className="text-xs text-ln-op-mute">
      Vista: <span className="font-medium text-ln-op-ink-2">{scope}</span> · filtro activo
    </p>
  );
}
