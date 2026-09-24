import { deriveOperatorCrumbs } from "@/lib/ui/operator-breadcrumbs";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// GOB portal
// ---------------------------------------------------------------------------

describe("deriveOperatorCrumbs — gob portal", () => {
  it("returns a single unlinked root crumb on the portal root", () => {
    const crumbs = deriveOperatorCrumbs("/gob", "gob");
    expect(crumbs).toEqual([{ label: "Briefing" }]);
    // Root crumb has NO href when on the root itself.
    expect(crumbs[0]).not.toHaveProperty("href");
  });

  it("returns two crumbs on a known section route", () => {
    const crumbs = deriveOperatorCrumbs("/gob/vigilancia", "gob");
    expect(crumbs).toHaveLength(2);
    // First crumb links to portal root.
    expect(crumbs[0]).toEqual({ label: "Briefing", href: "/gob" });
    // Second crumb is the current section (no link — current page).
    expect(crumbs[1]).toEqual({ label: "Vigilancia" });
    expect(crumbs[1]).not.toHaveProperty("href");
  });

  // THE crumb the Panel→Briefing rename exists for (PO decision 2026-08-01).
  // It used to read "Panel › Panorama": two general-overview nouns side by
  // side, in the one place a reader looks to find out where they are. Pinned
  // as a pair — asserting only the root would let the section crumb drift, and
  // asserting only the section would let the root slide back to "Panel".
  it("reads 'Briefing › Panorama' on /gob/panorama — no synonym pair in the trail", () => {
    expect(deriveOperatorCrumbs("/gob/panorama", "gob")).toEqual([
      { label: "Briefing", href: "/gob" },
      { label: "Panorama" },
    ]);
  });

  it("maps /gob/maltrato to 'Maltrato' (F1 fusion, 2026-07-22: no longer a nav item — the label now comes from STATIC_SEGMENT_LABELS, since the [id] detail route survives the route unmove)", () => {
    const crumbs = deriveOperatorCrumbs("/gob/maltrato", "gob");
    expect(crumbs[1]).toEqual({ label: "Maltrato" });
  });

  it("maps /gob/moderacion to 'Moderación' with the accent (F1 fusion regression guard — removed from nav, must not fall through to capitalise() and lose the accent)", () => {
    const crumbs = deriveOperatorCrumbs("/gob/moderacion", "gob");
    expect(crumbs[1]).toEqual({ label: "Moderación" });
  });

  it("maps /gob/mortalidad to 'Mortalidad'", () => {
    const crumbs = deriveOperatorCrumbs("/gob/mortalidad", "gob");
    expect(crumbs[1]).toEqual({ label: "Mortalidad" });
  });

  it("maps /gob/organizaciones to 'Organizaciones' (F3+F7 fusion, 2026-07-22: no longer a nav item — the label now comes from STATIC_SEGMENT_LABELS)", () => {
    const crumbs = deriveOperatorCrumbs("/gob/organizaciones", "gob");
    expect(crumbs[1]).toEqual({ label: "Organizaciones" });
  });

  it("maps /gob/servicios to 'Servicios' (F3+F7 fusion, 2026-07-22: no longer a nav item — the label now comes from STATIC_SEGMENT_LABELS)", () => {
    const crumbs = deriveOperatorCrumbs("/gob/servicios", "gob");
    expect(crumbs[1]).toEqual({ label: "Servicios" });
  });

  it("maps /gob/rupga to 'Credenciales RUPGA' (F3+F7 fusion regression guard — removed from nav, must not fall through to capitalise() and read as a bare acronym)", () => {
    const crumbs = deriveOperatorCrumbs("/gob/rupga", "gob");
    expect(crumbs[1]).toEqual({ label: "Credenciales RUPGA" });
  });

  it("maps /gob/campanas to 'Campañas' with the ñ (F2 fusion regression guard — removed from nav, must not fall through to capitalise() and lose the accent)", () => {
    const crumbs = deriveOperatorCrumbs("/gob/campanas", "gob");
    expect(crumbs[1]).toEqual({ label: "Campañas" });
  });

  it("maps /gob/outreach to 'Alcance comunitario' (F2 fusion, 2026-07-22: no longer a nav item — the label now comes from STATIC_SEGMENT_LABELS)", () => {
    const crumbs = deriveOperatorCrumbs("/gob/outreach", "gob");
    expect(crumbs[1]).toEqual({ label: "Alcance comunitario" });
  });

  it("maps /gob/vigilancia/investigaciones to 'Investigaciones' (static segment, not Detalle)", () => {
    const crumbs = deriveOperatorCrumbs("/gob/vigilancia/investigaciones", "gob");
    expect(crumbs).toHaveLength(3);
    expect(crumbs[1]).toEqual({ label: "Vigilancia", href: "/gob/vigilancia" });
    expect(crumbs[2]).toEqual({ label: "Investigaciones" });
  });

  it("returns 'Detalle' for dynamic id segment — does NOT echo the raw id", () => {
    const rawId = "b3a1f2c4-e5d6-7890-abcd-ef1234567890";
    const crumbs = deriveOperatorCrumbs(`/gob/maltrato/${rawId}`, "gob");
    expect(crumbs).toHaveLength(3);
    // First crumb links to root.
    expect(crumbs[0]).toEqual({ label: "Briefing", href: "/gob" });
    // Section crumb links to the section index.
    expect(crumbs[1]).toEqual({ label: "Maltrato", href: "/gob/maltrato" });
    // Detail crumb is generic — NOT the raw UUID.
    expect(crumbs[2]).toEqual({ label: "Detalle" });
    expect(crumbs[2]?.label).not.toBe(rawId);
  });

  it("does not echo a nanoid/token as a crumb label", () => {
    const token = "xK9mNpQr3sT8vW2y"; // 17-char nanoid-style token
    const crumbs = deriveOperatorCrumbs(`/gob/casos/${token}`, "gob");
    expect(crumbs[2]).toEqual({ label: "Detalle" });
    expect(crumbs[2]?.label).not.toBe(token);
  });

  it("trailing slash is handled gracefully (treated as root)", () => {
    const crumbs = deriveOperatorCrumbs("/gob/", "gob");
    expect(crumbs).toEqual([{ label: "Briefing" }]);
  });

  it("first crumb always links to /gob on any non-root page", () => {
    const routes = ["/gob/casos", "/gob/vigilancia", "/gob/programa", "/gob/usuarios"];
    for (const route of routes) {
      const crumbs = deriveOperatorCrumbs(route, "gob");
      expect(crumbs[0]).toEqual({ label: "Briefing", href: "/gob" });
    }
  });
});

// ---------------------------------------------------------------------------
// ADMIN portal
// ---------------------------------------------------------------------------

describe("deriveOperatorCrumbs — admin portal", () => {
  it("returns a single unlinked root crumb on the portal root", () => {
    const crumbs = deriveOperatorCrumbs("/admin", "admin");
    expect(crumbs).toEqual([{ label: "Briefing" }]);
    expect(crumbs[0]).not.toHaveProperty("href");
  });

  it("returns two crumbs on a known section route", () => {
    const crumbs = deriveOperatorCrumbs("/admin/moderacion", "admin");
    expect(crumbs).toHaveLength(2);
    expect(crumbs[0]).toEqual({ label: "Briefing", href: "/admin" });
    expect(crumbs[1]).toEqual({ label: "Moderación" });
    expect(crumbs[1]).not.toHaveProperty("href");
  });

  // Admin twin of the /gob/panorama crumb above — /admin ships its own
  // Panorama entry, so it had the identical "Panel › Panorama" synonym pair.
  it("reads 'Briefing › Panorama' on /admin/panorama — no synonym pair in the trail", () => {
    expect(deriveOperatorCrumbs("/admin/panorama", "admin")).toEqual([
      { label: "Briefing", href: "/admin" },
      { label: "Panorama" },
    ]);
  });

  it("maps /admin/usuarios to 'Usuarios'", () => {
    const crumbs = deriveOperatorCrumbs("/admin/usuarios", "admin");
    expect(crumbs[1]).toEqual({ label: "Usuarios" });
  });

  it("maps /admin/auditoria to 'Auditoría'", () => {
    const crumbs = deriveOperatorCrumbs("/admin/auditoria", "admin");
    expect(crumbs[1]).toEqual({ label: "Auditoría" });
  });

  it("maps /admin/organizaciones to 'Organizaciones' (F3+F7 fusion, 2026-07-22: no longer a nav item — the label now comes from STATIC_SEGMENT_LABELS)", () => {
    const crumbs = deriveOperatorCrumbs("/admin/organizaciones", "admin");
    expect(crumbs[1]).toEqual({ label: "Organizaciones" });
  });

  it("maps /admin/jurisdicciones to 'Jurisdicciones'", () => {
    const crumbs = deriveOperatorCrumbs("/admin/jurisdicciones", "admin");
    expect(crumbs[1]).toEqual({ label: "Jurisdicciones" });
  });

  it("returns 'Detalle' for dynamic id segment — does NOT echo the raw id", () => {
    const rawId = "a1b2c3d4-0000-1111-2222-333344445555";
    const crumbs = deriveOperatorCrumbs(`/admin/moderacion/${rawId}`, "admin");
    expect(crumbs).toHaveLength(3);
    expect(crumbs[0]).toEqual({ label: "Briefing", href: "/admin" });
    expect(crumbs[1]).toEqual({ label: "Moderación", href: "/admin/moderacion" });
    expect(crumbs[2]).toEqual({ label: "Detalle" });
    expect(crumbs[2]?.label).not.toBe(rawId);
  });

  it("does not echo a long public token as a crumb label", () => {
    const token = "offeringTokenXYZ99"; // 18 chars
    const crumbs = deriveOperatorCrumbs(`/admin/servicios/${token}`, "admin");
    expect(crumbs[2]).toEqual({ label: "Detalle" });
    expect(crumbs[2]?.label).not.toBe(token);
  });

  it("first crumb always links to /admin on any non-root page", () => {
    const routes = [
      "/admin/cola",
      "/admin/casos",
      "/admin/moderacion",
      "/admin/usuarios",
      "/admin/auditoria",
    ];
    for (const route of routes) {
      const crumbs = deriveOperatorCrumbs(route, "admin");
      expect(crumbs[0]).toEqual({ label: "Briefing", href: "/admin" });
    }
  });

  it("handles a deep static sub-path (two known segments) without leaking ids", () => {
    // /admin/jurisdicciones/ar — "ar" is a short static code, not an id
    const crumbs = deriveOperatorCrumbs("/admin/jurisdicciones/ar", "admin");
    // Should NOT return "Detalle" for a 2-char code that isn't an id.
    // It returns [Briefing, Jurisdicciones, Ar] — a capitalised sub-label.
    expect(crumbs).toHaveLength(3);
    expect(crumbs[2]?.label).not.toBe("Detalle");
    expect(crumbs[2]?.label).not.toBe("ar"); // capitalised at minimum
  });
});
