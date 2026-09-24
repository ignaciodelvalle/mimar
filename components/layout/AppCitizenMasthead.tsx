"use client";

// AppCitizenMasthead — the citizen-variant masthead for the unified AppShell
// (Item 7, spec D5/D7/D8). Ports the LnOwnerNav masthead layout into the
// AppShell system and is driven entirely by resolveShellNav's output:
//
//   - `nav`        → the role nav (OWNER_NAV) for a logged-in citizen, or
//                    PUBLIC_NAV for an anonymous visitor (D3). Chosen server-side.
//   - `showReturn` → a guaranteed ≤1-click return to the role home (D4): the
//                    fix for the "logged-in user stranded on a public surface".
//   - `switcher`   → entitlement-filtered context destinations (D6).
//
// D5 disambiguation: the brand/wordmark links to the public landing `/`, while
// the role nav's own "Inicio" item points at the role home (`/inicio`). The two
// are intentionally distinct so "Inicio" never means two things at once.
//
// Client component: reads usePathname() for active-state highlighting and to
// drive the mobile drawer — the same thin pattern LnOwnerNav used. No data
// fetching or side effects; everything is passed in by the RSC layout.
//
// Strangler (Phase C): this replaces LnOwnerNav + AppHeader as the citizen
// chrome. The legacy components are NOT deleted here — Phase D removes them.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Drawer } from "vaul";

import { logoutAction } from "@/app/actions/auth";
import { Icon } from "@/components/Icon";
import type { NavItem } from "@/components/layout/HeaderNav";
import { isNavItemActive } from "@/components/layout/nav-active";
import { BRANDING } from "@/lib/ui/branding";
import type { SwitcherTarget } from "@/lib/ui/shell-nav";

type CitizenUser = {
  /** First name (or email prefix) shown next to the avatar. */
  name: string;
  /** Two-letter avatar initials. */
  initials: string;
};

type Props = {
  /** Resolved nav (OWNER_NAV for owners, PUBLIC_NAV for anon) — D3. */
  nav: NavItem[];
  /** The logged-in user pill, or null for an anonymous visitor. */
  user: CitizenUser | null;
  /** Unread-notification count for the bell badge (0 when anon / none). */
  unreadCount?: number;
  /** Guaranteed role-return affordance (D4). */
  showReturn?: boolean;
  /** Where the return points when showReturn is true. */
  returnHref?: string;
  /** Entitlement-filtered context-switcher destinations (D6). */
  switcher?: SwitcherTarget[];
  /**
   * True when the layout also renders CitizenTabBar (native-mobile audit §1):
   * primary nav lives in the bottom tabs on mobile, so the drawer drops the
   * primary items and only opens for secondary content (switcher / return).
   * With no secondary content the hamburger disappears entirely and the
   * masthead shrinks to brand + bell + avatar. Desktop (md+) is unchanged.
   */
  primaryNavInTabBar?: boolean;
};

export function AppCitizenMasthead({
  nav,
  user,
  unreadCount = 0,
  showReturn = false,
  returnHref,
  switcher = [],
  primaryNavInTabBar = false,
}: Props) {
  const pathname = usePathname();

  // With the tab bar owning primary nav on mobile, the drawer only carries
  // secondary content — and disappears when there is none.
  const drawerNav = primaryNavInTabBar ? [] : nav;
  const hasDrawerContent =
    drawerNav.length > 0 || switcher.length > 0 || (showReturn && Boolean(returnHref));

  return (
    // pt-safe: with viewport-fit=cover the installed PWA draws under the iOS
    // status bar — max(0.75rem, safe-area-inset-top) keeps the row clear of it
    // while staying at the design's 12px everywhere else.
    <header className="pt-safe flex flex-shrink-0 items-center gap-[18px] bg-[var(--color-ln-azul-900)] px-4 py-3 text-white md:px-8">
      {/* Mobile hamburger — hidden on md+ where the inline nav shows, and
          omitted entirely when the tab bar owns primary nav and there is no
          secondary content left for the drawer. */}
      {hasDrawerContent && (
        <CitizenMobileDrawer
          nav={drawerNav}
          switcher={switcher}
          showReturn={showReturn}
          returnHref={returnHref}
        />
      )}

      {/* Brand/wordmark → public landing `/` (D5: distinct from the role Inicio). */}
      <Link
        href="/"
        className="flex flex-shrink-0 items-center gap-3 no-underline transition-opacity hover:opacity-90"
        aria-label={`${BRANDING.appName} — ${BRANDING.appNameLong}, ir al inicio`}
      >
        {/* THE MARK, on a paper tile. This was a serif "m" in a translucent
            circle — a typographic stand-in from when the product had no mark.
            `public/logo-mimar-mark.svg` is the mark (a QR finder pattern with
            chamfered corners holding a paw) and it is already the SOURCE the
            mobile launcher icons are composed from
            (scripts/build-mobile-app-icons.ts), so the CITIZEN chrome and the
            app icon are now one drawing instead of two brands.

            The operator chrome draws this exact tile too now — the rail's
            brand block (components/ui/dashboard/OpRail.tsx) and the operator
            drawer's brand header (components/layout/AppShellDrawer.tsx) — so
            a funcionario who is also a citizen sees one mark, not two,
            crossing between `/` and `/gob`.

            WHY A LIGHT TILE AND NOT THE BARE FILE. The asset paints with
            `currentColor` and defaults to brand blue (#0E5A99), which an
            `<img>` cannot recolour — on this azul-900 band that is blue on
            navy. The app-icon recipe already answered this: blue mark on the
            cream paper ground. The tile reuses the same colour rather than
            inventing a second one — `--color-ln-paper` is #fbfaf5, the literal
            build-mobile-app-icons.ts bakes in.

            DECORATIVE ON PURPOSE (`alt=""`). The link wrapping it already
            carries the accessible name, and the wordmark beside it is real
            text; a third announcement of "miMAR" would be the three-names-for-
            one-control defect, in the header. */}
        <span className="grid h-[38px] w-[38px] flex-shrink-0 place-items-center rounded-[var(--radius-lg)] bg-[var(--color-ln-paper)]">
          <img src="/logo-mimar-mark.svg" alt="" width={28} height={28} />
        </span>
        <span className="leading-[1.1]">
          <span className="block font-ln-serif text-xl font-semibold tracking-[-0.01em]">
            {BRANDING.appName}
          </span>
          {/* Hidden below md: the wide letter-spacing (tracking-[.22em]) makes this
              line ~150px wide, which forces the header row past 320px viewports
              and causes document-level horizontal scroll. Same hidden/md:block
              pattern already used below for the user name. */}
          {/* celeste-100 (not celeste): on the azul-900 band, base celeste
              is ~4.0:1 at this 9.5px size — below WCAG 1.4.3's 4.5:1 (a11y
              audit 2026-07-04 §4). celeste-100 clears ~10:1 on the same bg. */}
          <span className="hidden font-ln-mono text-xs uppercase tracking-[.22em] text-[var(--color-ln-celeste-100)] md:block">
            MI MASCOTA ARGENTINA
          </span>
        </span>
      </Link>

      {/* Desktop nav — the resolved role/public items (D3). */}
      {nav.length > 0 && (
        <nav aria-label="Navegación principal" className="ml-6 hidden items-center gap-1 md:flex">
          {nav.map((item) => {
            const active = isNavItemActive(item, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={[
                  "rounded-[var(--radius-sm)] px-3.5 py-2 text-md font-medium tracking-[.01em] no-underline transition-colors",
                  active
                    ? "bg-white/10 text-white shadow-[inset_0_-2px_0_var(--color-ln-celeste)]"
                    : "text-white/70 hover:text-white",
                ].join(" ")}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      )}

      {/* Right cluster */}
      <div className="ml-auto flex items-center gap-3.5">
        {/* Guaranteed role-return (D4) — the stranded-user escape hatch. Shown
            on desktop next to the user pill; the mobile drawer carries its own. */}
        {showReturn && returnHref && (
          <Link
            href={returnHref}
            className="hidden items-center gap-1 rounded-[var(--radius-sm)] border border-white/25 px-3 py-1.5 text-md font-medium text-white/85 no-underline transition-colors hover:border-white/50 hover:text-white md:inline-flex"
          >
            ← Volver a mi app
          </Link>
        )}

        {/* Context switcher (D6) — only entitled destinations, never empty. */}
        {switcher.length > 0 && <CitizenSwitcher switcher={switcher} />}

        {/* Notification bell — only meaningful for a logged-in citizen. */}
        {user && (
          <Link
            href="/notificaciones"
            aria-label={
              unreadCount > 0 ? `Notificaciones (${unreadCount} sin leer)` : "Notificaciones"
            }
            // min 44px touch box around the 18px glyph (WCAG 2.5.5); the
            // badge anchors to the inner span so it hugs the icon, not the box.
            className="inline-flex min-h-11 min-w-11 items-center justify-center text-white/80 transition-colors hover:text-white active:text-white"
          >
            <span className="relative">
              <Icon name="bell" size="md" decorative />
              {unreadCount > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute -right-[7px] -top-[5px] min-w-[15px] rounded-full bg-[var(--color-ln-celeste)] px-1 text-center font-ln-mono text-xs font-bold leading-[15px] text-[var(--color-ln-azul-900)]"
                >
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </span>
          </Link>
        )}

        {/* User menu (logged-in) → avatar dropdown with "Mi cuenta" + reliable
            "Cerrar sesión"; or a sign-in CTA (anonymous). Logout living in the
            masthead means it never depends on /cuenta rendering (task #50). */}
        {user ? (
          <CitizenUserMenu user={user} />
        ) : (
          <Link
            href="/iniciar-sesion"
            className="inline-flex min-h-11 items-center justify-center rounded-full bg-white px-[18px] text-md font-semibold text-[var(--color-ln-azul-900)] no-underline transition-opacity hover:opacity-90 active:opacity-80"
          >
            Iniciar sesión
          </Link>
        )}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// User menu (citizen variant) — the avatar pill opens a small dropdown with
// "Mi cuenta" and a reliable "Cerrar sesión". Putting logout here (global
// chrome) means signing out never depends on the /cuenta page rendering — the
// escape hatch when that route is degraded (task #50). Renders on every
// viewport, so mobile keeps a logout affordance even when the nav drawer is
// absent (tab bar owns primary nav).
// ---------------------------------------------------------------------------

function CitizenUserMenu({ user }: { user: CitizenUser }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // Close on navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger; setOpen is React-stable
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function handleOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [open]);

  // RA-9 BR-4: Escape closes and returns focus to the trigger.
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  return (
    <div ref={ref} className="relative border-l border-white/[0.18] pl-4">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Menú de cuenta"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 min-w-11 items-center justify-center gap-[9px] rounded-full no-underline transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
      >
        <span className="grid h-[30px] w-[30px] flex-shrink-0 place-items-center rounded-full bg-[var(--color-ln-celeste)] font-ln-mono text-sm font-semibold text-[var(--color-ln-azul-900)]">
          {user.initials}
        </span>
        <span className="hidden text-md font-medium md:block">{user.name}</span>
      </button>

      {open && (
        // RA-9 BR-4: a disclosure panel, not an application menu. role="menu"
        // contracts arrow-key roving + typeahead that this popover never had;
        // the honest shape for two navigation-ish actions is a plain list.
        <div
          id={panelId}
          className="absolute right-0 top-full z-50 mt-1 min-w-[180px] rounded-[var(--radius-md)] border border-ln-line bg-white py-1 shadow-md"
        >
          <Link
            href="/cuenta"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-[7px] text-md text-ln-ink no-underline transition-colors hover:bg-ln-stripe"
          >
            Mi cuenta
          </Link>
          <div className="my-1 border-t border-ln-line-2" aria-hidden="true" />
          <form action={logoutAction}>
            <button
              type="submit"
              className="flex w-full items-center gap-2 px-3 py-[7px] text-left text-md font-medium text-[var(--color-ln-err)] transition-colors hover:bg-ln-stripe"
            >
              Cerrar sesión
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context switcher (citizen variant) — D6. A lightweight popover listing the
// entitlement-filtered destinations resolved server-side. Mirrors the operator
// ContextSwitcher behavior but styled for the navy citizen masthead.
// ---------------------------------------------------------------------------

function CitizenSwitcher({ switcher }: { switcher: SwitcherTarget[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // "Where am I" affordance (task #17): name the current org portal in the
  // trigger when the user is inside one they belong to; otherwise "Portales".
  const currentOrg = switcher.find(
    (t) => t.key === "org" && (pathname === t.href || pathname.startsWith(`${t.href}/`)),
  );
  const triggerLabel = currentOrg ? currentOrg.label : "Portales";

  // Close on navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger; setOpen is React-stable
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // RA-9 BR-4: Escape closes and returns focus to the trigger.
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  return (
    <div className="relative hidden md:block">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-white/25 px-3 py-1.5 text-md font-medium text-white/85 transition-colors hover:border-white/50 hover:text-white"
      >
        <span className="max-w-[160px] truncate">{triggerLabel}</span>
        <Icon name="chevron-down" size="sm" decorative className="opacity-70" />
      </button>
      {open && (
        // RA-9 BR-4: disclosure listing navigation links — see CitizenUserMenu.
        <nav
          id={panelId}
          aria-label="Cambiar de portal"
          className="absolute right-0 top-full z-50 mt-1 min-w-[180px] rounded-[var(--radius-md)] border border-ln-line bg-white py-1 shadow-md"
        >
          <ul>
            {switcher.map((t) => (
              <li key={t.key + t.href}>
                <Link
                  href={t.href}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2 px-3 py-[7px] text-md text-ln-ink no-underline transition-colors hover:bg-ln-stripe"
                >
                  {t.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mobile drawer (citizen variant) — D8. Left-side drawer mirroring the desktop
// nav, the return affordance, and the switcher for sub-md viewports.
// ---------------------------------------------------------------------------

function CitizenMobileDrawer({
  nav,
  switcher,
  showReturn,
  returnHref,
}: {
  nav: NavItem[];
  switcher: SwitcherTarget[];
  showReturn: boolean;
  returnHref?: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger; setOpen is React-stable
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <Drawer.Root open={open} onOpenChange={setOpen} direction="left">
      <Drawer.Trigger asChild>
        <button
          type="button"
          aria-label="Abrir menú"
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-white/80 hover:text-white active:bg-white/10 md:hidden"
        >
          <Icon name="menu" size="lg" decorative />
        </button>
      </Drawer.Trigger>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/40 md:hidden" />
        <Drawer.Content className="fixed bottom-0 left-0 top-0 z-50 flex w-[232px] flex-col bg-[var(--color-ln-azul-900)] text-white shadow-xl outline-none md:hidden">
          {/* Radix's DialogPrimitive.Content (vaul's Drawer.Content wraps it)
              requires a DialogTitle descendant — vaul's Drawer.Title IS that
              Title — or it dev-warns "DialogContent requires a DialogTitle"
              even though the brand header below already shows "miMAR" as
              real text. Visually hidden for that reason; no id/aria override
              here (mirrors components/ui/VaulSheet.tsx) because Radix
              auto-wires aria-labelledby to its own generated titleId and only
              resolves it when Drawer.Title renders undisturbed — an explicit
              aria-label on Content does not satisfy the same dev check. */}
          <Drawer.Title className="sr-only">Menú principal</Drawer.Title>
          {/* Brand header */}
          <div className="flex items-center gap-2.5 border-b border-white/10 px-4 py-3.5">
            {/* Same mark, same reasoning as the masthead brand slot above —
                the drawer's brand header is the same brand slot at 34px, and
                leaving the letter here would put two different marks one tap
                apart. */}
            <span className="grid h-[34px] w-[34px] flex-shrink-0 place-items-center rounded-[var(--radius-lg)] bg-[var(--color-ln-paper)]">
              <img src="/logo-mimar-mark.svg" alt="" width={25} height={25} />
            </span>
            <span className="flex flex-col leading-tight">
              <span className="font-ln-serif text-base font-semibold">{BRANDING.appName}</span>
              <span className="font-ln-mono text-xs uppercase tracking-[0.2em] text-[var(--color-ln-celeste-100)]">
                MI MASCOTA ARGENTINA
              </span>
            </span>
            <Drawer.Close asChild>
              <button
                type="button"
                aria-label="Cerrar menú"
                className="ml-auto inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-white/60 hover:bg-white/10 hover:text-white active:bg-white/10"
              >
                <Icon name="close" size="md" decorative />
              </button>
            </Drawer.Close>
          </div>

          {/* Nav items — omitted (spacer keeps the foot pinned) when the
              bottom tab bar owns primary nav and the drawer only carries the
              switcher/return foot. */}
          {nav.length === 0 && <div className="flex-1" aria-hidden="true" />}
          {nav.length > 0 && (
            <nav
              aria-label="Navegación principal"
              className="flex flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2 py-3"
            >
              {nav.map((item) => {
                const active = isNavItemActive(item, pathname);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={[
                      "flex min-h-11 items-center gap-2.5 rounded-[var(--radius-sm)] px-3 py-2",
                      "text-md no-underline transition-colors",
                      active
                        ? "border-l-2 border-[var(--color-ln-celeste)] bg-white/10 font-semibold text-white"
                        : "border-l-2 border-transparent text-white/75 hover:bg-white/5 hover:text-white active:bg-white/10",
                    ].join(" ")}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          )}

          {/* Switcher + return at the foot of the drawer. */}
          {(switcher.length > 0 || (showReturn && returnHref)) && (
            <div className="flex flex-col gap-0.5 border-t border-white/10 px-2 py-3">
              {showReturn && returnHref && (
                <Link
                  href={returnHref}
                  className="flex min-h-11 items-center rounded-[var(--radius-sm)] px-3 py-2 text-md font-medium text-white/85 no-underline hover:bg-white/5 hover:text-white active:bg-white/10"
                >
                  ← Volver a mi app
                </Link>
              )}
              {switcher.map((t) => (
                <Link
                  key={t.key + t.href}
                  href={t.href}
                  className="flex min-h-11 items-center rounded-[var(--radius-sm)] px-3 py-2 text-md text-white/75 no-underline hover:bg-white/5 hover:text-white active:bg-white/10"
                >
                  {t.label}
                </Link>
              ))}
            </div>
          )}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
