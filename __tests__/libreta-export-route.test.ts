// Tests for GET /api/mis-mascotas/[publicToken]/libreta-export (Item 14.3 +
// QA finding fix, engram #635).
//
// The route renders a print-styled HTML view (window.print() auto-fires on
// load) — there is no server-side PDF generation. It previously returned
// Content-Disposition: inline; filename="....pdf" while serving
// text/html, misrepresenting the response as a real PDF download. This test
// locks in the honest contract: Content-Type stays text/html and no
// Content-Disposition header is sent (nothing here claims a .pdf filename).
//
// Auth/ownership guards (401/404) are covered indirectly via the same
// requirePetAccess-style pattern used elsewhere (see get-libreta-face-data
// test); this file focuses on the header-honesty regression plus a smoke
// check that the handler still renders successfully for the owner.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { type Pet, db, ownerships, petEvents, pets, profiles } from "@/db";
import * as supabaseServer from "@/lib/supabase/server";
import { withMutationOverride } from "./_helpers/db-overrides";

const PET_TOKEN = "DIM-LIBEXP-01";
const mockCreateClient = vi.mocked(supabaseServer.createClient);

let ownerUserId: string;
let fixturePet: Pet;

function buildRequest() {
  return new Request(`http://test.local/api/mis-mascotas/${PET_TOKEN}/libreta-export`);
}

function mockAuthAs(userId: string | null) {
  mockCreateClient.mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: userId ? { id: userId } : null } }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

beforeAll(async () => {
  const [ownerProfile] = (await db.execute(sql`
    select p.id::text as id
    from public.profiles p
    join auth.users u on u.id = p.id
    where u.email = 'owner@dim.test'
    limit 1
  `)) as unknown as Array<{ id: string }>;
  if (!ownerProfile?.id) {
    throw new Error(
      "libreta-export-route test: owner@dim.test profile not found. Run `pnpm seed:test` first.",
    );
  }
  ownerUserId = ownerProfile.id;

  // Self-heal. The erased-owner case below marks this SHARED seeded owner
  // deleted_at and restores it in a finally — but the repo has an open
  // vitest worker-crash defect (CLAUDE.md), and a worker dying mid-test skips
  // the finally. Left as is, owner@dim.test stays erased for every later db
  // test and e2e spec that logs in as it (94 files), with no error naming
  // the cause. Clearing it here turns "poisoned until someone reseeds" into
  // "poisoned until this file runs again".
  await db.execute(
    sql`update public.profiles set deleted_at = null where id = ${ownerUserId}::uuid`,
  );

  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM ownerships WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id IN (
      SELECT id FROM pets WHERE public_token = ${PET_TOKEN}
    )`);
    await tx.execute(sql`DELETE FROM pets WHERE public_token = ${PET_TOKEN}`);
  });

  const [pet] = await db
    .insert(pets)
    .values({
      publicToken: PET_TOKEN,
      name: "Libreta Export Fixture",
      species: "dog",
      sex: "female",
      potentiallyDangerousBreed: false,
    })
    .returning();
  fixturePet = pet;

  await db.insert(ownerships).values({
    petId: fixturePet.id,
    ownerUserId,
    role: "owner",
    startedAt: new Date(),
  });
});

afterAll(async () => {
  await withMutationOverride(async (tx) => {
    await tx.execute(sql`DELETE FROM pet_events WHERE pet_id = ${fixturePet.id}::uuid`);
    await tx.execute(sql`DELETE FROM ownerships WHERE pet_id = ${fixturePet.id}::uuid`);
    await tx.execute(sql`DELETE FROM pets WHERE id = ${fixturePet.id}::uuid`);
  });
});

describe("GET /api/mis-mascotas/[publicToken]/libreta-export", () => {
  it("returns 401 without an authenticated user", async () => {
    mockAuthAs(null);
    const { GET } = await import("@/app/api/mis-mascotas/[publicToken]/libreta-export/route");
    const res = await GET(buildRequest() as never, {
      params: Promise.resolve({ publicToken: PET_TOKEN }),
    });
    expect(res.status).toBe(401);
  });

  it("renders text/html with no Content-Disposition header (no fabricated .pdf filename)", async () => {
    mockAuthAs(ownerUserId);
    const { GET } = await import("@/app/api/mis-mascotas/[publicToken]/libreta-export/route");
    const res = await GET(buildRequest() as never, {
      params: Promise.resolve({ publicToken: PET_TOKEN }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    // The route has no server-side PDF generation — it must not claim a
    // ".pdf" filename (or any Content-Disposition) for an HTML response.
    expect(res.headers.get("content-disposition")).toBeNull();

    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    // Print-to-PDF affordance: the browser's native print dialog produces
    // the actual PDF, not the server.
    expect(html).toContain("window.print()");
  });

  it("prints the pet weight from a weight_recorded event (regression — state-honesty 2nd layer)", async () => {
    // weight_recorded events store weight under payload.kg (a string —
    // lib/events/event-schemas.ts), never payload.weight_kg. extractEventSummary
    // used to check the nonexistent `weight_kg` field and silently dropped the
    // weight from every export.
    await db.insert(petEvents).values({
      petId: fixturePet.id,
      eventType: "weight_recorded",
      occurredAt: new Date(),
      recordedAt: new Date(),
      recordedByUserId: ownerUserId,
      authorRole: "owner",
      payload: { payload_version: 1, kg: "12.50" },
    });

    mockAuthAs(ownerUserId);
    const { GET } = await import("@/app/api/mis-mascotas/[publicToken]/libreta-export/route");
    const res = await GET(buildRequest() as never, {
      params: Promise.resolve({ publicToken: PET_TOKEN }),
    });

    const html = await res.text();
    // es-AR comma: the libreta sanitaria is a citizen-facing document. This
    // assertion used to demand "12.50 kg" — the stored toFixed(2) string
    // printed raw — so the suite defended the locale bug it should have caught.
    expect(html).toContain("12,5 kg");
    expect(html).not.toContain("12.50 kg");
  });

  it("prints the AMENDED weight, not the pre-correction value (H7 regression)", async () => {
    // Event sourcing: a correction is a new event_amended row layered on top of
    // the original via overlayAmendments — the original weight_recorded row is
    // never touched. The official libreta PDF must reflect the corrected
    // ("current") value, mirroring the on-screen libreta (get-libreta-face-data.ts),
    // not the stale as-typed one.
    const [original] = await db
      .insert(petEvents)
      .values({
        petId: fixturePet.id,
        eventType: "weight_recorded",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        recordedAt: new Date("2026-06-01T10:00:00Z"),
        recordedByUserId: ownerUserId,
        authorRole: "owner",
        payload: { payload_version: 1, kg: "9.00" },
      })
      .returning();

    await db.insert(petEvents).values({
      petId: fixturePet.id,
      eventType: "event_amended",
      occurredAt: new Date("2026-06-02T10:00:00Z"),
      recordedAt: new Date("2026-06-02T10:00:00Z"),
      recordedByUserId: ownerUserId,
      authorRole: "owner",
      payload: {
        target_event_id: original.id,
        changes: [{ field: "kg", old: "9.00", new: "22.75" }],
        reason: "Error de tipeo al cargar el peso",
      },
    });

    mockAuthAs(ownerUserId);
    const { GET } = await import("@/app/api/mis-mascotas/[publicToken]/libreta-export/route");
    const res = await GET(buildRequest() as never, {
      params: Promise.resolve({ publicToken: PET_TOKEN }),
    });

    const html = await res.text();
    expect(html).toContain("22,75 kg"); // es-AR comma; a real 2nd decimal survives
    expect(html).not.toContain("22.75 kg");
    expect(html).not.toContain("9,00 kg");
    expect(html).not.toContain("9 kg");
  });

  // ARCO erasure (Ley 25.326 art. 16). PENDIENTES L-3, the live instance the
  // route-handler coverage rule was widened to catch.
  //
  // A bare `supabase.auth.getUser()` answers WHO the caller is and never
  // WHETHER THEY MAY STILL ACT: after `erase_subject_data` soft-deletes the
  // profile, the already-issued JWT stays valid until it expires, the
  // ownerships row is still `role='owner'` with `ended_at is null`, and the
  // handler used to hand back the COMPLETE libreta sanitaria — every clinical
  // event of a subject who had just exercised supresión. The fix routes the
  // handler through requireLiveUser(), the non-redirecting liveness guard.
  //
  // `deletedAt` is set on the shared seeded owner and restored in `finally`:
  // the "db" vitest project runs with fileParallelism:false, so no other file
  // observes the window, and the restore keeps the seed usable for the rest of
  // the suite even if the assertions fail.
  it("refuses an ERASED owner holding a live session (401, and no libreta in the body)", async () => {
    await db.update(profiles).set({ deletedAt: new Date() }).where(eq(profiles.id, ownerUserId));
    try {
      mockAuthAs(ownerUserId);
      const { GET } = await import("@/app/api/mis-mascotas/[publicToken]/libreta-export/route");
      const res = await GET(buildRequest() as never, {
        params: Promise.resolve({ publicToken: PET_TOKEN }),
      });

      expect(res.status).toBe(401);
      const body = await res.text();
      expect(body).not.toContain("<html");
      expect(body).not.toContain("Libreta Sanitaria Digital");
    } finally {
      await db.update(profiles).set({ deletedAt: null }).where(eq(profiles.id, ownerUserId));
    }
  });
});
