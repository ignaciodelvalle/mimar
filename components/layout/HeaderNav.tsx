"use client";

import { Icon } from "@/components/Icon";
import { BRANDING } from "@/lib/ui/branding";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";

export type NavItem = {
  href: string;
  label: string;
  matchPrefix?: string;
  /**
   * Additional active-state prefixes. When set, the item is active if the path
   * equals or is under ANY of these (e.g. "Mis mascotas" → /inicio stays active
   * while viewing a pet at /mis-mascotas/[token]). Takes precedence over
   * matchPrefix for the active check.
   */
  matchPrefixes?: string[];
  /** Optional numeric badge overlaid on the nav item (e.g. breach count). */
  badge?: number;
  /**
   * Deferred (not-yet-built) destination. Rendered as a non-interactive, muted
   * "Próximamente" affordance — visible in the IA so the population/custody
   * roadmap gap (vNext §1) is legible, but carries NO live route: no <Link>, no
   * middleware entry, no breadcrumb/omnibox resolution, never "active".
   * See plan dim-interno:docs/superpowers-private/plans/archive/2026-06-23-population-cycle-deferred-nav-handoff.md.
   */
  deferred?: boolean;
};

type Props = {
  nav: NavItem[];
  user?: { name: string; href?: string } | null;
};

function isActive(item: NavItem, currentPath: string | null): boolean {
  if (!currentPath) return false;
  if (item.matchPrefixes?.some((p) => currentPath === p || currentPath.startsWith(`${p}/`))) {
    return true;
  }
  if (item.matchPrefix) return currentPath.startsWith(item.matchPrefix);
  return currentPath === item.href;
}

/**
 * Nav del header — desktop inline + drawer mobile.
 * Marca el link activo automáticamente con usePathname() (sin necesidad de middleware).
 */
export function HeaderNav({ nav, user }: Props) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Cerrar drawer al navegar. The dependency on `pathname` is intentional —
  // we want the effect to re-fire on every navigation; biome's exhaustive-deps
  // rule wants stable setters too but those are guaranteed stable by React.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger; setOpen is React-stable
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <>
      {/* Nav desktop */}
      <nav
        className="ml-6 hidden flex-1 items-center gap-1 md:flex"
        aria-label="Navegación principal"
      >
        {nav.map((item) => {
          const active = isActive(item, pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`inline-flex items-center gap-1 rounded-md px-3 py-2 text-sm font-semibold no-underline transition-colors ${
                active
                  ? "bg-ln-stripe text-ln-azul"
                  : "text-ln-ink-2 hover:bg-ln-stripe hover:text-ln-azul"
              }`}
            >
              {item.label}
              {item.badge != null && item.badge > 0 && (
                <span className="ml-1 inline-flex items-center justify-center rounded-full bg-ln-seal px-1.5 py-0.5 text-xs font-semibold leading-none text-white">
                  {item.badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* CTA derecha desktop */}
      <div className="ml-auto hidden items-center gap-3 md:flex">
        {user ? (
          <Link
            href={user.href ?? "/cuenta"}
            className="flex items-center gap-2 rounded-full border border-ln-line px-3 py-2 text-sm font-semibold text-ln-azul no-underline hover:border-ln-line-strong"
          >
            <Icon name="usuarios" size={18} decorative />
            <span className="max-w-[14ch] truncate">{user.name}</span>
          </Link>
        ) : (
          <Link
            href="/iniciar-sesion"
            className="inline-flex min-h-11 items-center justify-center rounded-full bg-ln-azul px-6 text-sm font-semibold text-white no-underline hover:bg-ln-azul-700"
          >
            Iniciar sesión
          </Link>
        )}
      </div>

      {/* Botón mobile */}
      <div className="ml-auto md:hidden">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={open ? "Cerrar menú" : "Abrir menú"}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-ln-line text-ln-azul hover:border-ln-line-strong"
        >
          {open ? (
            <Icon name="close" size="lg" decorative />
          ) : (
            <Icon name="menu" size="lg" decorative />
          )}
        </button>
      </div>

      {/* Drawer mobile — uses role+aria-modal instead of HTMLDialogElement because
          the latter requires imperative open/close APIs incompatible with React's
          declarative state-driven rendering. */}
      {open && (
        // biome-ignore lint/a11y/useSemanticElements: see drawer mobile comment above
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Menú principal"
          id={panelId}
          className="fixed inset-0 z-50 md:hidden"
        >
          <button
            type="button"
            aria-label="Cerrar menú"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/40"
          />
          <div className="absolute right-0 top-0 h-full w-[85%] max-w-sm bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-ln-line px-4 py-3">
              {/* One family for the wordmark — see the note in AppShell's
                  LandingShell. */}
              <span className="font-ln-serif text-lg font-bold text-ln-azul">
                {BRANDING.appName}
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Cerrar menú"
                className="inline-flex h-10 w-10 items-center justify-center rounded-md text-ln-ink-2 hover:bg-ln-stripe"
              >
                <Icon name="close" size="md" decorative />
              </button>
            </div>

            <nav aria-label="Navegación principal" className="flex flex-col px-2 py-3">
              {nav.map((item) => {
                const active = isActive(item, pathname);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`flex min-h-12 items-center gap-2 rounded-md px-4 py-3 text-base font-semibold no-underline ${
                      active ? "bg-ln-stripe text-ln-azul" : "text-ln-ink-2 hover:bg-ln-stripe"
                    }`}
                  >
                    {item.label}
                    {item.badge != null && item.badge > 0 && (
                      <span className="inline-flex items-center justify-center rounded-full bg-ln-seal px-1.5 py-0.5 text-xs font-semibold leading-none text-white">
                        {item.badge}
                      </span>
                    )}
                  </Link>
                );
              })}
            </nav>

            <div className="border-t border-ln-line px-4 py-4">
              {user ? (
                <Link
                  href={user.href ?? "/cuenta"}
                  className="flex items-center gap-2 rounded-full border border-ln-line px-4 py-3 text-sm font-semibold text-ln-azul no-underline"
                >
                  <Icon name="usuarios" size={18} decorative />
                  Mi cuenta · {user.name}
                </Link>
              ) : (
                <Link
                  href="/iniciar-sesion"
                  className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-ln-azul px-6 text-sm font-semibold text-white no-underline"
                >
                  Iniciar sesión
                </Link>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
