// The boundary, proven against the database (legal review 2026-08-17).
//
// The fitness test next door proves the TypeScript partition is total and that
// the two governance select shapes are disjoint. That is a statement about
// source code. This file is the one that matters legally: it puts a real
// denuncia in a real table — reporter contact, reporter account, a relato that
// self-identifies the way real ones do, the descripción del denunciado, a
// street address, coordinates and an evidence attachment — and then reads each
// side WITHOUT the other and asserts that neither read can reconstruct it.
//
// Why this is the deliverable's evidence and not a formality: Ley 25.326
// art. 17 inc. 1 lets the organism reserve a third party's data, and unlike
// inc. 2 it does not require ongoing proceedings — which makes it the right
// instrument for protecting a denunciante from retaliation. It is exercisable
// only over something separable. "Separable" is not an opinion about the
// schema; it is the claim that these two reads exist and do not leak into each
// other. So it gets asserted against the database, including against the two
// views migration 0186 creates, whose column sets are cross-checked against the
// TypeScript classification so neither side can drift alone.
//
// WHAT THIS TEST DOES NOT CLAIM. It does not claim the relato is anonymous.
// The fixture below deliberately self-identifies ("soy la vecina del 2º B"),
// and that string stays verbatim in the content side, because free text is not
// anonymisable and no assertion here pretends otherwise. What the test proves
// is the weaker, true, and sufficient claim: the relato can be WITHHELD and
// DESTROYED as one unit without destroying the reporter-side record, and the
// reporter-side record can be read and aged out without touching it.

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, profiles, welfareReportAttachments, welfareReports } from "@/db";
import {
  CASE_RECORD_COLUMNS,
  DENUNCIA_CONTENT_COLUMNS,
  REPORTER_IDENTITY_COLUMNS,
} from "@/lib/domain/denuncia-data-partition";
import {
  CONTENT_VIEW_EXPECTED_COLUMNS,
  DENUNCIA_CONTENT_SELECT,
  DENUNCIA_CONTENT_VIEW,
  DENUNCIA_REPORTER_IDENTITY_SELECT,
  DENUNCIA_REPORTER_IDENTITY_VIEW,
  REPORTER_IDENTITY_VIEW_EXPECTED_COLUMNS,
} from "@/lib/infra/welfare-report-partition";

// Hostile fixture: every value below is a distinct, greppable needle, so an
// assertion can search a whole serialized row instead of naming fields one by
// one (the same technique the reporter-view test uses against `...report`).
const REPORTER_EMAIL = "denunciante-sep@dim-test.local";
const REPORTER_PHONE = "+5491155550001";
const RELATO =
  "Soy la vecina del 2º B y desde hace tres semanas escucho al perro llorar toda la noche.";
const SUBJECT_DESCRIPTION = "Hombre canoso del 3º A, tiene un ovejero alemán atado al balcón.";
const LOCATION_ADDRESS = "Av. Siempreviva 742, piso 3, CABA";
const EVIDENCE_PATH = "welfare-evidence/sep-boundary/patio-con-patente.jpg";
const RESOLUTION_NOTES = "Se constató el hecho en el domicilio del denunciado.";

const REFERENCE_CODE = `DEN-SEPB-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

let reportId: string;
let reporterUserId: string | null = null;

beforeAll(async () => {
  // A registered reporter, so the identity side has a user FK that would leak
  // if the boundary were wrong. An EXISTING profile is borrowed rather than
  // created: profiles.id carries an auth.users FK at the database level, so
  // minting one here would need an auth user and a teardown that can orphan
  // real rows. On a database with no profiles the FK is left null and the
  // user-id assertion below degrades to a no-op — the contact-channel
  // assertions, which are the ones that matter, still bite.
  const [existing] = await db.select({ id: profiles.id }).from(profiles).limit(1);
  reporterUserId = existing?.id ?? null;

  const [report] = await db
    .insert(welfareReports)
    .values({
      referenceCode: REFERENCE_CODE,
      reporterUserId,
      reporterContactEmail: REPORTER_EMAIL,
      reporterContactPhone: REPORTER_PHONE,
      kind: "neglect",
      severity: "high",
      description: RELATO,
      subjectKind: "unowned_animal",
      subjectDescription: SUBJECT_DESCRIPTION,
      locationAddress: LOCATION_ADDRESS,
      jurisdictionProvince: "CABA",
      jurisdictionLocality: "Comuna 1",
      locationLat: "-34.6037000",
      locationLng: "-58.3816000",
      resolutionNotes: RESOLUTION_NOTES,
    })
    .returning({ id: welfareReports.id });
  reportId = report.id;

  await db.insert(welfareReportAttachments).values({
    welfareReportId: reportId,
    storagePath: EVIDENCE_PATH,
    mimeType: "image/jpeg",
    fileSize: 12345,
    originalFilename: "patio-con-patente.jpg",
  });
});

afterAll(async () => {
  if (reportId) {
    // Attachments cascade on the FK, but delete explicitly so a future change
    // to the cascade cannot leave test rows behind.
    await db
      .delete(welfareReportAttachments)
      .where(eq(welfareReportAttachments.welfareReportId, reportId));
    await db.delete(welfareReports).where(eq(welfareReports.id, reportId));
  }
  // The reporter profile is NOT deleted, and that is the fix, not an omission.
  //
  // beforeAll BORROWS an arbitrary existing profile (`limit(1)`, unordered) and
  // this block used to delete it. A test must not destroy a row it did not
  // create, and here it did so silently: on this database the borrowed row is
  // usually a seeded demo person. Which one depends on the unordered limit, so
  // the damage was invisible until the day it picked somebody the database
  // refused to delete — a party to a seeded open custody dispute — and the
  // suite went red for a reason that had nothing to do with denuncia
  // separation.
  //
  // The comment in beforeAll already argues, correctly, that minting a profile
  // here is not worth it (profiles.id carries an auth.users FK). Borrowing is
  // fine. Borrowing and then deleting is not.
});

/** Everything a row would reveal, flattened, so nothing hides in a nested value. */
function serialize(row: unknown): string {
  return JSON.stringify(row, (_k, v) => (v instanceof Date ? v.toISOString() : v));
}

// ---------------------------------------------------------------------------
// 1. The two sides read independently
// ---------------------------------------------------------------------------

describe("denuncia separation — independent reads", () => {
  it("the content read carries no reporter identity", async () => {
    const [row] = await db
      .select(DENUNCIA_CONTENT_SELECT)
      .from(welfareReports)
      .where(eq(welfareReports.id, reportId));

    // Non-vacuity first: a read that returned nothing would pass every
    // negative assertion below.
    expect(row.description).toBe(RELATO);
    expect(row.subjectDescription).toBe(SUBJECT_DESCRIPTION);

    const dump = serialize(row);
    for (const needle of [REPORTER_EMAIL, REPORTER_PHONE]) {
      expect(dump, `Reporter identity "${needle}" leaked into the content read.`).not.toContain(
        needle,
      );
    }
    if (reporterUserId) {
      expect(dump).not.toContain(reporterUserId);
    }
    for (const { property } of REPORTER_IDENTITY_COLUMNS) {
      expect(Object.keys(row)).not.toContain(property);
    }
  });

  it("the reporter-identity read carries no content and no path to the evidence", async () => {
    const [row] = await db
      .select(DENUNCIA_REPORTER_IDENTITY_SELECT)
      .from(welfareReports)
      .where(eq(welfareReports.id, reportId));

    expect(row.reporterContactEmail).toBe(REPORTER_EMAIL);
    expect(row.reporterContactPhone).toBe(REPORTER_PHONE);
    // The clock this side will be aged out on must be readable from here.
    expect(row.createdAt).toBeInstanceOf(Date);

    const dump = serialize(row);
    for (const needle of [RELATO, SUBJECT_DESCRIPTION, LOCATION_ADDRESS, RESOLUTION_NOTES]) {
      expect(
        dump,
        `Denuncia content leaked into the reporter-identity read: "${needle}"`,
      ).not.toContain(needle);
    }
    for (const { property } of DENUNCIA_CONTENT_COLUMNS) {
      expect(Object.keys(row)).not.toContain(property);
    }
  });

  it("neither read reaches the evidence rows", async () => {
    // Attachments are a separate table with its own lifecycle; neither
    // governance shape joins it. Asserted rather than assumed, because the
    // attachment is the object whose purge needs a storage delete too.
    const contentKeys = Object.keys(DENUNCIA_CONTENT_SELECT);
    const identityKeys = Object.keys(DENUNCIA_REPORTER_IDENTITY_SELECT);
    for (const keys of [contentKeys, identityKeys]) {
      expect(keys).not.toContain("storagePath");
      expect(keys).not.toContain("attachments");
    }

    const evidence = await db
      .select({ path: welfareReportAttachments.storagePath })
      .from(welfareReportAttachments)
      .where(eq(welfareReportAttachments.welfareReportId, reportId));
    expect(evidence.map((e) => e.path)).toEqual([EVIDENCE_PATH]);
  });
});

// ---------------------------------------------------------------------------
// 2. The database objects agree with the TypeScript classification
// ---------------------------------------------------------------------------

async function viewColumns(view: string): Promise<string[]> {
  const rows = await db.execute<{ column_name: string }>(sql`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ${view}
  `);
  return [...rows].map((r) => r.column_name).sort();
}

describe("denuncia separation — database views (migration 0186)", () => {
  it("welfare_report_content exposes exactly case_record ∪ denuncia_content", async () => {
    const actual = await viewColumns(DENUNCIA_CONTENT_VIEW);
    expect(
      actual.length,
      `View ${DENUNCIA_CONTENT_VIEW} not found — apply migration 0186 to the local database.`,
    ).toBeGreaterThan(0);
    expect(actual).toEqual([...CONTENT_VIEW_EXPECTED_COLUMNS].sort());
  });

  it("welfare_report_reporter_identity exposes exactly the key plus reporter identity", async () => {
    const actual = await viewColumns(DENUNCIA_REPORTER_IDENTITY_VIEW);
    expect(
      actual.length,
      `View ${DENUNCIA_REPORTER_IDENTITY_VIEW} not found — apply migration 0186 to the local database.`,
    ).toBeGreaterThan(0);
    expect(actual).toEqual([...REPORTER_IDENTITY_VIEW_EXPECTED_COLUMNS].sort());
  });

  it("the two views share only the join/clock key", async () => {
    const content = new Set(await viewColumns(DENUNCIA_CONTENT_VIEW));
    const identity = await viewColumns(DENUNCIA_REPORTER_IDENTITY_VIEW);
    const overlap = identity.filter((c) => content.has(c)).sort();
    expect(overlap).toEqual(["created_at", "id", "reference_code"]);
  });

  it("reading through the views reproduces the same separation", async () => {
    const contentRows = await db.execute<Record<string, unknown>>(sql`
      SELECT * FROM public.welfare_report_content WHERE id = ${reportId}
    `);
    const identityRows = await db.execute<Record<string, unknown>>(sql`
      SELECT * FROM public.welfare_report_reporter_identity WHERE id = ${reportId}
    `);

    const contentDump = serialize([...contentRows][0]);
    const identityDump = serialize([...identityRows][0]);

    expect(contentDump).toContain(SUBJECT_DESCRIPTION);
    expect(contentDump).not.toContain(REPORTER_EMAIL);
    expect(contentDump).not.toContain(REPORTER_PHONE);

    expect(identityDump).toContain(REPORTER_EMAIL);
    expect(identityDump).not.toContain(RELATO);
    expect(identityDump).not.toContain(SUBJECT_DESCRIPTION);
    expect(identityDump).not.toContain(LOCATION_ADDRESS);
  });

  it("the reporter-identity view is not granted to anon or authenticated", async () => {
    // The asymmetric grant is the point: no API-key-facing role may select the
    // reporter side as a set. A future GRANT would make the reserve
    // unenforceable at the only layer that does not depend on query discipline.
    const rows = await db.execute<{ grantee: string; privilege_type: string }>(sql`
      SELECT grantee, privilege_type
        FROM information_schema.role_table_grants
       WHERE table_schema = 'public'
         AND table_name = ${DENUNCIA_REPORTER_IDENTITY_VIEW}
         AND grantee IN ('anon', 'authenticated', 'PUBLIC')
    `);
    expect([...rows]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. What remains entangled — asserted so it cannot be forgotten
// ---------------------------------------------------------------------------

describe("denuncia separation — the honest limit", () => {
  it("the relato still identifies its author, and the content side still carries it", async () => {
    // This is not a bug being tolerated. It is the design boundary written
    // down: `description` is reporter-identifying AND content, no heuristic
    // separates them, and the disposition chosen is destruction, not
    // redaction. If a future change starts "sanitising" free text, this test
    // is where the claim it would be making becomes visible.
    const [row] = await db
      .select({ description: welfareReports.description })
      .from(welfareReports)
      .where(eq(welfareReports.id, reportId));

    expect(row.description).toContain("Soy la vecina");
    expect(
      CASE_RECORD_COLUMNS.map((c) => c.property),
      "`description` must stay in the purge unit — it is the only disposition available to it.",
    ).not.toContain("description");
  });
});
