// Unit tests for shell-nav — the auth-aware navigation decision (spec D3/D13).
// Pure module, no React, no DB. This is the test-first core of Item 7 Phase A.

import {
  ADMIN_NAV,
  GOB_NAV,
  OWNER_NAV,
  PUBLIC_NAV,
  buildOrgNavFlat,
} from "@/components/layout/nav-presets";
import { describe, expect, it } from "vitest";
import {
  type ShellNavInput,
  buildSwitcher,
  isTokenLandingPath,
  resolveShellNav,
} from "./shell-nav";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function anon(pathname: string): ShellNavInput {
  return { session: null, pathname };
}

function owner(pathname: string): ShellNavInput {
  return {
    session: { role: "owner", displayName: "Ana Pérez" },
    pathname,
  };
}

function govt(
  pathname: string,
  opts: Partial<NonNullable<ShellNavInput["session"]>> = {},
): ShellNavInput {
  return {
    session: { role: "govt", displayName: "Inspectora", ...opts },
    pathname,
  };
}

function admin(pathname: string): ShellNavInput {
  return {
    session: { role: "admin", displayName: "Root", govtAssignments: true },
    pathname,
  };
}

// ---------------------------------------------------------------------------
// D13 — token-landing path detection
// ---------------------------------------------------------------------------

describe("isTokenLandingPath (D13)", () => {
  it("matches /p/<token> credential pages and sub-actions", () => {
    expect(isTokenLandingPath("/p/DIM-ABCD-1234")).toBe(true);
    expect(isTokenLandingPath("/p/DIM-ABCD-1234/encontre")).toBe(true);
    expect(isTokenLandingPath("/p/DIM-ABCD-1234/sighting")).toBe(true);
  });

  it("matches the bare /p index too", () => {
    expect(isTokenLandingPath("/p")).toBe(true);
  });

  it("matches /libreta/compartir/<shareToken>", () => {
    expect(isTokenLandingPath("/libreta/compartir/SHARE-XYZ")).toBe(true);
  });

  it("matches /r/invite and /r/invite/<token>", () => {
    expect(isTokenLandingPath("/r/invite")).toBe(true);
    expect(isTokenLandingPath("/r/invite/INV-123")).toBe(true);
  });

  it("does NOT match the owner libreta surface (/libreta only)", () => {
    expect(isTokenLandingPath("/libreta")).toBe(false);
  });

  it("does NOT match browse public surfaces", () => {
    expect(isTokenLandingPath("/adoptar")).toBe(false);
    expect(isTokenLandingPath("/")).toBe(false);
    expect(isTokenLandingPath("/inicio")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D3 — anonymous on a public browse surface → citizen + PUBLIC_NAV
// ---------------------------------------------------------------------------

describe("resolveShellNav — anonymous", () => {
  it("anon on /adoptar → citizen + PUBLIC_NAV, no role return", () => {
    const r = resolveShellNav(anon("/adoptar"));
    expect(r.variant).toBe("citizen");
    expect(r.nav).toBe(PUBLIC_NAV);
    expect(r.showReturn).toBe(false);
  });

  it("anon on / (landing root) → citizen + PUBLIC_NAV", () => {
    const r = resolveShellNav(anon("/"));
    expect(r.variant).toBe("citizen");
    expect(r.nav).toBe(PUBLIC_NAV);
  });

  it("anon on a token-landing surface → landing, NO PUBLIC_NAV (D13)", () => {
    const r = resolveShellNav(anon("/p/DIM-ABCD-1234"));
    expect(r.variant).toBe("landing");
    expect(r.nav).toEqual([]);
    expect(r.nav).not.toBe(PUBLIC_NAV);
    expect(r.showReturn).toBe(false);
    expect(r.returnHref).toBeUndefined();
  });

  it("anon never gets a switcher (single context)", () => {
    expect(resolveShellNav(anon("/adoptar")).switcher).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D3/D4 — the stranded-user fix. Logged-in owner on a public surface keeps
// the role nav + a guaranteed return, never falls back to PUBLIC_NAV.
// ---------------------------------------------------------------------------

describe("resolveShellNav — owner (D3/D4 stranded fix)", () => {
  it("owner on /inicio → citizen + OWNER_NAV, no return (already home)", () => {
    const r = resolveShellNav(owner("/inicio"));
    expect(r.variant).toBe("citizen");
    expect(r.nav).toBe(OWNER_NAV);
    expect(r.showReturn).toBe(false);
  });

  it("owner on /adoptar (public surface) → STILL citizen + OWNER_NAV, not stranded", () => {
    const r = resolveShellNav(owner("/adoptar"));
    expect(r.variant).toBe("citizen");
    // Critical regression guard: a public surface NEVER replaces the role nav.
    expect(r.nav).toBe(OWNER_NAV);
    expect(r.nav).not.toBe(PUBLIC_NAV);
  });

  it("owner on /denuncias (public surface) has NO separate return chip — OWNER_NAV's own Mis mascotas item covers it", () => {
    const r = resolveShellNav(owner("/denuncias"));
    expect(r.variant).toBe("citizen");
    expect(r.nav).toBe(OWNER_NAV);
    expect(r.showReturn).toBe(false);
    expect(r.returnHref).toBeUndefined();
    // The dedupe only holds because OWNER_NAV itself always renders and carries
    // "Mis mascotas" → /mis-mascotas, the 1-click way back into the citizen app
    // (PO ronda 4: the "Inicio" item is gone; the href intentionally differs
    // from roleHome's "/inicio", which is now just a courtesy redirect into the
    // most-urgent credential). Guard the premise here too.
    expect(OWNER_NAV.some((i) => i.label === "Mis mascotas" && i.href === "/mis-mascotas")).toBe(
      true,
    );
  });

  it("owner on a deep /inicio sub-route is still 'home' (no return)", () => {
    const r = resolveShellNav(owner("/inicio/resumen"));
    expect(r.showReturn).toBe(false);
  });

  it("owner on a token-landing surface → landing chrome with a discreet return to app (D13)", () => {
    const r = resolveShellNav(owner("/p/DIM-ABCD-1234"));
    // D13: token-landing wins regardless of auth state.
    expect(r.variant).toBe("landing");
    expect(r.nav).toEqual([]);
    // …but a logged-in owner still gets a quiet way back to their app.
    expect(r.showReturn).toBe(true);
    expect(r.returnHref).toBe("/inicio");
  });
});

// ---------------------------------------------------------------------------
// D1/D12 — operator variant resolves to the rail + the right nav source.
// ---------------------------------------------------------------------------

describe("resolveShellNav — operator", () => {
  it("govt on /gob/vigilancia → operator + GOB_NAV", () => {
    const r = resolveShellNav(govt("/gob/vigilancia"));
    expect(r.variant).toBe("operator");
    expect(r.nav).toBe(GOB_NAV);
    expect(r.showReturn).toBe(false);
  });

  it("govt on the /gob panel root → operator + GOB_NAV", () => {
    const r = resolveShellNav(govt("/gob"));
    expect(r.variant).toBe("operator");
    expect(r.nav).toBe(GOB_NAV);
  });

  it("admin on /admin/cola → operator + ADMIN_NAV", () => {
    const r = resolveShellNav(admin("/admin/cola"));
    expect(r.variant).toBe("operator");
    expect(r.nav).toBe(ADMIN_NAV);
  });

  it("operator opening a public surface stays operator with a return (does not fall to citizen-public)", () => {
    const r = resolveShellNav(govt("/adoptar"));
    expect(r.variant).toBe("operator");
    expect(r.nav).toBe(GOB_NAV);
    expect(r.showReturn).toBe(true);
    // The return points at the operator's OWN portal, not at the citizen world.
    // This asserted "/mis-mascotas" — the destination the comment in the source
    // called a "personal escape hatch" — while app/(app)/layout.tsx redirects
    // govt straight back to /gob. The link advertised a page the product
    // refuses to serve, so clicking it cost a redirect and landed you where you
    // started. The assertion encoded that.
    expect(r.returnHref).toBe("/gob");
  });

  it("an admin's return goes to /admin, for the same reason", () => {
    const r = resolveShellNav(admin("/adoptar"));
    expect(r.showReturn).toBe(true);
    expect(r.returnHref).toBe("/admin");
  });

  it("org member on /org/ORG-1/mascotas → operator + the built (flat) org nav", () => {
    const orgNav = buildOrgNavFlat("ORG-1");
    const r = resolveShellNav({
      session: { role: "vet", displayName: "Vet", orgNav },
      pathname: "/org/ORG-1/mascotas",
    });
    expect(r.variant).toBe("operator");
    expect(r.nav).toBe(orgNav);
    expect(r.returnHref).toBe("/mis-mascotas");
  });

  it("personal role on /org/* WITHOUT a supplied org nav falls through to citizen", () => {
    // Defensive: a member layout always supplies orgNav; absent it, never crash.
    const r = resolveShellNav({
      session: { role: "owner", displayName: "Ana" },
      pathname: "/org/ORG-1/mascotas",
    });
    expect(r.variant).toBe("citizen");
    expect(r.nav).toBe(OWNER_NAV);
  });

  it("operator on a token-landing surface still resolves to landing (D13 is auth-independent)", () => {
    const r = resolveShellNav(govt("/p/DIM-ABCD-1234"));
    expect(r.variant).toBe("landing");
    expect(r.nav).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// D6 — context switcher entitlements. Only enabled destinations appear, and a
// single-context user gets no switcher.
// ---------------------------------------------------------------------------

describe("resolveShellNav — context switcher (D6)", () => {
  it("owner with no memberships → no switcher", () => {
    const r = resolveShellNav(owner("/inicio"));
    expect(r.switcher).toEqual([]);
  });

  it("admin with govt assignments → switcher offers gob, never re-lists admin", () => {
    const r = resolveShellNav(admin("/admin"));
    const targets = r.switcher.map((s) => s.key);
    expect(targets).toContain("gob");
    expect(targets).not.toContain("admin"); // already here, not re-listed
  });

  it("admin without govt assignments → no gob in the switcher", () => {
    const r = resolveShellNav({
      session: { role: "admin", displayName: "Root", govtAssignments: false },
      pathname: "/admin",
    });
    expect(r.switcher.map((s) => s.key)).not.toContain("gob");
  });

  it("never exposes gob/admin to a plain owner", () => {
    const r = resolveShellNav(owner("/inicio"));
    const targets = r.switcher.map((s) => s.key);
    expect(targets).not.toContain("gob");
    expect(targets).not.toContain("admin");
  });

  it("admin on /gob → switcher offers 'Volver a Admin', never a citizen escape [B1/B2]", () => {
    const r = resolveShellNav(admin("/gob"));
    const back = r.switcher.find((s) => s.key === "admin");
    expect(back?.href).toBe("/admin");
    expect(r.switcher.map((s) => s.key)).not.toContain("citizen");
  });

  it("institutional roles never get a 'volver a ciudadano' escape [B2]", () => {
    // govt and admin are institutional — no owner identity, cannot own pets.
    expect(resolveShellNav(govt("/gob")).switcher.map((s) => s.key)).not.toContain("citizen");
    expect(resolveShellNav(admin("/admin")).switcher.map((s) => s.key)).not.toContain("citizen");
  });

  it("a single-context owner (no org, no govt) yields an empty switcher (D6: not shown)", () => {
    const r = resolveShellNav(owner("/inicio"));
    expect(r.switcher.length).toBe(0);
  });

  it("owner with org memberships → switcher lists each org, never gob/admin", () => {
    const r = resolveShellNav({
      session: {
        role: "owner",
        displayName: "Ana",
        orgMemberships: [
          { token: "ORG-1", name: "Refugio Norte" },
          { token: "ORG-2", name: "Refugio Sur" },
        ],
      },
      pathname: "/inicio",
    });
    const keys = r.switcher.map((s) => s.key);
    expect(keys).toEqual(["org", "org"]);
    expect(r.switcher.map((s) => s.href)).toEqual(["/org/ORG-1", "/org/ORG-2"]);
    expect(keys).not.toContain("gob");
    expect(keys).not.toContain("admin");
  });
});

// ---------------------------------------------------------------------------
// buildSwitcher — exported entitlement helper, tested directly (Phase B reuse).
// ---------------------------------------------------------------------------

describe("buildSwitcher (D6, exported, surface-aware)", () => {
  it("returns [] for an anonymous session", () => {
    expect(buildSwitcher(null, "/gob")).toEqual([]);
  });

  it("admin on /admin with govtAssignments → only the gob hop (no citizen escape)", () => {
    const targets = buildSwitcher(
      { role: "admin", displayName: "Root", govtAssignments: true },
      "/admin",
    );
    expect(targets.map((t) => t.key)).toEqual(["gob"]);
  });

  it("admin on /gob → only the way back to admin (B1), never citizen (B2)", () => {
    const targets = buildSwitcher(
      { role: "admin", displayName: "Root", govtAssignments: true },
      "/gob/mortalidad",
    );
    expect(targets.map((t) => t.key)).toEqual(["admin"]);
    expect(targets[0].href).toBe("/admin");
  });
});
