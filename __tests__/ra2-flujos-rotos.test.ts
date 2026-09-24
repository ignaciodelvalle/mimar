/**
 * RA-2 — the flows that broke for a real user (F7, F8, F11, F12, F13).
 *
 * F6 has its own file (`ra2-f6-vecino-chip-escape-hatch.test.tsx`) because it
 * needs a DOM to walk the card → page → form → action path.
 *
 * Where a defect is a pure function (F11) or an observable call (F13), this
 * file tests the behaviour. Where it is "a control is rendered that must not
 * be" (F7) or "a stale route is not revalidated" (F12), it derives the
 * invariant from the filesystem rather than asserting a literal string, so the
 * fence keeps meaning something when the routes move.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = join(__dirname, "..");

/** A comment quoting the old code has fooled this wave repeatedly — strip them
 *  so a source-derived assertion can only match executable code. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
}

function source(rel: string): string {
  return stripComments(readFileSync(join(ROOT, rel), "utf8"));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// F11 — the analytics export exported the wrong period and audited it as right
// ---------------------------------------------------------------------------

describe("RA-2 F11 — export period vocabulary", () => {
  // These are the values <PeriodPicker> can actually emit on the export page.
  // The old parsePeriod recognised "7d" / "90d" / "1y" — "1y" is produced by
  // NOTHING — and silently defaulted "trailing12m" and "ytd" to 30 days, so the
  // audit_log row claimed a window the operator never asked for.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 6, 31, 12, 0, 0);

  function fd(entries: Record<string, string>): FormData {
    const f = new FormData();
    for (const [k, v] of Object.entries(entries)) f.set(k, v);
    return f;
  }

  it("resolves 'trailing12m' to 365 days, not 30", async () => {
    const { resolveExportPeriod } = await import("@/app/gob/analytics/export/export-period");
    vi.setSystemTime(NOW);
    const { since, until } = resolveExportPeriod(fd({ period: "trailing12m" }));
    const spanDays = Math.round((until.getTime() - since.getTime()) / DAY_MS);
    expect(spanDays).toBe(365);
    vi.useRealTimers();
  });

  it("resolves 'ytd' to Jan 1 of the current year, not 30 days", async () => {
    const { resolveExportPeriod } = await import("@/app/gob/analytics/export/export-period");
    vi.setSystemTime(NOW);
    const { since } = resolveExportPeriod(fd({ period: "ytd" }));
    expect(since.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    vi.useRealTimers();
  });

  it("keeps the presets the old branch set did handle", async () => {
    const { resolveExportPeriod } = await import("@/app/gob/analytics/export/export-period");
    vi.setSystemTime(NOW);
    for (const [preset, days] of [
      ["7d", 7],
      ["30d", 30],
      ["90d", 90],
    ] as const) {
      const { since, until } = resolveExportPeriod(fd({ period: preset }));
      expect(Math.round((until.getTime() - since.getTime()) / DAY_MS)).toBe(days);
    }
    vi.useRealTimers();
  });

  it("THROWS on an unrecognised value instead of quietly defaulting", async () => {
    const { resolveExportPeriod, UnknownExportPeriodError } = await import(
      "@/app/gob/analytics/export/export-period"
    );
    // "1y" is the dead value the old code recognised. Now that the vocabularies
    // are shared, a value outside them means they drifted again — and that must
    // be loud, because the resolved window is persisted into the audit row.
    expect(() => resolveExportPeriod(fd({ period: "1y" }))).toThrow(UnknownExportPeriodError);
    expect(() => resolveExportPeriod(fd({ period: "last-quarter" }))).toThrow(
      UnknownExportPeriodError,
    );
  });

  it("falls back to the shared default only when the period is absent", async () => {
    const { resolveExportPeriod, EXPORT_DEFAULT_PRESET } = await import(
      "@/app/gob/analytics/export/export-period"
    );
    vi.setSystemTime(NOW);
    const absent = resolveExportPeriod(fd({}));
    const explicit = resolveExportPeriod(fd({ period: EXPORT_DEFAULT_PRESET }));
    expect(absent.since.toISOString()).toBe(explicit.since.toISOString());
    vi.useRealTimers();
  });

  it("honours a custom from/to range", async () => {
    const { resolveExportPeriod } = await import("@/app/gob/analytics/export/export-period");
    const { since, until } = resolveExportPeriod(
      fd({ period: "custom", from: "2026-01-10", to: "2026-02-10" }),
    );
    expect(since.toISOString().slice(0, 10)).toBe("2026-01-10");
    expect(until.toISOString().slice(0, 10)).toBe("2026-02-10");
  });

  it("the runtime vocabulary is the same one the picker draws from", async () => {
    const { PERIOD_PRESET_IDS, isPeriodPresetId } = await import("@/lib/metrics/period-presets");
    // Every id the shared list contains must be resolvable — that equivalence
    // is the whole point of single-sourcing it.
    const { resolveExportPeriod } = await import("@/app/gob/analytics/export/export-period");
    for (const id of PERIOD_PRESET_IDS) {
      expect(isPeriodPresetId(id)).toBe(true);
      expect(() => resolveExportPeriod(fd({ period: id }))).not.toThrow();
    }
    expect(PERIOD_PRESET_IDS).toContain("trailing12m");
    expect(PERIOD_PRESET_IDS).toContain("ytd");
    expect(PERIOD_PRESET_IDS).not.toContain("1y");
  });

  it("the export surface no longer hard-codes its own default preset", () => {
    // Three independent "30d" literals is how the vocabularies drifted apart.
    const page = source("app/gob/analytics/export/page.tsx");
    const client = source("app/gob/analytics/export/ExportFormClient.tsx");
    expect(page).toContain("EXPORT_DEFAULT_PRESET");
    expect(client).toContain("EXPORT_DEFAULT_PRESET");
    expect(client).not.toMatch(/defaultPreset="30d"/);
  });
});

// ---------------------------------------------------------------------------
// F13 — RUPGA revoke left /admin/directorio painting a stale "Vigente" pill
// ---------------------------------------------------------------------------

describe("RA-2 F13 — service-dog revoke revalidates both directorio routes", () => {
  const revalidatePathMock = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    revalidatePathMock.mockClear();
  });

  it("revalidates /admin/directorio as well as /gob/directorio", async () => {
    vi.doMock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
    vi.doMock("@/lib/infra/auth-guards", () => ({
      requireUserOrRedirect: vi.fn().mockResolvedValue({ user: { id: "admin-1" } }),
    }));
    vi.doMock("@/src/modules/pets/application/service-dog/revoke-service-dog-credential", () => ({
      revokeServiceDogCredential: vi.fn().mockResolvedValue({ ok: true }),
    }));

    const mod = await import("@/app/actions/service-dog");
    const result = await mod.revokeServiceDogCredentialAction({
      petPublicToken: "DIM-TEST-0001",
      reason: "test",
    } as never);

    expect(result).toEqual({ ok: true });
    const revalidated = revalidatePathMock.mock.calls.map((c) => c[0]);
    // /admin/directorio is a re-export of /gob/directorio's page, but
    // revalidatePath is keyed on the ROUTE PATH, not the module — so revoking
    // from the admin route showed a cached "Vigente" pill directly above the
    // "Credencial revocada" the operator had just produced.
    expect(revalidated).toContain("/gob/directorio");
    expect(revalidated).toContain("/admin/directorio");
  });

  it("matches the house pattern — no shim revalidates only one of the pair", () => {
    // Every other revocation shim already did both; service-dog was the lone
    // outlier. Pin that so the next one cannot drift back.
    for (const rel of [
      "app/actions/service-dog.ts",
      "app/actions/service-offerings.ts",
      "app/actions/admin-revocations.ts",
      "app/actions/admin-org-verification.ts",
      "src/modules/organizations/application/bulk-actions/bulk-revoke.ts",
    ]) {
      const src = source(rel);
      const gob = src.includes('revalidatePath("/gob/directorio")');
      const admin = src.includes('revalidatePath("/admin/directorio")');
      // Asserting gob === admin is satisfied by BOTH being absent, so a shim
      // that stopped revalidating either one passed this test — the exact
      // regression it was written to catch. Require both, and name which side
      // is missing so the failure says what to do.
      expect(gob, `${rel} revalidates /gob/directorio`).toBe(true);
      expect(admin, `${rel} revalidates /admin/directorio`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// F12 — "Recargar lista" did not reload the destructive revoke queue
// ---------------------------------------------------------------------------

describe("RA-2 F12 — bulk revoke revalidates the pages that host the control", () => {
  it("every route rendering <BulkRevokeList> is revalidated by the bulk-revoke writer", () => {
    const writer = source("src/modules/organizations/application/bulk-actions/bulk-revoke.ts");

    // Derive the hosting routes from the filesystem, not from a literal list —
    // the defect was precisely that the writer revalidated three hub routes and
    // ZERO of the pages the checkbox queue actually lives on, so revoked
    // accounts stayed on screen as active with live "Revocar" buttons.
    const hosts = walk(join(ROOT, "app"))
      .filter((f) => /<BulkRevokeList[\s>]/.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => relative(ROOT, f).split(sep).join("/"));

    expect(hosts.length, "BulkRevokeList must be rendered somewhere").toBeGreaterThan(0);

    for (const host of hosts) {
      // "app/gob/usuarios/UsuariosScreen.tsx" → "/gob/usuarios"
      const route = `/${host.split("/").slice(1, -1).join("/")}`;
      expect(writer, `${host} hosts the queue, so ${route} must be revalidated`).toContain(
        `revalidatePath("${route}")`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// F7 — govt was shown three write controls that hard-redirect them home
// ---------------------------------------------------------------------------

describe("RA-2 F7 — /gob/suscripciones write controls are admin-only", () => {
  const page = source("app/gob/suscripciones/page.tsx");
  const actions = source("app/actions/alert-subscriptions.ts");

  it("all three actions still require admin (the guard we aligned the UI to)", () => {
    const guards = actions.match(/requireAdminOrRedirect\(\)/g) ?? [];
    expect(guards.length).toBe(3);
    // And the guard really does hard-redirect with no error surface, which is
    // why leaving the controls visible could never be an option.
    const authGuards = source("lib/infra/auth-guards.ts");
    expect(authGuards).toContain('roleRejectRedirect: "/"');
  });

  it("the page admits govt for READ", () => {
    expect(page).toMatch(/profile\.role === "govt"/);
  });

  it("gates every write control on canManage === admin", () => {
    expect(page).toMatch(/const canManage = profile\.role === "admin"/);
    // The create form, the pause/activate form and the delete button must each
    // sit behind the gate — a govt operator must not be able to click any of
    // them and land on the home page with their input gone.
    for (const control of [
      "<AlertSubscriptionForm />",
      // The JSX use site, not the import at the top of the file.
      "action={toggleAlertSubscriptionAction}",
      "<DeleteAlertSubscriptionButton",
    ]) {
      const idx = page.indexOf(control);
      expect(idx, `${control} must be rendered`).toBeGreaterThan(-1);
      const preceding = page.slice(0, idx);
      const lastGate = preceding.lastIndexOf("canManage");
      expect(lastGate, `${control} must be inside a canManage guard`).toBeGreaterThan(-1);
      // No closing of the guarded region between the gate and the control.
      expect(preceding.slice(lastGate)).not.toContain("</OpCard>");
    }
  });

  it("does not tell a govt operator to create one 'abajo' when there is no form", () => {
    expect(page).toMatch(/Las alertas las administra un admin/);
  });
});

// ---------------------------------------------------------------------------
// F8 — ?sheet=marcar-perdida dead-ended on an already-lost pet, mid-crisis
// ---------------------------------------------------------------------------

describe("RA-2 F8 — marcar-perdida no longer returns null", () => {
  const sheet = source("app/(app)/mis-mascotas/[publicToken]/SheetMounter.tsx");

  it("renders a notice instead of a silent no-op when the flow does not apply", () => {
    expect(sheet).not.toMatch(/if \(!markLostData\) return null/);
    expect(sheet).toContain("MarkLostNotApplicableNotice");
  });

  it("gives the same treatment the sibling marcar-encontrada already had", () => {
    // Both sheets must answer an inapplicable state with a Sheet + a notice,
    // not with `return null`. That symmetry is the finding.
    for (const notice of ["PetNotLostNotice", "MarkLostNotApplicableNotice"]) {
      expect(sheet).toMatch(new RegExp(`function ${notice}\\(`));
      expect(sheet).toMatch(new RegExp(`<${notice}`));
    }
  });

  it("the entry point that reaches it is still unconditional (so the notice is load-bearing)", () => {
    const handoff = source("app/(app)/mis-mascotas/[publicToken]/anotar/handoff.ts");
    expect(handoff).toContain('routeOverride: "?sheet=marcar-perdida"');
  });
});

// ---------------------------------------------------------------------------
// F9 — a granted org.transfer.propose was inert: the page gated on ROLE
// ---------------------------------------------------------------------------
//
// /org/[orgToken]/transferencias/nueva used to select organizationMemberships
// .role and compare it against `new Set(["admin","coordinator"])`, while
// proposeCrossOrgTransferAction gates on requireCapabilityForOrgToken(
// "org.transfer.propose"). The two disagree for exactly the actor the grant
// table exists for: a `member` (or volunteer/foster) with an APPROVED
// org.transfer.propose row. nav-presets.ts already shows Transferencias to
// anyone holding that capability, so such a member could see the section,
// click "Nueva propuesta", and be told "Solo roles admin o coordinator" — a
// sentence the server does not enforce and that the admin who just granted the
// permission has no way to reconcile.
//
// Source-derived on purpose: the defect is "this page authorizes with the
// wrong PREDICATE", which is a property of the code, not of a rendered string.

describe("RA-2 F9 — the propose-transfer page gates on the capability, not on role", () => {
  const REL = "app/org/[orgToken]/transferencias/nueva/page.tsx";
  const page = source(REL);
  const action = source("src/modules/transfers/actions.ts");

  it("calls requireCapability with the SAME capability the action enforces", () => {
    const CAP = "org.transfer.propose";
    // Pin both ends, so renaming the capability in one place fails here rather
    // than silently re-opening the gap.
    expect(action).toContain(`requireCapabilityForOrgToken("${CAP}"`);
    expect(page).toContain(`requireCapability("${CAP}"`);
  });

  it("pins the capability check to the org in the URL, not the session default", () => {
    // Bare requireCapability(cap) falls back to the most-recently-joined
    // membership. This page resolves the org from orgToken first and passes
    // organization.id — the confused-deputy-safe shape.
    expect(page).toContain("requireOrgAccessByToken(orgToken)");
    // …and declares itself a READ: the form renders for a deactivated org,
    // the write lives in the action (default access, refused there).
    expect(page).toMatch(
      /requireCapability\(\s*"org\.transfer\.propose",\s*organization\.id,\s*\{\s*access:\s*"read",?\s*\}\s*\)/,
    );
  });

  it("no longer reads a membership role anywhere", () => {
    // The structural assertion. Unlike a copy check this cannot go tautological
    // when someone rewords the error screen: the only way to satisfy it is to
    // stop authorizing by role.
    expect(page).not.toContain("organizationMemberships");
    expect(page).not.toMatch(/ALLOWED_[A-Z_]*ROLES/);
    expect(page).not.toMatch(/membership\.role/);
  });

  it("the denial copy names the missing permission and who grants it", () => {
    // Positive assertions, deliberately. The old string
    // ("Solo roles admin o coordinator") is asserted absent BELOW, but only in
    // company of these — a lone `not.toContain` on a literal decays into a
    // tautology the moment the literal is reworded.
    expect(page).toContain("Proponer transferencias entre orgs");
    // Names the org, so a member in several orgs knows WHICH admin to ask.
    expect(page).toMatch(/Tu membresía en \$\{organization\.displayName\}/);
    // Says who can fix it and that no role change is involved — the two facts
    // the old sentence got wrong.
    expect(page).toMatch(/Un admin de la organización puede otorgártela/);
    expect(page).toMatch(/no hace falta cambiarte el rol/);
    // …and a route to go do it.
    expect(page).toContain("/admin/permisos");
    expect(page).not.toContain("Solo roles admin o coordinator");
  });

  it("the capability it names is the one the permissions console can actually grant", () => {
    // "Pedíselo a un admin" is only actionable if the admin sees that row.
    const console_ = source("app/org/[orgToken]/admin/permisos/page.tsx");
    expect(console_).toContain('"org.transfer.propose"');
    // And the label the page quotes must be the catalog's, or the member and
    // the admin are looking for different words on different screens.
    const grant = source("src/modules/organizations/application/grant-capability.ts");
    expect(grant).toContain('"org.transfer.propose": "Proponer transferencias entre orgs"');
  });
});
