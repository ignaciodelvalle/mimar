// D7 — OpRailNav deferred render (plan dim-interno:docs/superpowers-private/plans/archive/2026-06-23-population-cycle-deferred-nav-handoff.md).
//
// A deferred NavItem renders as a NON-interactive <span> (no <Link>, no href,
// aria-disabled, not focusable, muted token + textual "Próximamente"), and never
// matches as active. A live item still renders a Next <Link> (<a href>).
//
// The rail uses usePathname(); we mock next/navigation (vi.hoisted so the mock
// factory can read a mutable path) and render with renderToStaticMarkup — the
// repo's component-test harness (no @testing-library/react dependency).

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ path: "/admin/programa" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  // P5 hover/focus prefetch (perf sweep 2026-08-02) calls useRouter().prefetch —
  // stub it so NavLink can render outside a real app-router context.
  useRouter: () => ({ prefetch: vi.fn() }),
}));

import { type NavSection, OpRailNav } from "@/components/ui/dashboard/OpRailNav";

function render(sections: NavSection[]): string {
  return renderToStaticMarkup(<OpRailNav sections={sections} variant="gob" />);
}

describe("OpRailNav — rail scrollbar (PR-1 V2)", () => {
  it("applies the op-scroll utility to the scrolling nav", () => {
    const html = render([
      { label: "Analítica", items: [{ href: "/admin/programa", label: "Programa" }] },
    ]);
    expect(html).toContain("op-scroll");
  });
});

describe("OpRailNav — deferred items (D7)", () => {
  it("renders a live item as a Next <Link> (an <a href>)", () => {
    const html = render([
      {
        label: "Analítica",
        items: [{ href: "/admin/programa", label: "Programa", matchPrefix: "/admin/programa" }],
      },
    ]);
    expect(html).toContain('href="/admin/programa"');
    expect(html).toContain("Programa");
  });

  it("renders a deferred item as a non-interactive <span>: no href, aria-disabled, 'Próximamente'", () => {
    const html = render([
      {
        label: "Analítica",
        items: [
          { href: "#defer-control-poblacional", label: "Control poblacional", deferred: true },
        ],
      },
    ]);
    // No anchor / no href for the deferred sentinel.
    expect(html).not.toContain('href="#defer-control-poblacional"');
    expect(html).not.toContain("<a ");
    // State announced without relying on color: aria-disabled + textual pill.
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Próximamente");
    expect(html).toContain("Control poblacional");
  });

  it("deferred item is not focusable and uses the muted rail token (state not by color alone)", () => {
    const html = render([
      {
        label: "Analítica",
        items: [{ href: "#defer-custodia-transito", label: "Custodia & tránsito", deferred: true }],
      },
    ]);
    // A plain <span> with no tabindex is out of the tab order by default.
    expect(html).not.toContain("tabindex");
    expect(html).toContain("text-ln-op-rail-mute");
  });

  it("deferred item never matches as active, even when pathname equals its sentinel href", () => {
    nav.path = "#defer-control-poblacional";
    const html = render([
      {
        label: "Analítica",
        items: [
          { href: "#defer-control-poblacional", label: "Control poblacional", deferred: true },
        ],
      },
    ]);
    expect(html).not.toContain('aria-current="page"');
    nav.path = "/admin/programa"; // reset for any later test
  });
});

// Org nav diet (2026-07-24): a `collapsible` section renders as a native
// <details> disclosure, collapsed by default, holding its items — nothing is
// removed, secondary destinations are one tap away. Auto-opens when it
// contains the active route so the current location is never hidden.
describe("OpRailNav — collapsible section (Administración group)", () => {
  const COLLAPSIBLE: NavSection[] = [
    {
      label: "Ingresos",
      items: [{ href: "/org/T/intake", label: "Ingresos", matchPrefix: "/org/T/intake" }],
    },
    {
      label: "Administración",
      collapsible: true,
      items: [
        { href: "/org/T/servicios", label: "Servicios", matchPrefix: "/org/T/servicios" },
        {
          href: "/org/T/configuracion",
          label: "Configuración",
          matchPrefix: "/org/T/configuracion",
        },
      ],
    },
  ];

  it("renders the collapsible section as a <details> with its label in the <summary>, collapsed by default", () => {
    nav.path = "/org/T/intake";
    const html = render(COLLAPSIBLE);
    const detailsTag = html.match(/<details[^>]*>/)?.[0];
    expect(detailsTag).toBeDefined();
    expect(detailsTag).not.toContain(" open");
    expect(html).toMatch(/<summary[^>]*>[\s\S]*?Administración[\s\S]*?<\/summary>/);
  });

  it("keeps every grouped item rendered (links exist inside the details — nothing removed)", () => {
    nav.path = "/org/T/intake";
    const html = render(COLLAPSIBLE);
    expect(html).toContain('href="/org/T/servicios"');
    expect(html).toContain('href="/org/T/configuracion"');
  });

  it("opens the group when it contains the active route", () => {
    nav.path = "/org/T/configuracion";
    const html = render(COLLAPSIBLE);
    const detailsTag = html.match(/<details[^>]*>/)?.[0];
    expect(detailsTag).toContain(" open");
    expect(html).toContain('aria-current="page"');
    nav.path = "/admin/programa"; // reset for any later test
  });

  it("non-collapsible sections keep rendering as plain headed groups (no <details>)", () => {
    nav.path = "/org/T/intake";
    const html = render([COLLAPSIBLE[0]]);
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<summary");
    expect(html).toContain("Ingresos");
  });
});
