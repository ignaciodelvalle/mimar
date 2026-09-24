// Unit tests for nav-presets — pure module, no React required.
//
// One block at the bottom ("portal home h1 agrees with its nav label") reads
// the two portal home page sources from disk. It is the only impure block in
// this file, and it lives here on purpose: nav-presets IS the source of truth
// for what the portal root is called, and the h1 that drifts from it is the
// bug (see that block's own comment for why a source scan and not a render).

import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";
import {
  ADMIN_NAV_FLAT,
  ADMIN_NAV_SECTIONS,
  GOB_NAV,
  GOB_NAV_FLAT,
  GOB_NAV_SECTIONS,
  OWNER_NAV,
  PUBLIC_NAV,
  buildOrgNav,
  buildOrgNavFlat,
} from "./nav-presets";

// Every capability that gates a nav item. QA histórico 2026-07-08 #81 widened
// the gating: Mascotas (pet.read_held), Tránsitos/Voluntarios (foster.assign),
// Operaciones (adoption.review), Servicios (service_offering.create) are now
// capability-gated so a zero-capability member's sidebar matches the panel copy
// "Cada permiso habilita su módulo en el menú". QA histórico 2026-07-08 #2
// closed the remaining gap: Transferencias (org.transfer.propose OR
// org.transfer.accept), Casos (pet.read_held), Miembros (member.invite) are
// now also capability-gated (Cobertura gates on role — see FULL_NAV below).
const ALL_GATED_CAPS = new Set([
  "appointment.manage",
  "event.write",
  "intake.create",
  "adoption.review",
  "capability.grant",
  "bite.report",
  "foster.assign",
  "pet.read_held",
  "service_offering.create",
  "member.invite",
  "org.transfer.propose",
  "org.transfer.accept",
]);

// Full nav = every capability granted AND an admin role (Maltrato +
// Configuración + Cobertura gate on role, not capability). Use for the "all
// sections present" invariants.
const FULL_NAV = { granted: ALL_GATED_CAPS, role: "admin" } as const;

describe("PUBLIC_NAV", () => {
  it("has exactly 4 items", () => {
    expect(PUBLIC_NAV).toHaveLength(4);
  });

  it("contains Adoptar, Mascotas perdidas, Refugios, Denuncias", () => {
    const labels = PUBLIC_NAV.map((i) => i.label);
    expect(labels).toContain("Adoptar");
    expect(labels).toContain("Mascotas perdidas");
    expect(labels).toContain("Refugios");
    expect(labels).toContain("Denuncias");
  });

  it("does not include Mi libreta (requires auth)", () => {
    const labels = PUBLIC_NAV.map((i) => i.label);
    expect(labels).not.toContain("Mi libreta");
    expect(labels).not.toContain("Libreta");
  });

  it("all hrefs point to public portal routes", () => {
    const hrefs = PUBLIC_NAV.map((i) => i.href);
    expect(hrefs).toContain("/adoptar");
    expect(hrefs).toContain("/perdidas");
    expect(hrefs).toContain("/refugios");
    expect(hrefs).toContain("/denuncias");
  });
});

describe("buildOrgNav (section structure)", () => {
  it("returns an array of NavSection objects (not flat NavItem[])", () => {
    const result = buildOrgNav("ORG-ABC");
    expect(Array.isArray(result)).toBe(true);
    // Each element must have a `label` string and `items` array (NavSection shape).
    for (const section of result) {
      expect(typeof section.label).toBe("string");
      expect(Array.isArray(section.items)).toBe(true);
    }
  });

  it("returns exactly 7 sections when all gated capabilities are granted", () => {
    const sections = buildOrgNav("ORG-ABC", { granted: ALL_GATED_CAPS });
    expect(sections).toHaveLength(7);
  });

  it("section labels are the nav-diet buckets: unlabeled top, 5 jobs, Administración (in order)", () => {
    const sections = buildOrgNav("ORG-ABC", { granted: ALL_GATED_CAPS });
    expect(sections.map((s) => s.label)).toEqual([
      "",
      "Ingresos",
      "Custodia",
      "Postulaciones",
      "Casos",
      "Equipo",
      "Administración",
    ]);
  });

  it("first section is the unlabeled top holding Panel", () => {
    const [first] = buildOrgNav("ORG-ABC", { granted: ALL_GATED_CAPS });
    expect(first.label).toBe("");
    expect(first.items[0]?.label).toBe("Panel");
  });

  // Scope fence for the 2026-08-01 Panel→Briefing rename: gob and admin got it
  // because THEIR rails also carry a "Panorama" entry, and two general-overview
  // nouns side by side left a funcionario guessing. The org rail has no
  // Panorama, so "Panel" collides with nothing and stays. This assertion exists
  // so a later "harmonise the portals" sweep has to argue with a test instead
  // of quietly widening the rename.
  it("keeps 'Panel' — the org rail has no Panorama entry to collide with", () => {
    const sections = buildOrgNav("ORG-ABC", FULL_NAV);
    const labels = sections.flatMap((s) => s.items.map((i) => i.label));
    expect(labels).toContain("Panel");
    expect(labels).not.toContain("Briefing");
    expect(labels).not.toContain("Panorama");
  });
});

describe("buildOrgNavFlat", () => {
  it("produces exactly Panel when no capabilities/role are passed (zero-capability member)", () => {
    // QA histórico 2026-07-08 #81 gated the operational modules; #2 (round 2)
    // closed the remaining gap — Transferencias, Casos, Miembros and Cobertura
    // were still un-gated "membership-level" items, so a zero-capability
    // foster still saw them. All four are now gated (capability or role), so
    // the true zero-grant baseline is just Panel.
    const labels = buildOrgNavFlat("ORG-ABC").map((i) => i.label);
    expect(labels).toEqual(["Panel"]);
  });

  it("produces 20 items when all capabilities are granted and role is admin", () => {
    // 20 desde 2026-08-04: se sumó "Mensajes" (bandeja de contacto público).
    expect(buildOrgNavFlat("ORG-ABC", FULL_NAV)).toHaveLength(20);
  });

  it("hides Agenda, Ingresos, Check-ins, Mordeduras and Permisos without their capabilities", () => {
    const labels = buildOrgNavFlat("ORG-ABC").map((i) => i.label);
    expect(labels).not.toContain("Agenda");
    expect(labels).not.toContain("Ingresos");
    expect(labels).not.toContain("Check-ins");
    expect(labels).not.toContain("Mordeduras");
    expect(labels).not.toContain("Permisos");
  });

  it("shows each gated item only with its own capability", () => {
    const intakeOnly = buildOrgNavFlat("ORG-ABC", { granted: new Set(["intake.create"]) }).map(
      (i) => i.label,
    );
    expect(intakeOnly).toContain("Ingresos");
    expect(intakeOnly).not.toContain("Agenda");
    expect(intakeOnly).not.toContain("Check-ins");
    expect(intakeOnly).not.toContain("Permisos");

    const agendaOnly = buildOrgNavFlat("ORG-ABC", {
      granted: new Set(["appointment.manage"]),
    }).map((i) => i.label);
    expect(agendaOnly).toContain("Agenda");
    expect(agendaOnly).not.toContain("Ingresos");
    expect(agendaOnly).not.toContain("Check-ins");
    expect(agendaOnly).not.toContain("Permisos");
  });

  it("gates Transferencias behind org.transfer.propose OR org.transfer.accept (QA #2)", () => {
    const baseline = buildOrgNavFlat("ORG-ABC").map((i) => i.label);
    expect(baseline).not.toContain("Transferencias");

    const withPropose = buildOrgNavFlat("ORG-ABC", {
      granted: new Set(["org.transfer.propose"]),
    }).map((i) => i.label);
    expect(withPropose).toContain("Transferencias");

    const withAccept = buildOrgNavFlat("ORG-ABC", {
      granted: new Set(["org.transfer.accept"]),
    }).map((i) => i.label);
    expect(withAccept).toContain("Transferencias");
  });

  it("gates Casos behind pet.read_held (QA #2)", () => {
    const baseline = buildOrgNavFlat("ORG-ABC").map((i) => i.label);
    expect(baseline).not.toContain("Casos");

    const withRead = buildOrgNavFlat("ORG-ABC", { granted: new Set(["pet.read_held"]) }).map(
      (i) => i.label,
    );
    expect(withRead).toContain("Casos");
  });

  it("gates Miembros behind member.invite (QA #2)", () => {
    const baseline = buildOrgNavFlat("ORG-ABC").map((i) => i.label);
    expect(baseline).not.toContain("Miembros");

    const withInvite = buildOrgNavFlat("ORG-ABC", { granted: new Set(["member.invite"]) }).map(
      (i) => i.label,
    );
    expect(withInvite).toContain("Miembros");
  });

  it("gates Cobertura behind role admin/coordinator, not capability (QA #2)", () => {
    // Every capability granted, still no role → hidden.
    const capsOnly = buildOrgNavFlat("ORG-ABC", { granted: ALL_GATED_CAPS }).map((i) => i.label);
    expect(capsOnly).not.toContain("Cobertura");

    // A foster (no manage role) still doesn't see it, even with every capability.
    const foster = buildOrgNavFlat("ORG-ABC", { granted: ALL_GATED_CAPS, role: "foster" }).map(
      (i) => i.label,
    );
    expect(foster).not.toContain("Cobertura");

    // admin / coordinator do, matching the page's own `canManage` check.
    const admin = buildOrgNavFlat("ORG-ABC", { role: "admin" }).map((i) => i.label);
    expect(admin).toContain("Cobertura");
    const coordinator = buildOrgNavFlat("ORG-ABC", { role: "coordinator" }).map((i) => i.label);
    expect(coordinator).toContain("Cobertura");
  });

  it("gates Tránsitos/Voluntarios behind foster.assign (QA #81)", () => {
    const labels = buildOrgNavFlat("ORG-ABC").map((i) => i.label);
    expect(labels).not.toContain("Tránsitos");
    expect(labels).not.toContain("Voluntarios");
    const withFoster = buildOrgNavFlat("ORG-ABC", { granted: new Set(["foster.assign"]) }).map(
      (i) => i.label,
    );
    expect(withFoster).toContain("Tránsitos");
    expect(withFoster).toContain("Voluntarios");
  });

  it("gates Mascotas behind pet.read_held (QA #81)", () => {
    expect(buildOrgNavFlat("ORG-ABC").map((i) => i.label)).not.toContain("Mascotas");
    const withRead = buildOrgNavFlat("ORG-ABC", { granted: new Set(["pet.read_held"]) }).map(
      (i) => i.label,
    );
    expect(withRead).toContain("Mascotas");
  });

  it("gates Maltrato + Configuración by role, not capability (QA #81)", () => {
    // No role → both hidden even with every capability granted.
    const capsOnly = buildOrgNavFlat("ORG-ABC", { granted: ALL_GATED_CAPS }).map((i) => i.label);
    expect(capsOnly).not.toContain("Maltrato");
    expect(capsOnly).not.toContain("Configuración");
    // A foster is not a welfare role and is not admin → still hidden.
    const foster = buildOrgNavFlat("ORG-ABC", { role: "foster" }).map((i) => i.label);
    expect(foster).not.toContain("Maltrato");
    expect(foster).not.toContain("Configuración");
    // A member sees Maltrato (welfare role) but not Configuración (admin-only).
    const member = buildOrgNavFlat("ORG-ABC", { role: "member" }).map((i) => i.label);
    expect(member).toContain("Maltrato");
    expect(member).not.toContain("Configuración");
    // Admin sees both.
    const admin = buildOrgNavFlat("ORG-ABC", { role: "admin" }).map((i) => i.label);
    expect(admin).toContain("Maltrato");
    expect(admin).toContain("Configuración");
  });

  it("shows Mordeduras only with bite.report, pointing at the report form", () => {
    const items = buildOrgNavFlat("ORG-ABC", { granted: new Set(["bite.report"]) });
    const mordeduras = items.find((i) => i.label === "Mordeduras");
    expect(mordeduras?.href).toBe("/org/ORG-ABC/mordedura/nuevo");
    expect(mordeduras?.matchPrefix).toBe("/org/ORG-ABC/mordedura");
  });

  it("Permisos entry points to /admin/permisos and highlights the /admin segment", () => {
    const items = buildOrgNavFlat("ORG-ABC", { granted: ALL_GATED_CAPS });
    const permisos = items.find((i) => i.label === "Permisos");
    expect(permisos?.href).toBe("/org/ORG-ABC/admin/permisos");
    expect(permisos?.matchPrefix).toBe("/org/ORG-ABC/admin");
  });

  it("does not leak requiredCapability / requiredAnyCapability / requiredRoles into the returned NavItem objects", () => {
    const items = buildOrgNavFlat("ORG-ABC", FULL_NAV);
    for (const item of items) {
      expect("requiredCapability" in item).toBe(false);
      expect("requiredAnyCapability" in item).toBe(false);
      expect("requiredRoles" in item).toBe(false);
    }
  });

  it("does not contain an equipo entry (broken nav — ADR-4: no roadmap signal → remove)", () => {
    const hrefs = buildOrgNavFlat("ORG-ABC").map((i) => i.href);
    expect(hrefs).not.toContain("/org/ORG-ABC/equipo");
  });

  it("all hrefs start with /org/<orgToken>/... (or are the exact panel root)", () => {
    const items = buildOrgNavFlat("ORG-ABC");
    for (const item of items) {
      expect(item.href).toMatch(/^\/org\/ORG-ABC/);
    }
  });

  it("uses the provided orgToken in every href", () => {
    const items = buildOrgNavFlat("MY-ORG-42");
    for (const item of items) {
      expect(item.href).toContain("MY-ORG-42");
    }
  });

  it("panel item href is exactly /org/<orgToken> (no trailing slash)", () => {
    const [panel] = buildOrgNavFlat("ORG-ABC");
    expect(panel.href).toBe("/org/ORG-ABC");
  });

  it("contains Mascotas, Servicios, Operaciones, Miembros, Cobertura, Configuración, Maltrato entries (full nav)", () => {
    const labels = buildOrgNavFlat("ORG-ABC", FULL_NAV).map((i) => i.label);
    expect(labels).toContain("Mascotas");
    expect(labels).toContain("Servicios");
    expect(labels).toContain("Postulaciones");
    expect(labels).toContain("Miembros");
    expect(labels).toContain("Cobertura");
    expect(labels).toContain("Configuración");
    expect(labels).toContain("Maltrato");
  });

  it("Cobertura entry points to /org/<orgToken>/cobertura", () => {
    // Cobertura is role-gated (admin/coordinator, QA #2) — pass role: "admin".
    const items = buildOrgNavFlat("ORG-ABC", { role: "admin" });
    const cobertura = items.find((i) => i.label === "Cobertura");
    expect(cobertura).toBeDefined();
    expect(cobertura?.href).toBe("/org/ORG-ABC/cobertura");
  });

  it("Configuración entry points to /org/<orgToken>/configuracion", () => {
    const items = buildOrgNavFlat("ORG-ABC", { role: "admin" });
    const config = items.find((i) => i.label === "Configuración");
    expect(config).toBeDefined();
    expect(config?.href).toBe("/org/ORG-ABC/configuracion");
  });

  it("Maltrato entry points to /org/<orgToken>/maltrato/recibidos", () => {
    const items = buildOrgNavFlat("ORG-ABC", { role: "member" });
    const maltrato = items.find((i) => i.label === "Maltrato");
    expect(maltrato).toBeDefined();
    expect(maltrato?.href).toBe("/org/ORG-ABC/maltrato/recibidos");
  });

  it("Maltrato entry matchPrefix covers /org/<orgToken>/maltrato (highlights both recibidos and nuevo)", () => {
    const items = buildOrgNavFlat("ORG-ABC", { role: "member" });
    const maltrato = items.find((i) => i.label === "Maltrato");
    expect(maltrato?.matchPrefix).toBe("/org/ORG-ABC/maltrato");
  });

  // Org-type gating of the shelter-only modules (task #18, preverify #10). A
  // clinic AND a sanitary_authority admin implicitly hold every capability, so
  // the org-type gate — not capability — is what drops Tránsitos / Voluntarios /
  // Operaciones / Check-ins for non-rehoming types.
  const SHELTER_ONLY_NAV = ["Tránsitos", "Voluntarios", "Censo", "Postulaciones", "Check-ins"];

  it("hides shelter-only modules for a clinic (org-type gate)", () => {
    const labels = buildOrgNavFlat("ORG-ABC", {
      granted: ALL_GATED_CAPS,
      role: "admin",
      orgType: "clinic",
    }).map((i) => i.label);
    for (const label of SHELTER_ONLY_NAV) expect(labels).not.toContain(label);
  });

  it("hides shelter-only modules for a sanitary_authority (preverify #10 — was still leaking)", () => {
    const labels = buildOrgNavFlat("ORG-ABC", {
      granted: ALL_GATED_CAPS,
      role: "admin",
      orgType: "sanitary_authority",
    }).map((i) => i.label);
    for (const label of SHELTER_ONLY_NAV) expect(labels).not.toContain(label);
    // But universal modules still show for a sanitary authority.
    expect(labels).toContain("Casos");
    expect(labels).toContain("Maltrato");
    expect(labels).toContain("Permisos");
  });

  it("keeps shelter-only modules for shelter and rescue_network", () => {
    for (const orgType of ["shelter", "rescue_network"]) {
      const labels = buildOrgNavFlat("ORG-ABC", {
        granted: ALL_GATED_CAPS,
        role: "admin",
        orgType,
      }).map((i) => i.label);
      for (const label of SHELTER_ONLY_NAV) expect(labels).toContain(label);
    }
  });

  it("hides shelter-only modules for org type 'other'", () => {
    const labels = buildOrgNavFlat("ORG-ABC", {
      granted: ALL_GATED_CAPS,
      role: "admin",
      orgType: "other",
    }).map((i) => i.label);
    for (const label of SHELTER_ONLY_NAV) expect(labels).not.toContain(label);
  });
});

describe("OWNER_NAV", () => {
  // PO ronda 4 (2026-07-15): 2 items. The former "Inicio" tab was removed —
  // /inicio is only a server redirect into the most-urgent pet's credential
  // (the carousel under /mis-mascotas/[token]), so the tab never lit up and it
  // bypassed the vet-landing gate. This SUPERSEDES the 2026-07-02 three-item
  // split (decision #645). Identity (Cuenta) is still the account pill and
  // notifications are still the bell — neither is a nav peer.
  it("has exactly 2 items", () => {
    expect(OWNER_NAV).toHaveLength(2);
  });

  it("no longer surfaces an 'Inicio' tab (the /inicio route stays; only the nav entry died)", () => {
    const inicio = OWNER_NAV.find((i) => i.label === "Inicio");
    expect(inicio).toBeUndefined();
    expect(OWNER_NAV.map((i) => i.href)).not.toContain("/inicio");
  });

  it("leads with 'Mis mascotas' → /mis-mascotas, active on pet pages via matchPrefix", () => {
    const misMascotas = OWNER_NAV.find((i) => i.label === "Mis mascotas");
    expect(misMascotas).toBeDefined();
    expect(misMascotas?.href).toBe("/mis-mascotas");
    expect(misMascotas?.matchPrefix).toBe("/mis-mascotas");
  });

  it("contains Denuncias tab pointing to /denuncias/mias", () => {
    // "Denuncias" (noun), not "Denunciar" (verb) — an action label pointing
    // at a list misled nav-first users (flow audit 2026-07-03, PO decision);
    // the list's own "Nueva denuncia" CTA carries the action.
    const denuncias = OWNER_NAV.find((i) => i.label === "Denuncias");
    expect(denuncias).toBeDefined();
    expect(denuncias?.href).toBe("/denuncias/mias");
  });

  it("is in order Mis mascotas → Denuncias", () => {
    expect(OWNER_NAV.map((i) => i.label)).toEqual(["Mis mascotas", "Denuncias"]);
  });

  it("no longer surfaces Notificaciones, Adopciones or Turnos as nav peers", () => {
    const hrefs = OWNER_NAV.map((i) => i.href);
    expect(hrefs).not.toContain("/notificaciones"); // still the bell
    expect(hrefs).not.toContain("/adoptar");
    expect(hrefs).not.toContain("/mis-turnos");
  });
});

// NOTE (test-suite audit 2026-07): the former per-route "GOB_NAV / ADMIN_NAV —
// no route regression" blocks (one `it` per href + a >=N length floor) were
// deleted as fully subsumed: GOB_NAV === GOB_NAV_FLAT === flatten(GOB_NAV_SECTIONS)
// (same for ADMIN_*), and the frozen-snapshot invariant pairs below assert set
// EQUALITY in both directions against hard-coded snapshots — strictly stronger
// than per-route containment plus a length floor.

// ---------------------------------------------------------------------------
// GOB_NAV_SECTIONS — grouped nav invariants (Item 1 PR1)
// ---------------------------------------------------------------------------

/**
 * Frozen href snapshot derived from the pre-refactor flat GOB_NAV on develop.
 * Hard-coded so a dropped href shrinks the sections union but NOT this set,
 * making the test genuinely catch membership regressions.
 */
const GOB_HREF_SNAPSHOT = new Set([
  "/gob",
  // Centro de Situación Nacional — flagship console. T1.5 (2026-08-01): the
  // nav href pins the canonical default vista (?preset&period) so a menu
  // click can never be hijacked by the saved-board restore on a bare URL.
  "/gob/panorama?preset=sintomas&period=30d",
  "/gob/programa", // gov-vis — exec summary scoped to jurisdiction
  "/gob/cola",
  "/gob/vigilancia",
  "/gob/mortalidad", // Item 2 — mortality & disposal dashboard
  "/gob/casos",
  "/gob/reglas",
  "/gob/historial",
  // /gob/analytics REMOVED from nav (F9 fusion, 2026-08-01): absorbed into the
  // Programa hub as a tabbed vista (?vista=resumen|analitica). It had been
  // listed here since the snapshot was written; an external QA pass showed the
  // entry was the second half of an ambiguity — "Ver en Programa →" and four
  // KPI tiles were two paths to two different "numbers" screens. The route
  // still exists as a permanent redirect, but it has no nav entry.
  "/gob/perdidas",
  // /gob/maltrato and /gob/moderacion REMOVED from nav (F1 fusion, 2026-07-22):
  // absorbed into the Denuncias hub as tabbed stages (?etapa=moderacion|triage).
  // Both routes still exist as permanent redirects, but neither has a nav entry.
  "/gob/decomisos",
  // /gob/campanas and /gob/outreach REMOVED from nav (F2 fusion, 2026-07-22):
  // absorbed into the Operativos hub as tabbed vistas (?vista=campanas|alcance).
  "/gob/operativos",
  // /gob/organizaciones, /gob/usuarios, /gob/servicios and /gob/rupga REMOVED
  // from nav (F3+F7 fusion, 2026-07-22): absorbed into the Directorio hub as
  // tabbed registros (?registro=organizaciones|usuarios|servicios|credenciales).
  "/gob/directorio",
  // /gob/disputas REMOVED from nav (F6 fusion, 2026-07-22): absorbed into the
  // Casos hub as a tabbed expediente (?expediente=casos|disputas). Route
  // still exists as a permanent redirect, but has no nav entry.
  // /gob/censo and /gob/poblacion REMOVED from nav (F8 fusion, 2026-07-22):
  // absorbed into the Padrón hub as tabbed vistas (?vista=poblacion|censo).
  // Both routes still exist as permanent redirects, but neither has a nav entry.
  "/gob/padron", // F8 — Padrón hub (Población + Censo)
  "/gob/adopciones", // Paquete F — pipeline de custodia & adopción
  // ADDED 2026-09-23 — "Exportar a SENASA". The export page
  // (app/gob/analytics/export/page.tsx) had no direct menu path: reaching it
  // meant Programa → its "Analítica" tab → an in-page CTA. Mirrored in
  // lib/ui/shell-nav-phase-b.test.ts's copy of this set.
  "/gob/analytics/export",
  // /gob/sistema deliberately EXCLUDED — folded into /gob/programa for govt
  // operators (2026-07-09 audit). Route still exists as a redirect for deep
  // links but is no longer in nav.
  "/gob/outbox", // gov-vis — ENO SLA / notification monitor scoped to jurisdiction
  "/gob/suscripciones", // promoted out of /gob/programa's alert sub-panel (2026-07-21)
  "/gob/denuncias", // C6a — Denuncias hub (Moderación → Triage → Caso front door)
  // G5 (obligations-worklist, 2026-08): the cross-domain deadline worklist —
  // observaciones + denuncias + casos in ONE list ranked by vencimiento;
  // leads the Bandeja operativa section.
  "/gob/acciones",
  // ADDED 2026-08-20, and this snapshot is where the addition gets argued.
  // /gob/observaciones shipped 2026-08-10 so a funcionario could reach the
  // rabies-observation console (the /admin LAYOUT, not the page guard, was
  // bouncing govt). The route landed; the nav entry did not, so the only way in
  // was to already know the URL — for a queue running a 10-day legal clock.
  // Mirrored in lib/ui/shell-nav-phase-b.test.ts's copy of this set.
  "/gob/observaciones",
  // ADDED 2026-09-09 — Cola ENO, the legal-notification queue. A PRESET of
  // /gob/outbox (`?preset=eno`): the rows bound for an external authority,
  // ordered by statutory deadline, breached first. Same query-string idiom as
  // the Panorama entry above; sits in Situación beside Vigilancia because it
  // answers the surveillance question, while the bare /gob/outbox stays the
  // operational whole in Bandeja operativa. Mirrored in shell-nav-phase-b.
  "/gob/outbox?preset=eno",
]);

describe("GOB_NAV_SECTIONS — section invariants", () => {
  it("exports GOB_NAV_SECTIONS as a non-empty array", () => {
    expect(Array.isArray(GOB_NAV_SECTIONS)).toBe(true);
    expect(GOB_NAV_SECTIONS.length).toBeGreaterThan(0);
  });

  it("no href is lost: every frozen-snapshot href appears in GOB_NAV_SECTIONS (snapshot ⊆ union)", () => {
    const sectionHrefs = new Set(GOB_NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href)));
    for (const href of GOB_HREF_SNAPSHOT) {
      expect(sectionHrefs).toContain(href);
    }
  });

  it("no href is gained: GOB_NAV_SECTIONS contains only hrefs from the frozen snapshot (union ⊆ snapshot)", () => {
    const sectionHrefs = GOB_NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href));
    for (const href of sectionHrefs) {
      expect(GOB_HREF_SNAPSHOT).toContain(href);
    }
  });

  // C6a (2026-07-22) — Casos y cumplimiento / Vigilancia sanitaria / Registro y
  // aprobaciones / Confiabilidad / Referencia were regrouped into the 5-layer
  // model (Situación/Programa/Intervención/Bandeja operativa/Profundidad).
  // These tests now encode the NEW grouping, not the old module-mirroring one.

  it("includes /gob/denuncias in the Bandeja operativa section (F1 hub)", () => {
    const bandejaSection = GOB_NAV_SECTIONS.find((s) => s.label === "Bandeja operativa");
    const hrefs = bandejaSection?.items.map((i) => i.href) ?? [];
    expect(hrefs).toContain("/gob/denuncias");
    const denuncias = bandejaSection?.items.find((i) => i.href === "/gob/denuncias");
    expect(denuncias?.label).toBe("Denuncias");
  });

  it("leads the Bandeja operativa section with /gob/acciones (G5 — the deadline worklist)", () => {
    const bandejaSection = GOB_NAV_SECTIONS.find((s) => s.label === "Bandeja operativa");
    expect(bandejaSection?.items[0]).toMatchObject({
      href: "/gob/acciones",
      label: "Acciones que vencen",
    });
  });

  it("does NOT include /gob/moderacion or /gob/maltrato anywhere (F1 fusion — absorbed into the Denuncias hub as stages)", () => {
    const allHrefs = GOB_NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href));
    expect(allHrefs).not.toContain("/gob/moderacion");
    expect(allHrefs).not.toContain("/gob/maltrato");
  });

  it("does NOT include /gob/disputas anywhere (F6 fusion — absorbed into the Casos hub as an expediente)", () => {
    const allHrefs = GOB_NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href));
    expect(allHrefs).not.toContain("/gob/disputas");
  });

  it("does NOT include /gob/poblacion or /gob/censo anywhere (F8 fusion — absorbed into the Padrón hub as vistas)", () => {
    const allHrefs = GOB_NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href));
    expect(allHrefs).not.toContain("/gob/poblacion");
    expect(allHrefs).not.toContain("/gob/censo");
  });

  it("includes /gob/mortalidad and /gob/padron in the Programa section (F8 — Padrón absorbs Población + Censo)", () => {
    const progSection = GOB_NAV_SECTIONS.find((s) => s.label === "Programa");
    const hrefs = progSection?.items.map((i) => i.href) ?? [];
    expect(hrefs).toContain("/gob/mortalidad");
    expect(hrefs).toContain("/gob/padron");
    const padron = progSection?.items.find((i) => i.href === "/gob/padron");
    expect(padron?.label).toBe("Padrón");
    // Judgment call: Adopciones (outcome-vs-target dashboard) also lives here.
    expect(hrefs).toContain("/gob/adopciones");
  });

  it("includes the padrón sanitario export in the Programa section, without naming a state body", () => {
    // The export page had no direct menu path before this entry — reaching it
    // meant Programa → its "Analítica" tab → an in-page CTA. The label names
    // the dataset, not SENASA: this file is scanned by the state-endorsement
    // fence (a shared layout file may not name a state body).
    const progSection = GOB_NAV_SECTIONS.find((s) => s.label === "Programa");
    const entry = progSection?.items.find((i) => i.href === "/gob/analytics/export");
    expect(entry).toBeDefined();
    expect(entry?.label).toBe("Exportar padrón sanitario");
    expect(entry?.label).not.toContain("SENASA");
  });

  it("includes /gob/casos in the Bandeja operativa section (F6 — Casos absorbs Disputas as an expediente)", () => {
    const bandejaSection = GOB_NAV_SECTIONS.find((s) => s.label === "Bandeja operativa");
    const hrefs = bandejaSection?.items.map((i) => i.href) ?? [];
    expect(hrefs).toContain("/gob/casos");
    const casos = bandejaSection?.items.find((i) => i.href === "/gob/casos");
    expect(casos?.label).toBe("Casos");
  });

  it("includes /gob/programa in the Programa section, not the unlabeled top (C6a — top holds only the Briefing)", () => {
    const unlabeled = GOB_NAV_SECTIONS.find((s) => s.label === "");
    expect(unlabeled?.items.map((i) => i.href)).toEqual(["/gob"]);
    const progSection = GOB_NAV_SECTIONS.find((s) => s.label === "Programa");
    expect(progSection?.items.map((i) => i.href)).toContain("/gob/programa");
  });

  it("does NOT include /gob/sistema anywhere (folded into /gob/programa)", () => {
    const allHrefs = GOB_NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href));
    expect(allHrefs).not.toContain("/gob/sistema");
  });

  it("includes /gob/outbox in the Bandeja operativa section (gov-vis, C6a)", () => {
    const bandejaSection = GOB_NAV_SECTIONS.find((s) => s.label === "Bandeja operativa");
    expect(bandejaSection?.items.map((i) => i.href)).toContain("/gob/outbox");
  });

  it("Intervención holds only Operativos + Decomisos (F2+F3+F7 fusions absorbed outreach/campañas and RUPGA elsewhere)", () => {
    const intervSection = GOB_NAV_SECTIONS.find((s) => s.label === "Intervención");
    const hrefs = intervSection?.items.map((i) => i.href) ?? [];
    expect(hrefs).toContain("/gob/operativos");
    expect(hrefs).toContain("/gob/decomisos");
    expect(hrefs).not.toContain("/gob/rupga");
    expect(hrefs).not.toContain("/gob/outreach");
    expect(hrefs).not.toContain("/gob/campanas");
  });

  it("includes /gob/operativos in the Intervención section (F2 fusion — Campañas + Alcance comunitario tabbed hub)", () => {
    const intervSection = GOB_NAV_SECTIONS.find((s) => s.label === "Intervención");
    const hrefs = intervSection?.items.map((i) => i.href) ?? [];
    const operativos = intervSection?.items.find((i) => i.href === "/gob/operativos");
    expect(hrefs).toContain("/gob/operativos");
    expect(operativos?.label).toBe("Operativos");
  });

  it("includes /gob/directorio in the Profundidad section (F3+F7 fusion — Organizaciones/Usuarios/Servicios/RUPGA tabbed hub)", () => {
    const profSection = GOB_NAV_SECTIONS.find((s) => s.label === "Profundidad");
    const hrefs = profSection?.items.map((i) => i.href) ?? [];
    const directorio = profSection?.items.find((i) => i.href === "/gob/directorio");
    expect(hrefs).toContain("/gob/directorio");
    expect(directorio?.label).toBe("Directorio");
    expect(hrefs).not.toContain("/gob/organizaciones");
    expect(hrefs).not.toContain("/gob/usuarios");
    expect(hrefs).not.toContain("/gob/servicios");
  });

  it("no href is duplicated across sections", () => {
    const sectionHrefs = GOB_NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href));
    const unique = new Set(sectionHrefs);
    expect(sectionHrefs.length).toBe(unique.size);
  });

  it("first section is unlabeled (the Briefing)", () => {
    expect(GOB_NAV_SECTIONS[0].label).toBe("");
    expect(GOB_NAV_SECTIONS[0].items[0].href).toBe("/gob");
  });

  // PO decision 2026-08-01. The rail offered "Panel" and "Panorama" — two
  // general-overview nouns, no way to tell which one a funcionario wants. The
  // top entry is now named after the layer the screen has belonged to since
  // C6b (`briefing`, lib/ui/screen-manifest.ts). Asserted together with the
  // Panorama label because the DEFECT was the pair, not either word alone: a
  // test that only pinned "Briefing" would stay green if Panorama were renamed
  // back into a synonym.
  it("names the top entry 'Briefing', distinct from the 'Panorama' entry below it", () => {
    expect(GOB_NAV_SECTIONS[0].items[0].label).toBe("Briefing");
    const situacion = GOB_NAV_SECTIONS.find((s) => s.label === "Situación");
    expect(situacion?.items.find((i) => i.href.startsWith("/gob/panorama"))?.label).toBe(
      "Panorama",
    );
  });

  // T1.5 (2026-08-01): a bare /gob/panorama href let the console's saved-board
  // restore silently rewrite what the menu entry opens (localStorage board over
  // the canonical default, URL rewritten in place). The nav href now names the
  // canonical default vista EXPLICITLY, hitting the mount effect's explicit-
  // params early return — a menu click always lands on the same screen.
  it("Panorama href pins the canonical default vista (menu clicks are never board-restored)", () => {
    const situacion = GOB_NAV_SECTIONS.find((s) => s.label === "Situación");
    const panorama = situacion?.items.find((i) => i.label === "Panorama");
    expect(panorama?.href).toBe("/gob/panorama?preset=sintomas&period=30d");
    // Highlighting still keys on the pathname prefix, not the query.
    expect(panorama?.matchPrefix).toBe("/gob/panorama");
  });

  it("keeps /gob's href and matchPrefix untouched by the label rename", () => {
    const top = GOB_NAV_SECTIONS[0].items[0];
    expect(top.href).toBe("/gob");
    // The top entry never had a matchPrefix (exact-match on "/gob"); the
    // rename must not have introduced one.
    expect(top.matchPrefix).toBeUndefined();
  });

  it("sections follow the C6a layer order: Situación → Programa → Intervención → Bandeja operativa → Profundidad", () => {
    const labels = GOB_NAV_SECTIONS.map((s) => s.label);
    expect(labels).toEqual([
      "",
      "Situación",
      "Programa",
      "Intervención",
      "Bandeja operativa",
      "Profundidad",
    ]);
  });
});

describe("GOB_NAV_FLAT — derived flat list", () => {
  it("exports GOB_NAV_FLAT equal to GOB_NAV_SECTIONS.flatMap(s => s.items)", () => {
    const derived = GOB_NAV_SECTIONS.flatMap((s) => s.items);
    expect(GOB_NAV_FLAT).toEqual(derived);
  });

  it("GOB_NAV_FLAT preserves every href from GOB_NAV", () => {
    const flatHrefs = new Set(GOB_NAV_FLAT.map((i) => i.href));
    for (const href of GOB_HREF_SNAPSHOT) {
      expect(flatHrefs).toContain(href);
    }
  });
});

// ---------------------------------------------------------------------------
// ADMIN_NAV_SECTIONS — grouped nav invariants (Item 1 PR1)
// ---------------------------------------------------------------------------

/**
 * Frozen href snapshot derived from the pre-refactor flat ADMIN_NAV on develop.
 * Hard-coded so a dropped href shrinks the sections union but NOT this set,
 * making the test genuinely catch membership regressions.
 */
const ADMIN_HREF_SNAPSHOT = new Set([
  "/admin",
  // Centro de Situación Nacional — flagship console. T1.5 (2026-08-01): the
  // nav href pins the canonical default vista (?preset&period) — see the gob
  // snapshot comment above.
  "/admin/panorama?preset=bienestar&period=90d",
  // portal-follows-viewer (2026-07-02) — Cola exists under both /admin and
  // /gob; admin nav points at the /admin/* copy.
  "/admin/cola",
  // F3+F7 fusion (2026-07-22): Usuarios/Organizaciones/Servicios collapse
  // into ONE /admin/directorio hub entry (the admin-scoped mirror of the gob
  // Directorio hub) — replaces the former separate /admin/usuarios,
  // /admin/organizaciones, /admin/servicios entries.
  "/admin/directorio",
  // /admin/historial REMOVED from nav (audit-trail fusion, 2026-08-02):
  // absorbed into the Auditoría hub as the "Actividad" vista
  // (?vista=sensibles|actividad). The route still exists as a permanent
  // redirect, but it has no nav entry. /gob/historial (jurisdiction-scoped)
  // is NOT part of the fusion and keeps its entry in the gob snapshot.
  "/admin/auditoria",
  "/admin/outbox",
  "/admin/sistema",
  // /admin/govts and /admin/admins REMOVED from nav (privileged-accounts
  // fusion, 2026-08-02): absorbed into the Cuentas privilegiadas hub as
  // tabbed registers (?registro=govts|admins). Both routes still exist as
  // permanent redirects; their [userId]/new detail routes are unchanged.
  "/admin/cuentas",
  // admin-rules-console — Reglas exists under both portals; admin nav points
  // at the /admin/* copy.
  "/admin/reglas",
  "/admin/observaciones",
  "/admin/moderacion",
  "/admin/casos",
  "/admin/alertas", // WS-K — bandeja de alertas + triage
  "/admin/suscripciones", // promoted out of /admin/programa's alert sub-panel (2026-07-21)
  // F8 fusion (2026-07-22): /admin/censo + /admin/poblacion collapse into ONE
  // /admin/padron hub entry (own admin hub page, tabbed ?vista=poblacion|censo).
  "/admin/padron",
  "/admin/adopciones", // Paquete F — pipeline de custodia & adopción
  "/admin/programa", // Paquete H — resumen ejecutivo del programa
  "/admin/libro", // WS-L — Libro de eventos (event-sourcing visible)
  "/admin/inteligencia", // Task #44 — inteligencia operativa territorial
  // ADDED 2026-08-20. /admin/chapas is the ONLY screen that issues physical
  // tags, and it had no entry anywhere in the product: reachable exclusively by
  // typing the URL. It is the origin of the chapa circuit /t/[serial] and
  // /cuenta/chapas/activar depend on, and it emits the single artifact that ever
  // carries the plaintext activation codes. Section comes from
  // screen-manifest.ts (layer "programa"), not from taste.
  // Mirrored in lib/ui/shell-nav-phase-b.test.ts's copy of this set.
  "/admin/chapas",
]);

describe("ADMIN_NAV_SECTIONS — section invariants", () => {
  it("exports ADMIN_NAV_SECTIONS as a non-empty array", () => {
    expect(Array.isArray(ADMIN_NAV_SECTIONS)).toBe(true);
    expect(ADMIN_NAV_SECTIONS.length).toBeGreaterThan(0);
  });

  it("no href is lost: every frozen-snapshot href appears in ADMIN_NAV_SECTIONS (snapshot ⊆ union)", () => {
    const sectionHrefs = new Set(ADMIN_NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href)));
    for (const href of ADMIN_HREF_SNAPSHOT) {
      expect(sectionHrefs).toContain(href);
    }
  });

  it("no href is gained: ADMIN_NAV_SECTIONS contains only hrefs from the frozen snapshot (union ⊆ snapshot)", () => {
    // Deferred sentinels (#defer-…) are presentation affordances, not routes —
    // exclude them from the live-route invariant (D6).
    const sectionHrefs = ADMIN_NAV_SECTIONS.flatMap((s) =>
      s.items.filter((i) => !i.deferred).map((i) => i.href),
    );
    for (const href of sectionHrefs) {
      expect(ADMIN_HREF_SNAPSHOT).toContain(href);
    }
  });

  it("no href is duplicated across sections", () => {
    const sectionHrefs = ADMIN_NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href));
    const unique = new Set(sectionHrefs);
    expect(sectionHrefs.length).toBe(unique.size);
  });

  it("first section is unlabeled (Dashboard) with href /admin", () => {
    expect(ADMIN_NAV_SECTIONS[0].label).toBe("");
    expect(ADMIN_NAV_SECTIONS[0].items[0].href).toBe("/admin");
  });

  // C6a (2026-07-22) — Analítica/Operaciones/Confiabilidad/Identidad y
  // acceso/Gobernanza were regrouped into the 5-layer model, mirroring
  // GOB_NAV_SECTIONS where the same screens exist. These tests now encode
  // the NEW grouping (superseding the C26/C27 taxonomy split below).

  it("includes /admin/padron and /admin/programa in the Programa section (F8 — Padrón absorbs Población + Censo)", () => {
    const progSection = ADMIN_NAV_SECTIONS.find((s) => s.label === "Programa");
    const hrefs = progSection?.items.map((i) => i.href) ?? [];
    expect(hrefs).toContain("/admin/padron");
    expect(hrefs).toContain("/admin/programa");
    const padron = progSection?.items.find((i) => i.href === "/admin/padron");
    expect(padron?.label).toBe("Padrón");
    // Programa leads the layer (highest-level view first).
    expect(progSection?.items[0]?.href).toBe("/admin/programa");
  });

  it("does NOT include /admin/poblacion or /admin/censo anywhere (F8 fusion — absorbed into the Padrón hub)", () => {
    const allHrefs = ADMIN_NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href));
    expect(allHrefs).not.toContain("/admin/poblacion");
    expect(allHrefs).not.toContain("/admin/censo");
  });

  it("Situación is the first labeled section (C6a — Panorama leads, mirrors gob)", () => {
    // index 0 is the unlabeled Briefing-only top; the first NAMED group is
    // where the eye lands next.
    const firstLabeled = ADMIN_NAV_SECTIONS.find((s) => s.label !== "");
    expect(firstLabeled?.label).toBe("Situación");
  });

  // Admin twin of the gob assertion — same PO decision, same synonym pair
  // (/admin ships its own Panorama entry one section below).
  it("names the top entry 'Briefing', distinct from the 'Panorama' entry below it", () => {
    expect(ADMIN_NAV_SECTIONS[0].items[0].label).toBe("Briefing");
    const situacion = ADMIN_NAV_SECTIONS.find((s) => s.label === "Situación");
    expect(situacion?.items.find((i) => i.href.startsWith("/admin/panorama"))?.label).toBe(
      "Panorama",
    );
  });

  // T1.5 — admin twin of the gob assertion: the menu entry names the canonical
  // default vista explicitly so the saved-board restore can never hijack it.
  it("Panorama href pins the canonical default vista (menu clicks are never board-restored)", () => {
    const situacion = ADMIN_NAV_SECTIONS.find((s) => s.label === "Situación");
    const panorama = situacion?.items.find((i) => i.label === "Panorama");
    expect(panorama?.href).toBe("/admin/panorama?preset=bienestar&period=90d");
    expect(panorama?.matchPrefix).toBe("/admin/panorama");
  });

  it("keeps /admin's href and matchPrefix untouched by the label rename", () => {
    const top = ADMIN_NAV_SECTIONS[0].items[0];
    expect(top.href).toBe("/admin");
    expect(top.matchPrefix).toBeUndefined();
  });

  it("Situación holds Panorama + Observaciones (C6a — epidemiological surveillance judgment)", () => {
    const situSection = ADMIN_NAV_SECTIONS.find((s) => s.label === "Situación");
    expect(situSection?.items.map((i) => i.href)).toEqual([
      "/admin/panorama?preset=bienestar&period=90d",
      "/admin/observaciones",
    ]);
  });

  it("includes /admin/alertas and /admin/moderacion in the Bandeja operativa section (C6a)", () => {
    const bandejaSection = ADMIN_NAV_SECTIONS.find((s) => s.label === "Bandeja operativa");
    const hrefs = bandejaSection?.items.map((i) => i.href) ?? [];
    expect(hrefs).toContain("/admin/alertas");
    expect(hrefs).toContain("/admin/moderacion");
    expect(hrefs).toContain("/admin/casos");
    expect(hrefs).toContain("/admin/outbox");
    const alertas = bandejaSection?.items.find((i) => i.href === "/admin/alertas");
    expect(alertas?.label).toBe("Alertas");
    expect(alertas?.matchPrefix).toBe("/admin/alertas");
    // No analytics/program routes leaked into the queue layer.
    expect(hrefs).not.toContain("/admin/programa");
    expect(hrefs).not.toContain("/admin/poblacion");
  });

  // T4.9 (2026-08-01): /admin/moderacion permanently redirects into gob chrome
  // (see the comment on this nav item) — an unadorned "Moderación" label reads
  // as an in-portal link, so the operator gets no warning before the chrome
  // jumps out from under them. Match DetailDrawer's "abre en portal Gobierno ↗"
  // convention instead of building an in-portal stub.
  it("labels the Moderación entry as a cross-portal jump, matching the DrillLink convention (T4.9)", () => {
    const bandejaSection = ADMIN_NAV_SECTIONS.find((s) => s.label === "Bandeja operativa");
    const moderacion = bandejaSection?.items.find((i) => i.href === "/admin/moderacion");
    expect(moderacion?.label).toBe("Moderación ↗ Gobierno");
    // The href/matchPrefix stay put — the [id] detail routes still live under
    // /admin/moderacion/ and depend on this prefix for rail highlighting.
    expect(moderacion?.matchPrefix).toBe("/admin/moderacion");
  });

  it("includes /admin/libro and /admin/inteligencia in the Profundidad section (C6a)", () => {
    const profSection = ADMIN_NAV_SECTIONS.find((s) => s.label === "Profundidad");
    const hrefs = profSection?.items.map((i) => i.href) ?? [];
    expect(hrefs).toContain("/admin/libro");
    expect(hrefs).toContain("/admin/inteligencia");
    expect(hrefs).toContain("/admin/sistema");
    expect(hrefs).toContain("/admin/auditoria");
    const libro = profSection?.items.find((i) => i.href === "/admin/libro");
    expect(libro?.label).toBe("Libro de eventos");
    expect(libro?.matchPrefix).toBe("/admin/libro");
  });

  it("admin has no Intervención layer (no outreach/decomisos/rupga routes)", () => {
    const labels = ADMIN_NAV_SECTIONS.map((s) => s.label);
    expect(labels).not.toContain("Intervención");
  });

  it("sections follow the C6a layer order: Situación → Programa → Bandeja operativa → Profundidad", () => {
    const labels = ADMIN_NAV_SECTIONS.map((s) => s.label);
    expect(labels).toEqual(["", "Situación", "Programa", "Bandeja operativa", "Profundidad"]);
  });

  it("C6a regroup is href-preserving: section union equals the frozen snapshot exactly", () => {
    // The split MUST NOT lose or gain any LIVE href — only regroup. The union of
    // all live section hrefs must equal ADMIN_HREF_SNAPSHOT as a set (both
    // directions). Deferred sentinels (#defer-…) are excluded — not routes (D6).
    const union = new Set(
      ADMIN_NAV_SECTIONS.flatMap((s) => s.items.filter((i) => !i.deferred).map((i) => i.href)),
    );
    expect(union).toEqual(ADMIN_HREF_SNAPSHOT);
  });

  // portal-follows-viewer (2026-07-02) — no admin nav href may point at
  // /gob/*. The shared work surfaces (cola, reglas, and — since F3+F7 —
  // directorio) now have a real /admin/* copy (thin wrapper re-exporting the
  // /gob page; chrome from the admin layout), so an admin nav href landing
  // on /gob/* would silently eject the viewer into gob chrome — exactly what
  // portal-follows-viewer exists to prevent.
  it("no ADMIN_NAV_SECTIONS href points at /gob/* (portal-follows-viewer)", () => {
    const hrefs = ADMIN_NAV_SECTIONS.flatMap((s) =>
      s.items.filter((i) => !i.deferred).map((i) => i.href),
    );
    for (const href of hrefs) {
      expect(href.startsWith("/gob/")).toBe(false);
    }
    // And the live /admin/* targets ARE present (the repoint actually happened).
    expect(hrefs).toContain("/admin/cola");
    expect(hrefs).toContain("/admin/reglas");
    // F3+F7 fusion (2026-07-22): the former separate usuarios/organizaciones/
    // servicios entries collapsed into ONE /admin/directorio hub entry.
    expect(hrefs).toContain("/admin/directorio");
    expect(hrefs).not.toContain("/admin/usuarios");
    expect(hrefs).not.toContain("/admin/organizaciones");
    expect(hrefs).not.toContain("/admin/servicios");
  });

  // The old AC3-era /admin/{cola,usuarios,organizaciones} → /gob/* redirects
  // are GONE (portal-follows-viewer serves real pages at those paths now).
  // Only the renamed /admin/jurisdicciones bookmark still remaps, to
  // /admin/reglas — verify the admin nav doesn't link to that dead alias.
  it("no ADMIN_NAV_SECTIONS href points at the legacy /admin/jurisdicciones alias", () => {
    const hrefs = ADMIN_NAV_SECTIONS.flatMap((s) =>
      s.items.filter((i) => !i.deferred).map((i) => i.href),
    );
    for (const href of hrefs) {
      expect(href.startsWith("/admin/jurisdicciones")).toBe(false);
    }
  });
});

describe("ADMIN_NAV_FLAT — derived flat list", () => {
  it("exports ADMIN_NAV_FLAT equal to ADMIN_NAV_SECTIONS.flatMap(s => s.items)", () => {
    const derived = ADMIN_NAV_SECTIONS.flatMap((s) => s.items);
    expect(ADMIN_NAV_FLAT).toEqual(derived);
  });

  it("ADMIN_NAV_FLAT preserves every href from ADMIN_NAV", () => {
    const flatHrefs = new Set(ADMIN_NAV_FLAT.map((i) => i.href));
    for (const href of ADMIN_HREF_SNAPSHOT) {
      expect(flatHrefs).toContain(href);
    }
  });
});

// ---------------------------------------------------------------------------
// buildOrgNav — grouped NavSection[] invariants (Item 1 PR2)
// ---------------------------------------------------------------------------

/**
 * Frozen href snapshot: the FULL set of org hrefs with ALL capabilities granted.
 * Hard-coded so a dropped href shrinks the sections union but NOT this set —
 * the invariant test genuinely catches membership regressions (non-tautological).
 * 18 hrefs total (13 ungated + 5 gated).
 */
const ORG_HREF_SNAPSHOT = new Set([
  "/org/ORG-ABC",
  "/org/ORG-ABC/agenda",
  "/org/ORG-ABC/atender",
  "/org/ORG-ABC/intake",
  "/org/ORG-ABC/transitos",
  "/org/ORG-ABC/voluntarios",
  // Sumado 2026-08-04: bandeja de mensajes públicos — cierra el pozo ciego de
  // org_contact_messages (tabla con escritor y sin lector).
  "/org/ORG-ABC/mensajes",
  "/org/ORG-ABC/mascotas",
  "/org/ORG-ABC/transferencias",
  "/org/ORG-ABC/adopciones",
  "/org/ORG-ABC/checkins",
  "/org/ORG-ABC/casos",
  "/org/ORG-ABC/maltrato/recibidos",
  "/org/ORG-ABC/mordedura/nuevo",
  "/org/ORG-ABC/servicios",
  "/org/ORG-ABC/miembros",
  "/org/ORG-ABC/cobertura",
  "/org/ORG-ABC/admin/permisos",
  "/org/ORG-ABC/configuracion",
  "/org/ORG-ABC/censo",
]);

describe("buildOrgNav — section invariants", () => {
  it("no href is lost: every frozen-snapshot href appears in sections (snapshot ⊆ union)", () => {
    const sections = buildOrgNav("ORG-ABC", FULL_NAV);
    const sectionHrefs = new Set(sections.flatMap((s) => s.items.map((i) => i.href)));
    for (const href of ORG_HREF_SNAPSHOT) {
      expect(sectionHrefs).toContain(href);
    }
  });

  it("no href is gained: sections contain only hrefs from the frozen snapshot (union ⊆ snapshot)", () => {
    const sections = buildOrgNav("ORG-ABC", FULL_NAV);
    const sectionHrefs = sections.flatMap((s) => s.items.map((i) => i.href));
    for (const href of sectionHrefs) {
      expect(ORG_HREF_SNAPSHOT).toContain(href);
    }
  });

  it("no href is duplicated across sections", () => {
    const sections = buildOrgNav("ORG-ABC", FULL_NAV);
    const sectionHrefs = sections.flatMap((s) => s.items.map((i) => i.href));
    const unique = new Set(sectionHrefs);
    expect(sectionHrefs.length).toBe(unique.size);
  });

  it("with no capabilities, gated items (Agenda, Ingresos, Check-ins, Permisos) are absent from all sections", () => {
    const sections = buildOrgNav("ORG-ABC", { granted: new Set() });
    const allItems = sections.flatMap((s) => s.items);
    const labels = allItems.map((i) => i.label);
    expect(labels).not.toContain("Agenda");
    expect(labels).not.toContain("Ingresos");
    expect(labels).not.toContain("Check-ins");
    expect(labels).not.toContain("Permisos");
  });

  it("with no capabilities, sections that become empty are dropped", () => {
    const sections = buildOrgNav("ORG-ABC", { granted: new Set() });
    for (const section of sections) {
      expect(section.items.length).toBeGreaterThan(0);
    }
  });

  it("with full grants, exactly 7 sections are present and in order (nav diet)", () => {
    const sections = buildOrgNav("ORG-ABC", FULL_NAV);
    expect(sections.map((s) => s.label)).toEqual([
      "",
      "Ingresos",
      "Custodia",
      "Postulaciones",
      "Casos",
      "Equipo",
      "Administración",
    ]);
  });

  it("buildOrgNavFlat equals sections.flatMap(s => s.items) for full grants", () => {
    const sections = buildOrgNav("ORG-ABC", FULL_NAV);
    const flat = buildOrgNavFlat("ORG-ABC", FULL_NAV);
    expect(flat).toEqual(sections.flatMap((s) => s.items));
  });
});

// ---------------------------------------------------------------------------
// Org nav diet (2026-07-24, PO-approved) — 5 primary jobs + collapsible
// Administración. Pure regrouping: routes, labels, capability gates and the
// shelterOnly filter are untouched (fenced by the snapshot tests above).
// ---------------------------------------------------------------------------

describe("buildOrgNav — nav diet (primary jobs + collapsible Administración)", () => {
  const SHELTER = { ...FULL_NAV, orgType: "shelter" } as const;
  const CLINIC = { ...FULL_NAV, orgType: "clinic" } as const;

  function section(sections: ReturnType<typeof buildOrgNav>, label: string) {
    return sections.find((s) => s.label === label);
  }

  it("shelter: the 5 primary job buckets hold the expected items", () => {
    const sections = buildOrgNav("ORG-ABC", SHELTER);
    expect(section(sections, "Ingresos")?.items.map((i) => i.label)).toEqual(["Ingresos", "Censo"]);
    expect(section(sections, "Custodia")?.items.map((i) => i.label)).toEqual([
      "Mascotas",
      "Tránsitos",
    ]);
    expect(section(sections, "Postulaciones")?.items.map((i) => i.label)).toEqual([
      "Postulaciones",
      "Check-ins",
    ]);
    expect(section(sections, "Casos")?.items.map((i) => i.label)).toEqual([
      "Casos",
      "Maltrato",
      "Mordeduras",
    ]);
    expect(section(sections, "Equipo")?.items.map((i) => i.label)).toEqual([
      "Miembros",
      "Voluntarios",
      // Sumado 2026-08-04 — la bandeja de mensajes públicos.
      "Mensajes",
      "Permisos",
    ]);
  });

  it("shelter: Administración holds the managerial rest (Agenda, Transferencias, Servicios, Cobertura, Configuración)", () => {
    const sections = buildOrgNav("ORG-ABC", SHELTER);
    expect(section(sections, "Administración")?.items.map((i) => i.label)).toEqual([
      "Agenda",
      "Atender",
      "Transferencias",
      "Servicios",
      "Cobertura",
      "Configuración",
    ]);
  });

  it("only Administración is collapsible; every primary section stays expanded", () => {
    const sections = buildOrgNav("ORG-ABC", SHELTER);
    for (const s of sections) {
      if (s.label === "Administración") {
        expect(s.collapsible).toBe(true);
      } else {
        expect(s.collapsible).toBeUndefined();
      }
    }
  });

  it("clinic: Agenda surfaces in the unlabeled top next to Panel, not buried under Administración", () => {
    const sections = buildOrgNav("ORG-ABC", CLINIC);
    expect(section(sections, "")?.items.map((i) => i.label)).toEqual([
      "Panel",
      "Agenda",
      "Atender",
    ]);
    expect(section(sections, "Administración")?.items.map((i) => i.label)).not.toContain("Agenda");
  });

  it("clinic: gets a proportional structure — shelter-only buckets drop, Administración stays collapsible", () => {
    const sections = buildOrgNav("ORG-ABC", CLINIC);
    // Postulaciones bucket empties (adopciones + checkins are shelterOnly) and drops.
    expect(section(sections, "Postulaciones")).toBeUndefined();
    // Ingresos bucket also drops for a clinic: both its items (Ingresos intake,
    // Censo) are shelterOnly (red-team 2026-07-24 #4). Atender + Agenda surface
    // in the unlabeled top for clinics instead.
    expect(section(sections, "Ingresos")).toBeUndefined();
    expect(sections.map((s) => s.label)).toEqual([
      "",
      "Custodia",
      "Casos",
      "Equipo",
      "Administración",
    ]);
    expect(section(sections, "")?.items.map((i) => i.label)).toContain("Atender");
    const admin = section(sections, "Administración");
    expect(admin?.collapsible).toBe(true);
    expect(admin?.items.map((i) => i.label)).toEqual([
      "Transferencias",
      "Servicios",
      "Cobertura",
      "Configuración",
    ]);
  });

  it("zero-capability member: only the unlabeled Panel section remains — no empty Administración group", () => {
    const sections = buildOrgNav("ORG-ABC");
    expect(sections.map((s) => s.label)).toEqual([""]);
    expect(sections[0].collapsible).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// C3 (adversarial-gob 2026-07-23) — label honesty fix: /gob/historial
// "Mi actividad" → "Historial". The page defaults to ALL operators' activity
// in the viewer's jurisdiction (the "solo mía" toggle is OFF by default), so
// "Mi actividad" promised a scope the screen doesn't deliver by default.
// Route is unchanged (href preserved); only the surface label is updated.
// ---------------------------------------------------------------------------

describe("C3 — gob /historial label honesty fix", () => {
  it("/gob/historial href is preserved in GOB_NAV (no route loss)", () => {
    const hrefs = GOB_NAV.map((i) => i.href);
    expect(hrefs).toContain("/gob/historial");
  });

  it('/gob/historial item label is "Historial" (not "Mi actividad")', () => {
    const allItems = GOB_NAV_SECTIONS.flatMap((s) => s.items);
    const item = allItems.find((i) => i.href === "/gob/historial");
    expect(item).toBeDefined();
    expect(item?.label).toBe("Historial");
    expect(item?.label).not.toBe("Mi actividad");
  });

  // Audit-trail fusion (2026-08-02): the admin twin no longer has a nav entry
  // — it was absorbed into the Auditoría hub as the "Actividad" vista, and
  // the route survives only as a permanent redirect. The GOB entry above is
  // deliberately untouched (jurisdiction-scoped, not part of the fusion).
  it("/admin/historial has NO nav entry anymore (absorbed into the Auditoría hub)", () => {
    const allAdminItems = ADMIN_NAV_SECTIONS.flatMap((s) => s.items);
    expect(allAdminItems.find((i) => i.href === "/admin/historial")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Panel → Briefing (PO decision 2026-08-01): the nav label, the breadcrumb root
// and the portal home's h1 all name the SAME destination, so they have to move
// together. The crumb side is fenced in __tests__/operator-breadcrumbs.test.ts;
// the /gob h1 is fenced by a render test in app/gob/page.test.tsx.
//
// The /admin h1 had NO unit coverage at all — only e2e/owner-ia-p6.spec.ts,
// which does not run in `pnpm vitest`. A mutation flipping it back to "Panel de
// administración" survived the entire vitest suite. app/admin/page.tsx pulls the
// full admin-metrics fetcher set, so rendering it here would cost more mocking
// than the assertion is worth; a source scan buys the same regression fence for
// two lines. It is deliberately narrow — it reads the `title=` prop, not layout.
// ---------------------------------------------------------------------------

describe("portal home h1 agrees with its nav label", () => {
  const REPO_ROOT = path.resolve(__dirname, "..", "..");
  const readPage = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

  it("/admin renders an h1 titled 'Briefing de administración', not 'Panel de …'", () => {
    const src = readPage("app/admin/page.tsx");
    expect(src).toContain('title="Briefing de administración"');
    expect(src).not.toContain('title="Panel de administración"');
  });

  it("/gob renders an h1 titled 'Briefing de jurisdicción', not 'Panel de …'", () => {
    const src = readPage("app/gob/page.tsx");
    expect(src).toContain('title="Briefing de jurisdicción"');
    expect(src).not.toContain('title="Panel de jurisdicción"');
  });
});
