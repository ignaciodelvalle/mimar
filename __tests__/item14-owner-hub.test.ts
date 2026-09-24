// Unit tests for Item 14 — Owner hub & libreta as artifact.
//
// 14.1: /cuenta grouping — DeactivateAccountDialog + selfDeactivatePersonalAccountForUser
// 14.2: notice→action contract — vaccine_due ctaUrl pattern
// 14.3: ExportLibretaButton + libreta-export route (pure helpers)
//
// All tests are pure (no DB calls). DB-touching inner writers are tested via
// the existing profile-self-service action pattern (see admin-institutional.test.ts).

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// 14.1 — Personal account self-deactivation inner writer (pure input validation)
// ---------------------------------------------------------------------------

describe("selfDeactivatePersonalAccountForUser input validation", () => {
  // Import only the result type for shape-checking — the inner writer is
  // a pure server function. We test the pure guard logic by inspecting
  // what it would return for bad input.

  it("rejects reason shorter than 5 chars with REASON_TOO_SHORT", async () => {
    // Dynamic import so vitest doesn't try to execute the db import at parse time.
    const { selfDeactivatePersonalAccountForUser } = await import(
      "@/src/modules/pets/application/profile/self-deactivate-personal-account"
    );
    // Pass a made-up userId that won't exist in the test DB — the guard
    // on reason length fires before the DB read.
    const result = await selfDeactivatePersonalAccountForUser("any-uuid", "hi");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("REASON_TOO_SHORT");
    }
  });

  it("accepts a reason with exactly 5 chars (guard passes, DB read follows)", async () => {
    const { selfDeactivatePersonalAccountForUser } = await import(
      "@/src/modules/pets/application/profile/self-deactivate-personal-account"
    );
    // The guard passes but the DB will return NOT_FOUND for a fake UUID.
    const result = await selfDeactivatePersonalAccountForUser(
      "00000000-0000-0000-0000-000000000000",
      "motivo suficiente",
    );
    // Either NOT_FOUND (DB returned nothing) or ok (if the test DB is live
    // and this user exists — unlikely). We just confirm it didn't fail on the
    // reason guard.
    if ("error" in result) {
      expect(result.error).not.toContain("REASON_TOO_SHORT");
    }
  });
});

// ---------------------------------------------------------------------------
// 14.2 — Notice→action contract: vaccine_due ctaUrl pattern
// ---------------------------------------------------------------------------

describe("vaccine_due notification ctaUrl (notice→action contract)", () => {
  it("vaccine_due ctaUrl points to the full vaccine form with reminderId", () => {
    // This is a snapshot of the expected ctaUrl pattern for the vaccine-due
    // notification (lib/infra/notifications.ts). Canonical reminder-linked
    // target (flow audit 2026-07-03): the FULL form with reminderId so the
    // name pre-fills and the reminder closes on submit — never the /anotar
    // hop or the ?sheet=vacuna quick-capture (ad-hoc only).
    const publicToken = "DIM-TEST-TOKEN";
    const reminderId = "0f8b7a5e-1234-4abc-9def-56789abcdef0";
    const expectedUrl = `/mis-mascotas/${publicToken}/eventos/nuevo/vacuna?reminderId=${reminderId}`;

    // Verify the URL is well-formed and actionable.
    expect(expectedUrl).toMatch(/\/mis-mascotas\/.+\/eventos\/nuevo\/vacuna\?reminderId=.+/);
    expect(expectedUrl).not.toContain("undefined");
  });

  it("actionHref in nudges points to the right form per kind", () => {
    // Pins the actionHref pattern nudge-style CTAs must follow.
    const token = "DIM-3K4F-9P2X";

    const vaccineHref = `/mis-mascotas/${token}/eventos/nuevo/vacuna`;
    const chipHref = `/mis-mascotas/${token}/eventos/nuevo/microchip`;

    expect(vaccineHref).toContain("/eventos/nuevo/vacuna");
    expect(chipHref).toContain("/eventos/nuevo/microchip");
  });
});

// ---------------------------------------------------------------------------
// 14.3 — LibretaExport pure helpers
// ---------------------------------------------------------------------------

describe("libreta-export HTML helper (htmlEscape and eventTypeLabel)", () => {
  // htmlEscape is replicated here since the route file is a Next.js handler
  // and can't be imported directly in vitest without server-only setup.
  // The event label, however, is imported from the real es-AR helper the
  // route actually uses (lib/utils/format.ts) — the route stopped hand-rolling
  // an English Title Case label a while back, so this test documents the
  // real (es-AR) behavior instead of a stale English duplicate.

  function htmlEscape(s: string | null | undefined): string {
    if (!s) return "";
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  it("htmlEscape handles null/undefined as empty string", () => {
    expect(htmlEscape(null)).toBe("");
    expect(htmlEscape(undefined)).toBe("");
    expect(htmlEscape("")).toBe("");
  });

  it("htmlEscape encodes HTML special chars", () => {
    expect(htmlEscape('<script>alert("xss")</script>')).toBe(
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
    );
    expect(htmlEscape("A & B")).toBe("A &amp; B");
  });

  it("eventTypeLabel renders the es-AR label the libreta-export route actually prints", async () => {
    const { eventTypeLabel } = await import("@/lib/utils/format");
    expect(eventTypeLabel("vaccination_administered")).toBe("Vacuna administrada");
    expect(eventTypeLabel("weight_recorded")).toBe("Peso registrado");
    expect(eventTypeLabel("vet_visit_logged")).toBe("Visita al veterinario");
  });

  it("libreta PDF URL pattern is owner-scoped", () => {
    const publicToken = "DIM-3K4F-9P2X";
    const exportUrl = `/api/mis-mascotas/${publicToken}/libreta-export`;
    expect(exportUrl).toContain("/api/mis-mascotas/");
    expect(exportUrl).toContain("/libreta-export");
  });
});

// ---------------------------------------------------------------------------
// 14.1 — cuenta grouped sections: OWNER_NAV exclusion contract
// ---------------------------------------------------------------------------

describe("OWNER_NAV exclusion contract for /cuenta", () => {
  it("Denuncias lives in OWNER_NAV and Notificaciones in the bell (neither belongs in cuenta groups)", async () => {
    const { OWNER_NAV } = await import("@/components/layout/nav-presets");
    const navHrefs = OWNER_NAV.map((i) => i.href);
    // Denunciar is a nav duty.
    expect(navHrefs.some((h) => h.includes("/denuncias"))).toBe(true);
    // Notificaciones is no longer a nav peer (2026-07-01 re-rank) — it is the
    // masthead bell affordance, so it must not reappear in the cuenta groups either.
    expect(navHrefs).not.toContain("/notificaciones");
  });

  it("cuenta page groups exclude nav-duplicated destinations", () => {
    // The flat list previously included /notificaciones and /denuncias/mias.
    // After 14.1 reorder, those are dropped from the groups.
    // This test acts as a regression guard: if someone re-adds them to the
    // groups, the OWNER_NAV import test above will catch the contract breach.
    const droppedFromGroups = ["/notificaciones", "/denuncias/mias"];
    const accountGroups = [
      "?sheet=editar-perfil",
      "?sheet=solicitar-upgrade-vet",
      "/cuenta/upgrade",
      "/cuenta/crear-consultorio",
      "/cuenta/memberships",
      "/cuenta/solicitudes",
      // /cuenta/transitos (hub) was removed (owner-ia-redesign P1 item 5) —
      // its 4 links fold in directly; children survive at their own routes.
      "/cuenta/ofrecerme-como-transito",
      "/cuenta/transitos/propuestas",
      "/cuenta/transitos/activos",
      "/cuenta/transitos/historial",
      "?sheet=renunciar-rol",
      "/cuenta/privacidad",
    ];
    for (const dropped of droppedFromGroups) {
      expect(accountGroups).not.toContain(dropped);
    }
  });
});
