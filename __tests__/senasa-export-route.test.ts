// GET /gob/senasa/export — the route that finally gives the SENASA / LSUCyF
// batch export a caller.
//
// WHAT IS PINNED HERE, AND WHY EACH ONE
// ---------------------------------------------------------------------------
// The pipeline's pure core (__tests__/senasa-export.test.ts) and its keyset
// paging (__tests__/senasa-export-stream.test.ts) were already covered. What
// was NOT covered — because nothing called it — is everything the route adds:
//
//   1. AUTHORIZATION. Including the case an aggregate dashboard can afford to
//      be sloppy about and a RAW-ROW export cannot: a govt operator with ZERO
//      jurisdiction assignments. An empty mandate is not a universal one.
//   2. JURISDICTION SCOPING ACTUALLY NARROWS. Not "the clause is built" — that
//      a second province's rows are ABSENT from the bytes the operator
//      receives. Two fixtures in two provinces exist for exactly this.
//   3. THE PERIOD BOUND. On `occurred_at`, the clinical date (R1.3).
//   4. STREAMING DOES NOT MATERIALIZE. Asserted by counting how many rows have
//      been PULLED from the source when the first row chunk comes out. A test
//      that only checked the final bytes would pass just as happily against a
//      route that buffered the whole batch, which is the exact failure
//      `streamSenasaBatch`'s docblock exists to prevent.
//   5. THE AUDIT ROW. `senasa_export_generated`, not the aggregate action.
//
// Runs against the local Postgres, provisions its own fixtures and cleans up.

import { desc, eq, inArray } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { auditLog, db, petEvents, pets, profiles } from "@/db";
import {
  type SenasaEventRow,
  csvSenasaFormatter,
  senasaDocumentChunks,
  toSenasaCanonicalRows,
} from "@/lib/analytics/senasa-export";
import { withMutationOverride } from "./_helpers/db-overrides";

// ---------------------------------------------------------------------------
// Auth guard — the only mocked seam. Everything below it is the real thing.
// ---------------------------------------------------------------------------

const requireAdminOrGovtOrRedirect = vi.fn();
vi.mock("@/lib/infra/auth-guards", () => ({
  requireAdminOrGovtOrRedirect: () => requireAdminOrGovtOrRedirect(),
}));

// The entry-point tests (section 6) render /gob/analytics/export, whose client
// islands read the live URL. Empty search params = "the picker has not moved",
// so the link must carry the server snapshot. The route itself never touches
// next/navigation.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/gob/analytics/export",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// Fixtures — two pets in two different provinces, so "scoped" can be proven by
// ABSENCE rather than asserted by inspection.
// ---------------------------------------------------------------------------

const MINE = { province: "Santa Fe", locality: "SenasaRouteVilla" } as const;
const THEIRS = { province: "Córdoba", locality: "SenasaRouteOtra" } as const;

const TOKEN_MINE = "DIM-SENASA-ROUTE-A";
const TOKEN_THEIRS = "DIM-SENASA-ROUTE-B";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Inside both the default 12m window and an explicit ?period=7d. */
const RECENT = new Date(Date.now() - 3 * DAY_MS);
/** Inside 12m, OUTSIDE 7d — the row the period bound must drop. */
const OLDER = new Date(Date.now() - 40 * DAY_MS);

const actorId = crypto.randomUUID();
let petIdMine: string;
let petIdTheirs: string;

async function insertPet(token: string, j: { province: string; locality: string }) {
  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: token,
      name: "SenasaRouteDog",
      species: "dog",
      sex: "male",
      status: "active",
      jurisdictionProvince: j.province,
      jurisdictionLocality: j.locality,
    })
    .returning();
  return pet.id;
}

async function insertSanitaryEvent(petId: string, occurredAt: Date, lote: string) {
  await db.insert(petEvents).values({
    petId,
    eventType: "vaccination_administered",
    occurredAt,
    recordedAt: occurredAt,
    authorRole: "vet",
    recordedByUserId: null,
    payload: {
      payload_version: 1,
      vaccine_name: "Antirrábica",
      brand: null,
      batch: null,
      administered_by: null,
      next_due_at: null,
    },
    // What makes the row eligible for the SENASA export at all.
    tipoEventoCode: "VAC_ANTIRRABICA",
    loteBiologico: lote,
  });
}

beforeAll(async () => {
  await withMutationOverride(async (tx) => {
    const stale = await tx
      .select({ id: pets.id })
      .from(pets)
      .where(inArray(pets.publicToken, [TOKEN_MINE, TOKEN_THEIRS]));
    for (const s of stale) {
      await tx.delete(petEvents).where(eq(petEvents.petId, s.id));
      await tx.delete(pets).where(eq(pets.id, s.id));
    }
  });

  // audit_log.actor_user_id is a real FK; the export writes one row per call.
  await db
    .insert(profiles)
    .values({ id: actorId, displayName: "senasa-export-route test", role: "govt" });

  petIdMine = await insertPet(TOKEN_MINE, MINE);
  petIdTheirs = await insertPet(TOKEN_THEIRS, THEIRS);

  await insertSanitaryEvent(petIdMine, RECENT, "LOTE-MINE-RECENT");
  await insertSanitaryEvent(petIdMine, OLDER, "LOTE-MINE-OLDER");
  await insertSanitaryEvent(petIdTheirs, RECENT, "LOTE-THEIRS-RECENT");
});

afterAll(async () => {
  // audit_log is append-only with no override hatch, so the rows this file
  // writes stay — the random actor id is what keeps them from colliding with
  // anything (same reasoning as __tests__/govt-dashboard-export.test.ts).
  await withMutationOverride(async (tx) => {
    for (const id of [petIdMine, petIdTheirs]) {
      if (!id) continue;
      await tx.delete(petEvents).where(eq(petEvents.petId, id));
      await tx.delete(pets).where(eq(pets.id, id));
    }
  }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function asGovt(jurisdictions: { province: string; locality: string }[]) {
  requireAdminOrGovtOrRedirect.mockResolvedValue({
    profile: { id: actorId, role: "govt" },
    jurisdictions,
    user: { id: actorId },
  });
}

function asAdmin() {
  requireAdminOrGovtOrRedirect.mockResolvedValue({
    profile: { id: actorId, role: "admin" },
    jurisdictions: [],
    user: { id: actorId },
  });
}

async function callRoute(query = ""): Promise<Response> {
  const { GET } = await import("@/app/gob/senasa/export/route");
  const req = new Request(`http://test.local/gob/senasa/export${query}`);
  // The handler reads only `request.url`; NextRequest is structurally
  // compatible for that (same shape as the cron route tests).
  return GET(req as never);
}

async function bodyOf(res: Response): Promise<string> {
  return await res.text();
}

// ---------------------------------------------------------------------------
// 1 — Authorization
// ---------------------------------------------------------------------------

describe("GET /gob/senasa/export — authorization", () => {
  it("redirects to the login page when the guard rejects", async () => {
    requireAdminOrGovtOrRedirect.mockRejectedValue(new Error("no session"));

    const res = await callRoute();

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/iniciar-sesion");
  });

  it("DENIES a govt operator with zero jurisdiction assignments", async () => {
    // The case that separates a raw-row export from an aggregate one. An empty
    // mandate must read as "no authority", never as "universal authority", and
    // it must SAY denied rather than hand back an empty file that an operator
    // would read as "there is nothing in my jurisdiction".
    asGovt([]);

    const res = await callRoute();

    expect(res.status).toBe(403);
    expect(await bodyOf(res)).toContain("Acceso denegado");
  });

  it("allows a govt operator that has at least one assignment", async () => {
    asGovt([MINE]);

    const res = await callRoute();

    expect(res.status).toBe(200);
  });

  it("allows an admin (universal scope, no assignments)", async () => {
    asAdmin();

    const res = await callRoute();

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 2 — Jurisdiction scoping narrows the BYTES, not just the clause
// ---------------------------------------------------------------------------

describe("GET /gob/senasa/export — jurisdiction scoping", () => {
  it("ships only the rows inside the operator's mandate", async () => {
    asGovt([MINE]);

    const csv = await bodyOf(await callRoute());

    expect(csv).toContain(TOKEN_MINE);
    // The assertion that matters: the other province's animal is ABSENT.
    expect(csv).not.toContain(TOKEN_THEIRS);
    expect(csv).not.toContain("LOTE-THEIRS-RECENT");
  });

  it("ships the other operator's rows and not ours when the mandate is theirs", async () => {
    // The mirror case. Without it, a scoping bug that always returned the
    // FIRST fixture would pass the test above.
    asGovt([THEIRS]);

    const csv = await bodyOf(await callRoute());

    expect(csv).toContain(TOKEN_THEIRS);
    expect(csv).not.toContain(TOKEN_MINE);
  });

  it("ships both provinces for an admin (universal scope)", async () => {
    asAdmin();

    const csv = await bodyOf(await callRoute());

    expect(csv).toContain(TOKEN_MINE);
    expect(csv).toContain(TOKEN_THEIRS);
  });
});

// ---------------------------------------------------------------------------
// 3 — Period bound (R1.3: occurred_at, the clinical date)
// ---------------------------------------------------------------------------

describe("GET /gob/senasa/export — period", () => {
  it("includes both of the operator's events in the default 12m window", async () => {
    asGovt([MINE]);

    const csv = await bodyOf(await callRoute());

    expect(csv).toContain("LOTE-MINE-RECENT");
    expect(csv).toContain("LOTE-MINE-OLDER");
  });

  it("drops the event outside an explicit ?period=7d window", async () => {
    asGovt([MINE]);

    const csv = await bodyOf(await callRoute("?period=7d"));

    expect(csv).toContain("LOTE-MINE-RECENT");
    expect(csv).not.toContain("LOTE-MINE-OLDER");
  });
});

// ---------------------------------------------------------------------------
// 4 — Response shape
// ---------------------------------------------------------------------------

describe("GET /gob/senasa/export — response", () => {
  it("is an attachment with the formatter's content type and no-store", async () => {
    asGovt([MINE]);

    const res = await callRoute();

    expect(res.headers.get("content-type")).toBe(csvSenasaFormatter.contentType);
    expect(res.headers.get("content-disposition")).toContain('attachment; filename="senasa-');
    expect(res.headers.get("content-disposition")).toContain(".csv");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("opens with the BOM + the stable SENASA column header", async () => {
    asGovt([MINE]);

    // Read the RAW BYTES. `Response.text()` decodes per WHATWG fetch, which
    // strips a leading BOM — so asserting on the decoded string would silently
    // pass against a body that had lost the BOM entirely, and the BOM is the
    // whole reason Excel opens this file with the accents intact.
    const bytes = new Uint8Array(await (await callRoute()).arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);

    const csv = new TextDecoder("utf-8").decode(bytes.slice(3));
    expect(csv.split("\r\n")[0]).toBe(
      "animal_token,species,jurisdiction_province,jurisdiction_locality,occurred_on,tipo_evento_code,tipo_evento_label,tipo_evento_norma,lote_biologico,laboratorio,vencimiento_biologico,via_aplicacion_code,via_aplicacion_label,vet_matricula,vet_jurisdiccion_code,establecimiento_renspa,proxima_dosis_on",
    );
  });

  it("falls back to the CSV baseline for an unknown ?format=", async () => {
    asGovt([MINE]);

    const res = await callRoute("?format=inventado");

    expect(res.headers.get("content-type")).toBe(csvSenasaFormatter.contentType);
  });
});

// ---------------------------------------------------------------------------
// 5 — Streaming really is streaming
// ---------------------------------------------------------------------------

describe("senasaDocumentChunks — the batch is never materialized", () => {
  function row(token: string): SenasaEventRow {
    return {
      animalToken: token,
      species: "dog",
      jurisdictionProvince: "Santa Fe",
      jurisdictionLocality: "X",
      occurredAt: new Date("2026-06-15T00:00:00Z"),
      tipoEventoCode: "VAC_ANTIRRABICA",
      loteBiologico: null,
      laboratorio: null,
      vencimientoBiologico: null,
      viaAplicacionCode: null,
      vetMatricula: null,
      vetJurisdiccionCode: null,
      establecimientoRenspa: null,
      proximaDosisAt: null,
    };
  }

  it("emits the first row chunk after `chunkRows` rows, not after the last one", async () => {
    // A source of 50 rows that COUNTS how many have been pulled. If the route's
    // helper accumulated the batch, `pulled` would be 50 by the time the first
    // row chunk appeared — which is precisely the regression this asserts
    // against, and which inspecting the final bytes cannot see.
    let pulled = 0;
    async function* source() {
      for (let i = 0; i < 50; i++) {
        pulled += 1;
        yield row(`DIM-STREAM-${i}`);
      }
    }

    const chunks = senasaDocumentChunks(source(), csvSenasaFormatter, { chunkRows: 5 });

    const preamble = await chunks.next();
    expect(preamble.value).toContain("animal_token");
    // The preamble must not have consumed the source at all.
    expect(pulled).toBe(0);

    const first = await chunks.next();
    expect(first.value).toContain("DIM-STREAM-0");
    expect(first.value).toContain("DIM-STREAM-4");
    expect(first.value).not.toContain("DIM-STREAM-5");
    expect(pulled).toBe(5);

    await chunks.return(undefined);
  });

  it("stops pulling from the source when the consumer walks away", async () => {
    // The client hung up; the route calls chunks.return(). The paging loop must
    // not keep querying for a body nobody is reading.
    let pulled = 0;
    async function* source() {
      for (let i = 0; i < 1000; i++) {
        pulled += 1;
        yield row(`DIM-CANCEL-${i}`);
      }
    }

    const chunks = senasaDocumentChunks(source(), csvSenasaFormatter, { chunkRows: 5 });
    await chunks.next();
    await chunks.next();
    await chunks.return(undefined);

    const afterCancel = pulled;
    await new Promise((r) => setTimeout(r, 10));

    expect(afterCancel).toBe(5);
    expect(pulled).toBe(5);
  });

  it("produces byte-identical output to the batch formatter", async () => {
    // The contract that lets the streamed path exist at all: nothing about the
    // document changes because it was produced incrementally.
    const rows = [row("DIM-A"), row("DIM-B"), row("DIM-C")];
    async function* source() {
      for (const r of rows) yield r;
    }

    let streamed = "";
    for await (const chunk of senasaDocumentChunks(source(), csvSenasaFormatter, {
      chunkRows: 2,
    })) {
      streamed += chunk;
    }

    expect(streamed).toBe(csvSenasaFormatter.format(toSenasaCanonicalRows(rows)));
  });
});

// ---------------------------------------------------------------------------
// 6 — Audit
// ---------------------------------------------------------------------------

describe("GET /gob/senasa/export — audit", () => {
  it("writes senasa_export_generated (NOT the aggregate dashboard action)", async () => {
    asGovt([MINE]);

    await bodyOf(await callRoute("?period=7d"));

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.actorUserId, actorId))
      .orderBy(desc(auditLog.performedAt));

    expect(rows.length).toBeGreaterThan(0);
    const latest = rows[0];
    expect(latest.action).toBe("senasa_export_generated");
    // The distinction the new action exists to preserve.
    expect(rows.some((r) => r.action === "gob_dashboard_export_generated")).toBe(false);

    const payload = latest.payload as Record<string, unknown>;
    expect(payload.format).toBe("csv");
    expect(payload.scope).toMatchObject({ kind: "jurisdictions", jurisdiction_count: 1 });
    expect(payload.period).toHaveProperty("since");
    expect(payload.period).toHaveProperty("until");
  });

  it("writes NO audit row when access is denied", async () => {
    // An export that never happened must not leave a trace saying it did.
    const before = await db.select().from(auditLog).where(eq(auditLog.actorUserId, actorId));
    asGovt([]);

    await callRoute();

    const after = await db.select().from(auditLog).where(eq(auditLog.actorUserId, actorId));
    expect(after.length).toBe(before.length);
  });
});

// ---------------------------------------------------------------------------
// 6 — The entry point (pilot T1-P7). The route had no caller in app/ or
// components/; /gob/analytics/export now links to it, for exactly the people
// the route serves, with the page's period + jurisdiction.
// ---------------------------------------------------------------------------

async function renderExportPage(search: Record<string, string> = {}): Promise<string> {
  const { default: Page } = await import("@/app/gob/analytics/export/page");
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(search) }));
}

describe("/gob/analytics/export — SENASA entry point", () => {
  // Load the page module once, as setup. The first test used to pay the cold
  // import of the whole page graph inside its own 5 s budget and timed out on
  // a loaded machine (same victim twice in a row, 2026-09-23 gates). Module
  // loading is not what these tests assert.
  beforeAll(async () => {
    await import("@/app/gob/analytics/export/page");
  }, 30_000);

  it("links a govt operator with an assignment to the route, default period, CSV", async () => {
    asGovt([MINE]);
    const html = await renderExportPage();
    expect(html).toContain('href="/gob/senasa/export?period=30d&amp;format=csv"');
    expect(html).toContain("Descargar padrón SENASA (CSV)");
  });

  it("carries the chosen period and jurisdiction into the link", async () => {
    asAdmin();
    const html = await renderExportPage({
      period: "7d",
      province: "Santa Fe",
      locality: "SenasaRouteVilla",
    });
    expect(html).toContain(
      'href="/gob/senasa/export?period=7d&amp;province=Santa+Fe&amp;locality=SenasaRouteVilla&amp;format=csv"',
    );
  });

  it("shows no link to a govt operator with zero assignments (the route would deny them)", async () => {
    asGovt([]);
    const html = await renderExportPage();
    expect(html).toContain("Sin acceso");
    expect(html).not.toContain("/gob/senasa/export");
  });

  it("renders nothing for a role the guard rejects (owner, vet, national)", async () => {
    requireAdminOrGovtOrRedirect.mockRejectedValue(new Error("NEXT_REDIRECT:/acceso-denegado"));
    await expect(renderExportPage()).rejects.toThrow("NEXT_REDIRECT");
  });
});
