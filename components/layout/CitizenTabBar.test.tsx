// CitizenTabBar — "Asentar" retarget (owner-ia-redesign P4 + P5).
//
// On a pet-profile route the pet is already known, so the tab-bar capture
// action points at THAT pet's ?sheet=anotar; everywhere else it points at
// /inicio?sheet=anotar (P5: the /inicio home capture card is gone — /inicio now
// server-redirects to the most-urgent pet's credential AND forwards the sheet
// param, so anotar opens in one hop). usePathname is mocked so
// renderToStaticMarkup (repo convention — no jsdom) can drive each route.
//
// Note: the fallback href starts with "/inicio", which is also the "Inicio" nav
// tab's own href, so we can't assert on the raw substring alone — asentarHref()
// isolates the capture button by its unique "Asentar" label to read its true
// target.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { pathnameRef } = vi.hoisted(() => ({ pathnameRef: { current: null as string | null } }));
vi.mock("next/navigation", () => ({
  usePathname: () => pathnameRef.current,
}));

import { CitizenTabBar } from "@/components/layout/CitizenTabBar";
import { OWNER_NAV } from "@/components/layout/nav-presets";

function renderAt(pathname: string | null, ownedPetsCount = 3): string {
  pathnameRef.current = pathname;
  return renderToStaticMarkup(<CitizenTabBar nav={OWNER_NAV} ownedPetsCount={ownedPetsCount} />);
}

/** The href of the capture/alta slot — the anchor labelled `label`. */
function slotHref(html: string, label: string): string | null {
  for (const seg of html.split(/<a /).slice(1)) {
    if (new RegExp(`>${label}<`).test(seg)) {
      const m = seg.match(/href="([^"]*)"/);
      return m ? m[1] : null;
    }
  }
  return null;
}

/** The href of the capture button — the anchor whose label text is "Asentar".
 * Attribute order in the rendered markup is not stable (an active nav item gets
 * an extra aria-current, which shifts class ahead of href), so href is matched
 * anywhere inside the anchor's own segment rather than at its start. */
function asentarHref(html: string): string | null {
  for (const seg of html.split(/<a /).slice(1)) {
    if (/>Asentar</.test(seg)) {
      const m = seg.match(/href="([^"]*)"/);
      return m ? m[1] : null;
    }
  }
  return null;
}

describe("CitizenTabBar — Asentar retarget on pet-profile routes", () => {
  it("retargets to the current pet's ?sheet=anotar on a profile route", () => {
    const html = renderAt("/mis-mascotas/DIM-PAMP-0001");
    expect(asentarHref(html)).toBe("/mis-mascotas/DIM-PAMP-0001?sheet=anotar");
  });

  it("retargets from a profile SUB-route too (same pet's anotar)", () => {
    const html = renderAt("/mis-mascotas/DIM-PAMP-0001/libreta");
    expect(asentarHref(html)).toBe("/mis-mascotas/DIM-PAMP-0001?sheet=anotar");
  });

  it("falls back to /inicio?sheet=anotar on the index route (one-hop capture)", () => {
    expect(asentarHref(renderAt("/mis-mascotas"))).toBe("/inicio?sheet=anotar");
  });

  it("falls back to /inicio?sheet=anotar on reserved index children (nueva, reclamar-dni)", () => {
    expect(asentarHref(renderAt("/mis-mascotas/nueva"))).toBe("/inicio?sheet=anotar");
    expect(asentarHref(renderAt("/mis-mascotas/reclamar-dni"))).toBe("/inicio?sheet=anotar");
  });

  it("falls back to /inicio?sheet=anotar elsewhere and when the pathname is unavailable", () => {
    expect(asentarHref(renderAt("/inicio"))).toBe("/inicio?sheet=anotar");
    expect(asentarHref(renderAt(null))).toBe("/inicio?sheet=anotar");
  });
});

// ---------------------------------------------------------------------------
// D.8 (2026-07-30) — the zero-pet slot.
//
// "Asentar" → /inicio?sheet=anotar was a SILENT NO-OP for a pets-less owner:
// /inicio redirects them to /mis-mascotas, where ?sheet=anotar is inert. The
// most emphasised control in the citizen shell did nothing for exactly the
// first-run user. With zero owned pets the slot becomes the alta instead.
// ---------------------------------------------------------------------------

describe("CitizenTabBar — zero-pet slot becomes the alta (D.8)", () => {
  it("with 0 owned pets the slot reads 'Registrar mascota' and points at /mis-mascotas/nueva", () => {
    const html = renderAt("/mis-mascotas", 0);
    expect(slotHref(html, "Registrar mascota")).toBe("/mis-mascotas/nueva");
    // And the no-op is gone: no "Asentar" label, no /inicio?sheet=anotar href.
    expect(html).not.toContain(">Asentar<");
    expect(html).not.toContain("/inicio?sheet=anotar");
  });

  it("with 0 pets the alta slot holds on every non-profile route, pathname or not", () => {
    for (const path of ["/mis-mascotas", "/mis-mascotas/reclamar", "/notificaciones", null]) {
      expect(slotHref(renderAt(path, 0), "Registrar mascota")).toBe("/mis-mascotas/nueva");
    }
  });

  it("with ≥1 owned pet nothing changes — the capture slot is exactly as before", () => {
    expect(asentarHref(renderAt("/mis-mascotas", 1))).toBe("/inicio?sheet=anotar");
    expect(asentarHref(renderAt("/inicio", 1))).toBe("/inicio?sheet=anotar");
    expect(asentarHref(renderAt("/mis-mascotas/DIM-PAMP-0001", 1))).toBe(
      "/mis-mascotas/DIM-PAMP-0001?sheet=anotar",
    );
    expect(renderAt("/mis-mascotas", 1)).not.toContain("Registrar mascota");
  });

  it("a pet token in the path WINS over a zero count — org/foster viewers keep Asentar", () => {
    // An org or foster user can sit on a pet profile inside the citizen shell
    // while owning nothing themselves; for them the capture action on THAT pet
    // is correct and the alta would be wrong.
    const html = renderAt("/mis-mascotas/DIM-PAMP-0001", 0);
    expect(asentarHref(html)).toBe("/mis-mascotas/DIM-PAMP-0001?sheet=anotar");
    expect(html).not.toContain("Registrar mascota");
  });

  it("the reserved index child /mis-mascotas/nueva is NOT read as a pet token", () => {
    // petTokenFromPathname requires a DIM- prefix; without that guard the alta
    // slot would self-target and hand a zero-pet owner a ?sheet=anotar no-op.
    expect(slotHref(renderAt("/mis-mascotas/nueva", 0), "Registrar mascota")).toBe(
      "/mis-mascotas/nueva",
    );
  });
});
