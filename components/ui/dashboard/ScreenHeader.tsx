// ScreenHeader — the ONE consistent mechanism for the hub/tab title-duplication
// fix (PO validacion-A 2026-07-23: "se repite Alcance comunitario en el título
// y tab, sospecho que en todas las tabs pasa esto").
//
// WHY: several former standalone /gob pages were relocated to render as TAB
// VISTAS inside a hub (padron/casos/directorio/denuncias/operativos — the
// 2026-07-22 "fusion" work). Each relocated screen kept its OWN eyebrow+h1,
// written back when it was a top-level page. Once embedded under a hub's tab
// strip, that eyebrow/h1 sits directly beneath a tab that already names the
// exact same thing — e.g. AlcanceScreen's own eyebrow ("Alcance comunitario")
// repeating the Operativos hub's "Alcance comunitario" tab label verbatim.
//
// The hub's OWN <h1> + the active tab already establish the screen's identity.
// `underHub` suppresses the screen's eyebrow + h1 in that context and keeps
// ONLY the subtitle — the one part of a relocated header that still adds
// information the tab label never carried (role/jurisdiction scope, counts,
// glossary expansions, etc.).
//
// `subtitle` is a fully-formed ReactNode (the caller supplies its own <p>
// tag(s), including className) rather than a bare string — several screens
// need MORE than one subtitle line (e.g. CredencialesScreen's glossary
// expansion + purpose + scope line), and wrapping an already-multi-<p>
// fragment in another <p> would be invalid HTML. Passing the ready-made
// node through (both under a hub and standalone) keeps ONE code path for
// both cases instead of two.
//
// One mechanism, reused by every relocated screen (CensoScreen, CasosScreen,
// DisputasScreen, OrganizacionesScreen, UsuariosScreen, ServiciosScreen,
// CredencialesScreen, ModeracionQueueScreen, AlcanceScreen, CampanasScreen +
// their admin twins) — not a per-screen conditional hack.
import type { ReactNode } from "react";

export type ScreenHeaderProps = {
  /** The "X · Y" line above the h1. Suppressed when `underHub`. */
  eyebrow?: ReactNode;
  /** The screen's own title. Suppressed when `underHub` (the hub's h1 + active tab already say this). */
  title: ReactNode;
  /**
   * Extra info the tab label never carried (scope, counts, glossary) — ALWAYS
   * shown, even under a hub. Pass fully-formed node(s) (its own <p> tag(s));
   * ScreenHeader renders it as-is, it does not wrap it in another element.
   */
  subtitle?: ReactNode;
  /** True when this screen renders embedded under a hub tab. */
  underHub?: boolean;
  /** Wrapper spacing — matches whatever the original standalone header used (space-y-1/space-y-2). Default "space-y-1". */
  className?: string;
};

export function ScreenHeader({
  eyebrow,
  title,
  subtitle,
  underHub = false,
  className = "space-y-1",
}: ScreenHeaderProps) {
  if (underHub) {
    return subtitle ? <>{subtitle}</> : null;
  }
  return (
    <header className={className}>
      {eyebrow && (
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">{eyebrow}</p>
      )}
      <h1 className="text-title font-semibold text-ln-op-ink">{title}</h1>
      {subtitle}
    </header>
  );
}
