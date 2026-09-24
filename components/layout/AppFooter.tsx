import { BRANDING } from "@/lib/ui/branding";
import Link from "next/link";
import { GobStripe } from "./GobStripe";

/**
 * Footer institucional liviano.
 *
 * Estructura:
 *   - Bloque principal blanco con links de producto + institucionales.
 *   - Línea de licencia CC + aclaración de independencia del Estado.
 *   - Cinta argentina al pie (espejo del header).
 */

type FooterLink = { href: string; label: string; external?: boolean };

type Column = { title: string; links: FooterLink[] };

// Exported for __tests__/footer-dead-end-fitness.test.ts, which holds this
// list and the landing footer's FOOTER_NAV to the same dead-end exclusions.
export const DEFAULT_COLUMNS: Column[] = [
  {
    title: "Producto",
    links: [
      { href: "/", label: "Inicio" },
      { href: "/perdidas", label: "Mascotas perdidas" },
      { href: "/adoptar", label: "Adoptar" },
      { href: "/denuncias", label: "Denuncias" },
      // Session-aware destination (tester fix #9): with an active session the
      // old /login target showed the login page instead of the libreta.
      // /mis-mascotas sits behind the (app) auth guard, so logged-in users
      // land on their libreta and anonymous visitors are bounced to /login —
      // the same place the link used to take them.
      { href: "/mis-mascotas", label: "Mi libreta" },
    ],
  },
  {
    title: "Información",
    links: [
      { href: "/acerca", label: "Acerca de miMAR" },
      { href: "/ayuda", label: "Ayuda" },
      { href: "/accesibilidad", label: "Accesibilidad" },
      // /sugerencias — hidden while it was a "muy pronto" placeholder. Since
      // pilot T1-P5 it names a mailbox a person reads; restoring the link (in
      // BOTH footers) is a separate call, not taken in that change.
    ],
  },
  {
    title: "Legales",
    links: [
      { href: "/terminos", label: "Términos y condiciones" },
      { href: "/privacidad", label: "Política de privacidad" },
      { href: "/cookies", label: "Cookies" },
      { href: "/leyes", label: "Marco legal" },
      { href: "/transparencia", label: "Transparencia activa" },
    ],
  },
];

type Props = {
  columns?: Column[];
  /**
   * PO quick win X1 (2026-07-24): the owner home is pet-first — fold the
   * legal/institutional link cluster (Información + Legales columns + the CC
   * license / independence line) under a closed-by-default <details>, so the
   * first screen is the owner's pets, not a wall of legal links. ALL links
   * stay present (legal compliance), just folded. `columns[0]` ("Producto",
   * the real navigation) stays visible either way — only the only caller
   * (AppShell's citizen variant) ever overrides `columns`, and never changes
   * its order, so this positional split is safe.
   */
  collapsed?: boolean;
};

function FooterNav({ col }: { col: Column }) {
  return (
    <nav aria-label={col.title}>
      <h2 className="text-sm font-bold text-ln-ink-2">{col.title}</h2>
      <ul className="mt-3 space-y-2">
        {col.links.map((l) => (
          <li key={l.href}>
            <Link
              href={l.href}
              target={l.external ? "_blank" : undefined}
              rel={l.external ? "noopener noreferrer" : undefined}
              className="text-sm text-ln-ink-2 no-underline hover:text-ln-azul hover:underline"
            >
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function LegalLine() {
  return (
    <div className="flex flex-col gap-3 text-xs text-ln-mute md:flex-row md:items-center md:justify-between">
      <p>
        Los datos abiertos están licenciados bajo{" "}
        <a
          href="https://creativecommons.org/licenses/by/4.0/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-ln-azul hover:underline"
        >
          Creative Commons Atribución 4.0 Internacional (CC BY 4.0)
        </a>
        .
      </p>
      {/* A bare link to argentina.gob.ar used to sit here. In the gob.ar
          footer convention that link is precisely the mark of a state site,
          and miMAR is not one — it carried no information, only the
          affiliation. Replaced by the fact itself. */}
      <p>miMAR es un servicio independiente: no es un sitio oficial del Estado argentino.</p>
    </div>
  );
}

export function AppFooter({ columns = DEFAULT_COLUMNS, collapsed = false }: Props) {
  const [primaryColumn, ...restColumns] = columns;

  return (
    <footer className="mt-12 bg-white">
      <div className="border-t border-ln-line">
        <div className="mx-auto max-w-6xl px-4 py-10 md:px-6">
          <div
            className={
              collapsed
                ? "grid grid-cols-1 gap-8 md:grid-cols-2"
                : "grid grid-cols-1 gap-8 md:grid-cols-4"
            }
          >
            {/* Marca + tagline */}
            <div>
              {/* One family for the wordmark — see the note in AppShell's
                  LandingShell. */}
              <p className="font-ln-serif text-lg font-bold text-ln-azul">{BRANDING.appName}</p>
              <p className="mt-1 text-sm text-ln-mute">
                {BRANDING.appNameLong} · {BRANDING.tagline}.
              </p>
              {/* "Una iniciativa pública" reads in es-AR as state-run. It is
                  not; the claim is replaced by one the product can back. */}
              <p className="mt-4 text-xs text-ln-mute">
                Un servicio gratuito para que cada animal cuente con su historia clínica portable.
              </p>
            </div>

            {primaryColumn && <FooterNav col={primaryColumn} />}

            {!collapsed && restColumns.map((col) => <FooterNav key={col.title} col={col} />)}
          </div>

          {collapsed ? (
            <details className="mt-10 border-t border-ln-line pt-6">
              <summary className="cursor-pointer text-sm font-medium text-ln-ink-2 hover:text-ln-azul">
                Acerca de miMAR
              </summary>
              <div className="mt-6 grid grid-cols-1 gap-8 md:grid-cols-2">
                {restColumns.map((col) => (
                  <FooterNav key={col.title} col={col} />
                ))}
              </div>
              <div className="mt-6">
                <LegalLine />
              </div>
            </details>
          ) : (
            <div className="mt-10 border-t border-ln-line pt-6">
              <LegalLine />
            </div>
          )}
        </div>
      </div>

      <GobStripe />
    </footer>
  );
}
