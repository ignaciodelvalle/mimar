/**
 * 2.1 — Touch target tests (44px / min-h-11).
 *
 * Asserts that interactive controls in the specified components render with
 * `min-h-11` (44px) and no longer use the old `min-h-9` (36px) class.
 *
 * Pattern: react-dom/server renderToStaticMarkup (repo convention — no jsdom).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// PetQuickActions — 44px touch-target coverage removed with the component
// itself (two-face redesign, 2026-07-01, Phase 4: PetQuickActions was
// replaced by the Anotar CTA + action row on the pet-profile Credencial
// face; no remaining caller — see design deletion list + apply-progress).

// ---------------------------------------------------------------------------
// LnWizardShell — back button
// ---------------------------------------------------------------------------

import { LnWizardShell } from "@/components/ui/WizardShell";

describe("LnWizardShell — 44px back button (UX 2.1)", () => {
  it("back button uses h-11 w-11 and not h-9 w-9", () => {
    const html = renderToStaticMarkup(
      <LnWizardShell currentStep={2} totalSteps={3} onBack={() => {}}>
        <p>content</p>
      </LnWizardShell>,
    );
    // The old class h-9 must be gone; h-11 must be present on the button.
    expect(html).not.toContain("h-9");
    expect(html).toContain("h-11");
  });
});

// ---------------------------------------------------------------------------
// OpRailNav — nav links
// ---------------------------------------------------------------------------

import { OpRailNav } from "@/components/ui/dashboard/OpRailNav";

// OpRailNav uses usePathname, and useRouter (P5 hover/focus prefetch,
// perf sweep 2026-08-02) — stub both.
vi.mock("next/navigation", () => ({
  usePathname: () => "/gob/dashboard",
  useRouter: () => ({ prefetch: vi.fn() }),
}));

describe("OpRailNav — 44px nav links (UX 2.1)", () => {
  it("nav links use min-h-11 and not min-h-9", () => {
    const html = renderToStaticMarkup(
      <OpRailNav nav={[{ href: "/gob/dashboard", label: "Dashboard" }]} />,
    );
    expect(html).not.toContain("min-h-9");
    expect(html).toContain("min-h-11");
  });
});

// ---------------------------------------------------------------------------
// OpRail — "¿Necesitás ayuda?" (pilot T1-P5). The rail is every operator
// shell's (/gob, /org, /admin), so this one render covers all three: the entry
// is there, it reaches the mailbox a person reads, and it clears 44px.
// ---------------------------------------------------------------------------

import { OpRail } from "@/components/ui/dashboard/OpRail";

describe("OpRail — help entry reaches a person (T1-P5)", () => {
  it("renders a 44px mailto to hola@mimar.com.ar, with the address visible", () => {
    const html = renderToStaticMarkup(
      <OpRail nav={[{ href: "/gob/dashboard", label: "Dashboard" }]} />,
    );
    expect(html).toContain("¿Necesitás ayuda?");
    expect(html).toMatch(
      /<a href="mailto:hola@mimar\.com\.ar\?subject=[^"]+" class="[^"]*min-h-11/,
    );
    expect(html).toContain(">hola@mimar.com.ar<");
  });
});

// ---------------------------------------------------------------------------
// PetActionRow — labeled action bar (PO 2026-07-05: relabeled from icon-only
// circles to the handoff's `.actionbar` — Compartir · Editar datos · Marcar
// como perdida · Más). Full coverage lives in
// components/pet-profile/PetActionRow.test.tsx; this asserts the cross-cutting
// 44px touch-target invariant this sweep exists to guard. The 44px min-height
// now lives on the shared `.ln-act` class (globals.css) rather than a
// min-h-11 utility, so this checks every action carries `ln-act`.
// "Marcar como encontrada" moved to LostCaseBlock as a prominent primary CTA
// (its 44px/48px sizing lives on `.ln-found-cta`).
// ---------------------------------------------------------------------------

import { PetActionRow } from "@/components/pet-profile/PetActionRow";

describe("PetActionRow — labeled buttons clear 44px (UX 2.1)", () => {
  it("every action link uses .ln-act (min-height:44px in globals.css)", () => {
    const html = renderToStaticMarkup(
      <PetActionRow petPublicToken="abc" isOwner isDeceased={false} petStatus="active" />,
    );
    const anchors = html.match(/<a [^>]*>/g) ?? [];
    // Owner + active: Anotar · Compartir · Editar datos · Marcar como perdida · Más
    // (Anotar added by the 3b redesign, task #10 — the mid-face capture shortcut).
    expect(anchors.length).toBe(5);
    for (const anchor of anchors) {
      expect(anchor).toContain("ln-act");
    }
  });
});

// ---------------------------------------------------------------------------
// AppCitizenMasthead — hamburger / bell / anon login CTA (native-mobile
// audit 2026-07-04 §9: hamburger was 40px, bell ~18px, login CTA 36px).
// Drawer rows are not asserted here: vaul portals don't render in static
// markup while the drawer is closed.
// ---------------------------------------------------------------------------

import { AppCitizenMasthead } from "@/components/layout/AppCitizenMasthead";

describe("AppCitizenMasthead — 44px masthead controls (native-mobile audit §9)", () => {
  it("hamburger trigger and notification bell carry min-h-11 AND min-w-11", () => {
    const html = renderToStaticMarkup(
      <AppCitizenMasthead
        nav={[{ href: "/inicio", label: "Inicio", matchPrefix: "/inicio" }]}
        user={{ name: "Ana", initials: "AN" }}
        unreadCount={2}
      />,
    );

    const hamburger = html.match(/<button[^>]*aria-label="Abrir menú"[^>]*>/)?.[0];
    expect(hamburger).toBeDefined();
    expect(hamburger).toContain("min-h-11");
    expect(hamburger).toContain("min-w-11");

    const bell = html.match(/<a[^>]*aria-label="Notificaciones[^"]*"[^>]*>/)?.[0];
    expect(bell).toBeDefined();
    expect(bell).toContain("min-h-11");
    expect(bell).toContain("min-w-11");
  });

  it("anonymous login CTA is min-h-11, no longer min-h-[36px]", () => {
    const html = renderToStaticMarkup(<AppCitizenMasthead nav={[]} user={null} />);
    const login = html.match(/<a[^>]*href="\/iniciar-sesion"[^>]*>/)?.[0];
    expect(login).toBeDefined();
    expect(login).toContain("min-h-11");
    expect(html).not.toContain("min-h-[36px]");
  });
});

// ---------------------------------------------------------------------------
// CitizenTabBar — bottom tabs must each clear 44px (min-h-12 = 48px).
// ---------------------------------------------------------------------------

import { CitizenTabBar } from "@/components/layout/CitizenTabBar";
import { OWNER_NAV } from "@/components/layout/nav-presets";

describe("CitizenTabBar — 44px tab targets", () => {
  // D.8: the centre slot's label depends on the owned-pet count ("Asentar"
  // with pets, "Registrar mascota" without), so the target check runs on BOTH
  // branches — the 44px floor is not allowed to depend on which one renders.
  it.each([
    ["with pets (Asentar)", 3],
    ["with zero pets (Registrar mascota)", 0],
  ])("all owner tabs plus the centre slot render as links with min-h-12 — %s", (_label, count) => {
    const html = renderToStaticMarkup(<CitizenTabBar nav={OWNER_NAV} ownedPetsCount={count} />);
    const anchors = html.match(/<a [^>]*>/g) ?? [];
    // OWNER_NAV tabs + the injected centre capture/alta action (task #9).
    expect(anchors.length).toBe(OWNER_NAV.length + 1);
    for (const anchor of anchors) {
      expect(anchor).toContain("min-h-12");
    }
  });

  it("includes the Asentar capture action pointing at /inicio?sheet=anotar (P5 review fix)", () => {
    const html = renderToStaticMarkup(<CitizenTabBar nav={OWNER_NAV} ownedPetsCount={3} />);
    // Off any pet-profile route (usePathname is unmocked → null here), the
    // capture action falls back to /inicio?sheet=anotar — /inicio's redirect
    // forwards the query string, so the most-urgent pet's profile opens WITH
    // the anotar sheet in one navigation (P5 fresh-review CRITICAL fix; a bare
    // /inicio landed on the profile without the sheet).
    const asentarSeg = html.split(/<a /).find((s) => />Asentar</.test(s));
    expect(asentarSeg?.match(/href="([^"]*)"/)?.[1]).toBe("/inicio?sheet=anotar");
  });

  it("with zero pets the centre slot is the alta, not the inert capture (D.8)", () => {
    const html = renderToStaticMarkup(<CitizenTabBar nav={OWNER_NAV} ownedPetsCount={0} />);
    const altaSeg = html.split(/<a /).find((s) => />Registrar mascota</.test(s));
    expect(altaSeg?.match(/href="([^"]*)"/)?.[1]).toBe("/mis-mascotas/nueva");
  });
});

// ---------------------------------------------------------------------------
// The two shared close buttons, and the switch (a11y audit 2026-09-16).
//
// WHY THESE WERE MISSED FOR SO LONG, which matters more than the three fixes:
// this file ENUMERATES components rather than sweeping them. Every block above
// was added by whoever was fixing that component at the time, so the fence only
// ever covers what somebody already remembered. LnCard and LnSheet's close
// buttons have been 30x30 the whole time — in every sheet in the app, including
// every one used to record an event — and no assertion here had an opinion.
//
// The shape of the fix is also worth naming: the boxes stay 30px and the
// TARGET grows to 44 through a centred pseudo-element, which is what WCAG 2.5.5
// measures. So the assertion cannot look for `h-11` on the element the way the
// blocks above do; it looks for the after:-prefixed target. A future component
// that solves this the other way (by growing the box) will not match, and that
// is correct — it should get its own case rather than be waved through.
// ---------------------------------------------------------------------------

// BOTH are sheet headers, and that is the point: `LnSheet` (in Card.tsx) and
// `LnSheetHeader` (in Sheet.tsx) are two separate implementations of the same
// header, each with its own copy of the close button. Fixing one and assuming
// the other followed is exactly how this defect survived.
import { LnSheet } from "@/components/ui/Card";
import { LnSheetHeader } from "@/components/ui/Sheet";
import { LnToggle } from "@/components/ui/Toggle";

const TARGET_44 = ["after:h-11", "after:w-11", "after:-translate-x-1/2", "after:-translate-y-1/2"];

describe("shared close buttons clear 44px (a11y audit 2026-09-16)", () => {
  it("LnSheet's close button carries a 44px target", () => {
    const html = renderToStaticMarkup(
      <LnSheet title="t" onClose={() => {}}>
        <p>content</p>
      </LnSheet>,
    );
    const button = (html.match(/<button [^>]*aria-label="Cerrar"[^>]*>/) ?? [])[0];
    expect(button).toBeDefined();
    for (const cls of TARGET_44) expect(button).toContain(cls);
  });

  it("LnSheetHeader's close button carries a 44px target AND a focus ring", () => {
    const html = renderToStaticMarkup(<LnSheetHeader title="t" onClose={() => {}} />);
    const button = (html.match(/<button [^>]*aria-label="Cerrar"[^>]*>/) ?? [])[0];
    expect(button).toBeDefined();
    for (const cls of TARGET_44) expect(button).toContain(cls);
    // This one had no focus ring while its twin in Card did — a keyboard user
    // closing a sheet was aiming at something they could not see.
    expect(button).toContain("focus-visible:ring-[3px]");
  });
});

describe("LnToggle — the label is part of the control (a11y audit 2026-09-16)", () => {
  // The defect was not only size. The text beside the switch LOOKED like a
  // label and the row even carried `cursor-pointer`, but the handler lived on
  // the 38x21 track alone, so tapping the words did nothing at all.
  it("renders one button that CONTAINS the label text", () => {
    const html = renderToStaticMarkup(
      <LnToggle checked={false} onChange={() => {}} label="Mostrar mi teléfono" />,
    );
    const buttons = html.match(/<button /g) ?? [];
    expect(buttons.length).toBe(1);
    expect(html).toContain("Mostrar mi teléfono");
    // The label sits INSIDE the button, so it names it and is tappable.
    const inner = html.slice(html.indexOf("<button "), html.lastIndexOf("</button>"));
    expect(inner).toContain("Mostrar mi teléfono");
  });

  it("keeps the switch role and state on that one button", () => {
    const html = renderToStaticMarkup(
      <LnToggle checked onChange={() => {}} label="Mostrar mi teléfono" />,
    );
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
  });

  it("the inline variant grows its target to 44px", () => {
    const html = renderToStaticMarkup(
      <LnToggle inline checked={false} onChange={() => {}} label="Compacto" />,
    );
    for (const cls of TARGET_44) expect(html).toContain(cls);
  });
});
