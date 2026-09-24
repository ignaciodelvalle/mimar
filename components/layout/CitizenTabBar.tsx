"use client";

// CitizenTabBar — fixed bottom tab bar for the citizen PWA on mobile
// (native-mobile audit 2026-07-04 §1, TOP-5 #2).
//
// The single strongest "website vs app" signal: primary navigation moves from
// the hamburger drawer (2 taps) to persistent bottom tabs (1 tap), matching
// the native iOS/Android pattern. OWNER_NAV's 2 items (PO ronda 4, 2026-07-15:
// the former "Inicio" tab was removed) map 1:1 onto tabs, plus the inserted
// "Asentar" capture slot below.
//
//   - Renders < md only; the masthead's inline nav owns md+ (desktop).
//   - Fixed to the viewport bottom with pb-safe so the tabs clear the iOS
//     home indicator (viewport-fit=cover).
//   - AppShell's citizen variant reserves matching bottom padding so content
//     and footer are never hidden behind the bar.
//   - aria-label matches the masthead nav ("Navegación principal") on purpose:
//     the two are never in the accessibility tree at the same time (this bar
//     is display:none on md+, the inline nav is display:none below md).
//
// Client component for the same reason as the masthead: usePathname() drives
// the active-tab highlight. No data fetching, no side effects.

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { NavItem } from "@/components/layout/HeaderNav";
import { isNavItemActive } from "@/components/layout/nav-active";
import { SheetTriggerLink } from "@/components/pet-profile/SheetTriggerLink";

// The pet-profile route is `/mis-mascotas/{DIM-token}` (and its sub-routes:
// /asistencia, /libreta, …). Pet public tokens always start with `DIM-`, so a
// prefix test cleanly separates a real profile from the reserved index children
// (/mis-mascotas/nueva, /postulaciones, /reclamar, /reclamar-dni). Returns the
// current pet's token when on any of its routes, else null.
function petTokenFromPathname(pathname: string | null): string | null {
  if (!pathname) return null;
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "mis-mascotas") return null;
  const token = segments[1];
  return token && /^DIM-/i.test(token) ? token : null;
}

// Stroke icons in the masthead bell's style (24 viewBox, strokeWidth 2).
// Mapped by href prefix; items without a mapping fall back to a neutral dot
// so a future nav item never renders a broken tab.
function TabIcon({ href }: { href: string }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "h-6 w-6",
  };
  if (href.startsWith("/mis-mascotas")) {
    return (
      <svg {...common} aria-hidden="true">
        <circle cx="5.5" cy="10.5" r="1.6" />
        <circle cx="9.4" cy="6.5" r="1.6" />
        <circle cx="14.6" cy="6.5" r="1.6" />
        <circle cx="18.5" cy="10.5" r="1.6" />
        <path d="M12 12c-2.9 0-5.5 2.4-5.5 5.1 0 1.7 1.3 2.9 3 2.9 1 0 1.7-.4 2.5-.4s1.5.4 2.5.4c1.7 0 3-1.2 3-2.9 0-2.7-2.6-5.1-5.5-5.1z" />
      </svg>
    );
  }
  if (href.startsWith("/denuncias")) {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
        <path d="M4 22v-7" />
      </svg>
    );
  }
  return (
    <svg {...common} aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function CitizenTabBar({
  nav,
  ownedPetsCount,
}: {
  nav: NavItem[];
  /** Active ownerships for the signed-in user (getOwnedPetsCountCached). Zero
   *  swaps the capture slot for the alta slot — see the block below. Required
   *  on purpose: a default would silently pick a branch for future callers. */
  ownedPetsCount: number;
}) {
  const pathname = usePathname();

  if (nav.length === 0) return null;

  const navItems = nav.map((item) => {
    const active = isNavItemActive(item, pathname);
    return (
      <li key={item.href} className="min-w-0 flex-1">
        <Link
          href={item.href}
          aria-current={active ? "page" : undefined}
          className={[
            "flex min-h-12 flex-col items-center justify-center gap-0.5 px-1 pt-1.5 pb-1 no-underline",
            "transition-colors active:opacity-70",
            active
              ? "text-[var(--color-ln-azul)]"
              : "text-[var(--color-ln-mute)] hover:text-[var(--color-ln-ink)]",
          ].join(" ")}
        >
          <TabIcon href={item.href} />
          <span
            className={[
              "w-full truncate text-center text-xs",
              active ? "font-semibold" : "font-medium",
            ].join(" ")}
          >
            {item.label}
          </span>
        </Link>
      </li>
    );
  });

  // "Asentar un hecho" lives in this EXISTING tab-bar slot — the mobile capture
  // affordance, not a second stacked fixed bar (PO 2026-07-12 #4). Inserted at
  // the visual centre so it reads as the emphasised primary action.
  //
  // owner-ia-redesign P4: on a pet-profile route the pet is already known, so
  // "Asentar" retargets to THAT pet's capture sheet (?sheet=anotar) — no picker,
  // no cross-route hop. Everywhere else (P5: the /inicio home capture card is
  // gone) it points at /inicio?sheet=anotar: /inicio server-redirects to the
  // most-urgent pet's credential AND forwards the sheet param, so the anotar
  // sheet opens on arrival in a SINGLE navigation. A bare /inicio would redirect
  // to the profile WITHOUT opening anotar — breaking the one-tap capture flow.
  //
  // D.8 (2026-07-30): with ZERO owned pets that fallback is a SILENT NO-OP.
  // /inicio redirects a pets-less owner to /mis-mascotas, and ?sheet=anotar is
  // inert there (app/(app)/inicio/page.tsx) — so the most emphasised control in
  // the whole citizen shell did nothing for exactly the first-run owner who
  // most needs a way in. With no pets the slot becomes the alta:
  // "Registrar mascota" → /mis-mascotas/nueva. With ≥1 pet the behaviour is
  // unchanged.
  //
  // D.9 (2026-07-30) supersedes D.8 on the WORDING only: "Registrar" is the
  // one verb for this act on every surface, because it is the DOMAIN verb
  // (the event is `pet_registered`, the product is the Registro Nacional, the
  // credential badge reads "Registrado/a"). D.8's "Cargar mascota" was a UI
  // verb that made this slot the fourth name for one act.
  //
  // A pet token in the pathname still WINS over the zero-count branch: an org
  // or foster user can legitimately be on a pet profile inside the citizen
  // shell while owning nothing themselves, and for them "Asentar" on THAT pet
  // is the correct action.
  const currentPetToken = petTokenFromPathname(pathname);
  const showAlta = !currentPetToken && ownedPetsCount === 0;
  const asentarHref = currentPetToken
    ? `/mis-mascotas/${currentPetToken}?sheet=anotar`
    : showAlta
      ? "/mis-mascotas/nueva"
      : "/inicio?sheet=anotar";
  const asentarLabel = showAlta ? "Registrar mascota" : "Asentar";
  // SAME-ROUTE opens go through SheetTriggerLink, CROSS-route stays a real
  // navigation (X1-F4).
  //
  // lib/ui/sheet-nav.ts was written because "the Anotar icon fail 3/3 in
  // production… the router must never sit on their hot path". The pet profile's
  // own "Anotar" honoured that; this slot — the owner's number-one capture
  // action on mobile — used a plain <Link> to the SAME route, which is a router
  // soft-nav: the exact shape that failed 3/3 and caused the module to exist.
  // The action was protected or exposed depending on which pixel the thumb
  // covered.
  //
  // From anywhere else the link is genuinely cross-route: /inicio redirects to
  // the most urgent pet AND forwards ?sheet=anotar, one navigation, correct.
  const AsentarLink = currentPetToken ? SheetTriggerLink : Link;
  const asentar = (
    <li key="__asentar" className="min-w-0 flex-1">
      <AsentarLink
        href={asentarHref}
        className="flex min-h-12 flex-col items-center justify-center gap-0.5 px-1 pt-1.5 pb-1 text-[var(--color-ln-azul)] no-underline transition-colors active:opacity-70"
      >
        <span
          aria-hidden="true"
          className="grid h-6 w-6 place-items-center rounded-full bg-[var(--color-ln-azul)] text-[var(--color-ln-card)]"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            className="h-4 w-4"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </span>
        <span className="w-full truncate text-center text-xs font-semibold">{asentarLabel}</span>
      </AsentarLink>
    </li>
  );
  navItems.splice(Math.ceil(navItems.length / 2), 0, asentar);

  return (
    <nav
      // Structural anchor for e2e. The aria-label is deliberately shared with
      // the masthead nav (see the block comment above), and the bar is
      // md:hidden — so neither a role query nor the label can single this
      // element out at a desktop viewport. Copy CANNOT disambiguate it either:
      // since D.9 the centre slot says "Registrar mascota", the exact words the
      // /mis-mascotas empty state uses. This id is the one handle that survives
      // both. The bar renders outside <main id="main-content">, so scoping to
      // one or the other partitions the page cleanly.
      data-testid="citizen-tab-bar"
      aria-label="Navegación principal"
      className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-ln-line)] bg-[var(--color-ln-card)] md:hidden"
    >
      <ul className="flex">{navItems}</ul>
    </nav>
  );
}
